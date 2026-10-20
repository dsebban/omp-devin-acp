/**
 * Exposes Devin's own models in omp's `/model` picker as the provider `devin`.
 *
 * Selecting one routes the whole omp turn to a Devin ACP session: Devin plans,
 * edits, and runs commands with its own tools, and omp receives the streamed
 * answer as a normal assistant message. omp's tool schemas are not forwarded —
 * an ACP agent owns its loop — so a Devin model answers in one assistant turn
 * and never calls an omp tool.
 *
 * Model ids come from the live agent (`session/new` reports the `model` config
 * option's values) through `fetchDynamicModels`, which the host caches in its
 * SQLite model cache, so the 94-entry list costs one short-lived `devin acp`
 * probe per cache refresh instead of one per omp start.
 */
import type { ProviderConfig, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Effort,
	Model,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
// pi-ai's barrel re-exports the class name type-only (`types.d.ts` wins over
// `utils/event-stream.d.ts` under `export *`), so the factory is the only
// value-exported way to build the stream the host expects.
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import type { DevinAgent, DevinLogger } from "./agent";

export const PROVIDER_NAME = "devin";
/** Custom api id; the host requires one to dispatch `streamSimple`. */
export const API_ID: Api = "devin-acp";

/**
 * Devin bills per ACU, not per token, and reports no per-turn price, so the
 * catalog carries zeroes rather than invented rates. The context window is
 * omp's transcript budget for the session, not Devin's — Devin compacts its own
 * history — so it only needs to be large enough not to trigger omp compaction
 * on a delegated conversation.
 */
const CONTEXT_WINDOW = 200_000;
const MAX_TOKENS = 64_000;
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const NO_COST_TOTALS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } as const;
/** Devin's `thought_level` values, which happen to be omp effort names. */
const DEVIN_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as Effort[];

/** omp effort levels Devin accepts verbatim; the rest map onto its nearest level. */
const EFFORT_MAP: Record<string, string> = {
	off: "low",
	minimal: "low",
	min: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

/** Session acquisition, supplied by the extension so the tool and provider share one agent per cwd. */
export interface DevinProviderHost {
	acquire(cwd: string, signal?: AbortSignal): Promise<DevinAgent>;
	/** Starts a throwaway session used only to read the advertised catalog. */
	probe(): Promise<DevinAgent>;
	logger: DevinLogger;
	cwd(): string;
}

function toModelConfig(id: string): ProviderModelConfig {
	return {
		id,
		name: id,
		// Every Devin model takes a `thought_level`, which omp's effort control sets.
		reasoning: true,
		thinking: { mode: "effort", efforts: DEVIN_EFFORTS },
		input: ["text"],
		cost: NO_COST,
		contextWindow: CONTEXT_WINDOW,
		maxTokens: MAX_TOKENS,
	};
}

/** Newest user text in the request; Devin keeps the rest of the history itself. */
function latestUserText(context: Context): string {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message?.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string") return content;
		const text = content
			.map(block => (block.type === "text" ? block.text : ""))
			.filter(Boolean)
			.join("\n");
		if (text.trim()) return text;
	}
	return "";
}

function emptyMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: NO_COST_TOTALS },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

export function devinProviderConfig(host: DevinProviderHost): ProviderConfig {
	return {
		api: API_ID,
		// Never dialled: `streamSimple` talks to a local process over stdio. The
		// host requires both fields before it will register models.
		baseUrl: "acp://devin",
		apiKey: "devin-cli-session",
		fetchDynamicModels: async () => {
			const agent = await host.probe();
			try {
				return agent.configValues("model").map(toModelConfig);
			} finally {
				await agent.shutdown("model catalog probe complete");
			}
		},
		streamSimple: (model, context, options) => streamDevin(host, model, context, options),
	};
}

function streamDevin(
	host: DevinProviderHost,
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void run(host, model, context, options, stream).catch((error: unknown) => {
		const message = emptyMessage(model);
		message.stopReason = options?.signal?.aborted ? "aborted" : "error";
		message.errorMessage = error instanceof Error ? error.message : String(error);
		stream.push({ type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message });
		stream.fail(error);
	});
	return stream;
}

