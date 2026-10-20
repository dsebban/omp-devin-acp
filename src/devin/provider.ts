/**
 * Exposes Devin's own models in omp's `/model` picker as the provider `devin`.
 *
 * Selecting one routes the whole omp turn to a Devin ACP session: Devin plans,
 * edits, and runs commands with its own tools, and omp receives the streamed
 * answer as a normal assistant message. omp's tool schemas are not forwarded —
 * an ACP agent owns its loop — so a Devin model answers in one assistant turn
 * and never calls an omp tool. Devin's own tool calls stream into the thinking
 * block as one line each, so a long turn shows what it is doing.
 *
 * The catalog (`catalog.ts`) is cached by the host's SQLite model cache, so its
 * short-lived `devin acp` probe sessions and `devin models list` run once per refresh.
 */
import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { ProviderConfig } from "@oh-my-pi/pi-coding-agent";
// pi-ai's barrel re-exports the class name type-only (`types.d.ts` wins over
// `utils/event-stream.d.ts` under `export *`), so the factory is the only
// value-exported way to build the stream the host expects.
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import type { DevinAgent, DevinChunkKind, DevinLogger } from "./agent";
import { fetchDevinCatalog, levelForEffort, resolveWireModel } from "./catalog";
import { buildTurnInput } from "./history";

export const PROVIDER_NAME = "devin";
/** Custom api id; the host requires one to dispatch `streamSimple`. */
export const API_ID: Api = "devin-acp";

const NO_COST_TOTALS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } as const;

/** Session acquisition, supplied by the extension so the tool and provider share one agent per cwd. */
export interface DevinProviderHost {
	acquire(cwd: string, signal?: AbortSignal): Promise<DevinAgent>;
	/** Starts a throwaway session used only to read the advertised catalog; called once per probe session. */
	probe(): Promise<DevinAgent>;
	/** `devin` binary, for `devin models list`. */
	binary(): string;
	logger: DevinLogger;
	cwd(): string;
}

/**
 * Timestamp of the last omp user message each live session answered. Keyed by
 * the agent object, so a new session (reset, crash, reload) starts unseen.
 */
const delivered = new WeakMap<DevinAgent, number>();

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
		fetchDynamicModels: () => fetchDevinCatalog(() => host.probe(), host.binary(), host.logger),
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

/**
 * Selects the family's ACP model, then the level omp's effort control asked for.
 *
 * omp's compat collapse folds sibling ids such as `claude-opus-4-6` and
 * `claude-opus-4-6-thinking` into one row whose `thinking.effortRouting` names
 * the id per effort (`off` = thinking disabled); that route wins over the row id.
 */
async function applyModel(agent: DevinAgent, model: Model<Api>, options: SimpleStreamOptions | undefined) {
	const routed = model.thinking?.effortRouting?.[options?.reasoning ?? "off"];
	const wireId = resolveWireModel(routed ?? model.id, agent.configValues("model"));
	if (!wireId) {
		throw new Error(`Devin no longer offers "${model.id}". Run \`omp models refresh\` and pick another Devin model.`);
	}
	if (agent.configValue("model") !== wireId) await agent.setConfigOption("model", wireId);
	const level = levelForEffort(options?.reasoning, model.thinking?.effortMap);
	if (level && agent.configValue("thought_level") !== level && agent.configValues("thought_level").includes(level)) {
		await agent.setConfigOption("thought_level", level);
	}
}

/** USD for one turn at the catalog's per-million rates; Devin's input count includes both caches. */
function turnCost(model: Model<Api>, input: number, output: number, cacheRead: number, cacheWrite: number) {
	const rate = model.cost;
	const cost = {
		input: (input * rate.input) / 1e6,
		output: (output * rate.output) / 1e6,
		cacheRead: (cacheRead * rate.cacheRead) / 1e6,
		cacheWrite: (cacheWrite * rate.cacheWrite) / 1e6,
		total: 0,
	};
	cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
	return cost;
}