async function run(
	host: DevinProviderHost,
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	const prompt = latestUserText(context);
	if (!prompt.trim()) throw new Error("No user message to forward to Devin.");

	const agent = await host.acquire(host.cwd(), options?.signal);
	// The picked model carries its own thought level in its id suffix, so set the
	// model first and let an explicit omp effort override it.
	if (agent.configValue("model") !== model.id) await agent.setConfigOption("model", model.id);
	const effort = options?.reasoning ? EFFORT_MAP[options.reasoning] : undefined;
	if (effort && agent.configValue("thought_level") !== effort) {
		await agent.setConfigOption("thought_level", effort);
	}

	const message = emptyMessage(model);
	const text: string[] = [];
	let textIndex = -1;
	let thinkingIndex = -1;

	stream.push({ type: "start", partial: message });

	const pushThinking = (chunk: string) => {
		if (thinkingIndex < 0) {
			thinkingIndex = message.content.length;
			message.content.push({ type: "thinking", thinking: "", thinkingSignature: "" });
			stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: message });
		}
		const block = message.content[thinkingIndex];
		if (block?.type === "thinking") block.thinking += chunk;
		stream.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta: chunk, partial: message });
	};

	const pushText = (chunk: string) => {
		// A thought block must close before text starts; Devin interleaves them.
		if (thinkingIndex >= 0) {
			const block = message.content[thinkingIndex];
			stream.push({
				type: "thinking_end",
				contentIndex: thinkingIndex,
				content: block?.type === "thinking" ? block.thinking : "",
				partial: message,
			});
			thinkingIndex = -1;
		}
		if (textIndex < 0) {
			textIndex = message.content.length;
			message.content.push({ type: "text", text: "" });
			stream.push({ type: "text_start", contentIndex: textIndex, partial: message });
		}
		text.push(chunk);
		const block = message.content[textIndex];
		if (block?.type === "text") block.text += chunk;
		stream.push({ type: "text_delta", contentIndex: textIndex, delta: chunk, partial: message });
	};

	const result = await agent.prompt({
		prompt,
		signal: options?.signal,
		onChunk: (kind, chunk) => (kind === "text" ? pushText(chunk) : pushThinking(chunk)),
	});

	if (thinkingIndex >= 0) {
		const block = message.content[thinkingIndex];
		stream.push({
			type: "thinking_end",
			contentIndex: thinkingIndex,
			content: block?.type === "thinking" ? block.thinking : "",
			partial: message,
		});
	}
	// Devin reports a final answer even when it streamed nothing (short replies
	// can arrive only in the `session/prompt` result).
	if (textIndex < 0 && result.text) pushText(result.text);
	if (textIndex >= 0) {
		const block = message.content[textIndex];
		stream.push({
			type: "text_end",
			contentIndex: textIndex,
			content: block?.type === "text" ? block.text : "",
			partial: message,
		});
	}

	const usage = result.details.usage;
	if (usage) {
		message.usage = {
			input: usage.inputTokens ?? 0,
			output: usage.outputTokens ?? 0,
			cacheRead: usage.cachedInputTokens ?? 0,
			cacheWrite: 0,
			totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
			cost: NO_COST_TOTALS,
		};
	}
	const aborted = result.stopReason === "cancelled";
	message.stopReason = aborted ? "aborted" : "stop";
	host.logger.debug("devin-acp: provider turn complete", {
		model: model.id,
		stopReason: result.stopReason,
		chars: text.join("").length,
	});
	// `done` cannot carry "aborted" (its reason is narrowed to stop|length|toolUse),
	// so a cancelled turn terminates through `error` with the partial message —
	// the same shape built-in providers use, which keeps streamed text visible.
	if (aborted) {
		stream.push({ type: "error", reason: "aborted", error: message });
	} else {
		stream.push({ type: "done", reason: "stop", message });
	}
	stream.end(message);
}