async function run(
	host: DevinProviderHost,
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	const agent = await host.acquire(host.cwd(), options?.signal);
	const input = buildTurnInput(context, PROVIDER_NAME, delivered.get(agent));
	await applyModel(agent, model, options);

	const message = emptyMessage(model);
	let chars = 0;
	let open: { kind: "text" | "thinking"; index: number } | undefined;

	stream.push({ type: "start", partial: message });

	const close = () => {
		if (!open) return;
		const block = message.content[open.index];
		if (open.kind === "text") {
			stream.push({
				type: "text_end",
				contentIndex: open.index,
				content: block?.type === "text" ? block.text : "",
				partial: message,
			});
		} else {
			stream.push({
				type: "thinking_end",
				contentIndex: open.index,
				content: block?.type === "thinking" ? block.thinking : "",
				partial: message,
			});
		}
		open = undefined;
	};

	// Devin interleaves thoughts, tool calls, and answer text; each run of one
	// kind becomes its own block so the host never sees a delta for a closed one.
	const append = (kind: "text" | "thinking", chunk: string) => {
		if (open?.kind !== kind) {
			close();
			const index = message.content.length;
			if (kind === "text") {
				message.content.push({ type: "text", text: "" });
				stream.push({ type: "text_start", contentIndex: index, partial: message });
			} else {
				message.content.push({ type: "thinking", thinking: "", thinkingSignature: "" });
				stream.push({ type: "thinking_start", contentIndex: index, partial: message });
			}
			open = { kind, index };
		}
		const block = message.content[open.index];
		if (kind === "text") {
			chars += chunk.length;
			if (block?.type === "text") block.text += chunk;
			stream.push({ type: "text_delta", contentIndex: open.index, delta: chunk, partial: message });
		} else {
			if (block?.type === "thinking") block.thinking += chunk;
			stream.push({ type: "thinking_delta", contentIndex: open.index, delta: chunk, partial: message });
		}
	};

	const onChunk = (kind: DevinChunkKind, chunk: string) => {
		if (kind === "text") append("text", chunk);
		else if (kind === "thought") append("thinking", chunk);
		else append("thinking", `${open?.kind === "thinking" ? "\n" : ""}${chunk}\n`);
	};

	const startedAt = Date.now();
	const result = await agent.prompt({ prompt: input.prompt, signal: options?.signal, onChunk });
	// The session has now seen this request, whatever the outcome; a retry after
	// an abort must not replay the history a second time.
	delivered.set(agent, input.deliveredAt);

	// Devin reports a final answer even when it streamed nothing (short replies
	// can arrive only in the `session/prompt` result).
	if (chars === 0 && result.text) append("text", result.text);
	close();

	const usage = result.details.usage;
	if (usage) {
		const cacheRead = usage.cachedReadTokens ?? 0;
		const cacheWrite = usage.cachedWriteTokens ?? 0;
		const output = usage.outputTokens ?? 0;
		const uncached = Math.max(0, (usage.inputTokens ?? 0) - cacheRead - cacheWrite);
		message.usage = {
			input: uncached,
			output,
			cacheRead,
			cacheWrite,
			totalTokens: usage.totalTokens ?? uncached + cacheRead + cacheWrite + output,
			cost: turnCost(model, uncached, output, cacheRead, cacheWrite),
		};
	}
	const aborted = result.stopReason === "cancelled";
	message.stopReason = aborted ? "aborted" : "stop";
	host.logger.debug("devin-acp: provider turn complete", {
		model: model.id,
		wireModel: agent.configValue("model"),
		thoughtLevel: agent.configValue("thought_level"),
		stopReason: result.stopReason,
		replayed: input.replayed,
		promptChars: input.prompt.length,
		chars,
		toolCalls: result.details.toolCalls.length,
		ms: Date.now() - startedAt,
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
