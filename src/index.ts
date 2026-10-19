import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { RequestPermissionRequest } from "./acp/types";
import { DevinAgent, type DevinLogger } from "./devin/agent";
import { type DevinLaunchOverrides, resolveLaunchConfig } from "./devin/launch";
import { statusMark, type TurnDetails } from "./devin/transcript";

/** Validated arguments of the `devin` tool; mirrors its parameter schema. */
interface DevinToolParams {
	prompt: string;
	reset?: boolean;
	mode?: string;
	model?: string;
	effort?: string;
}

/**
 * Live Devin ACP sessions of one omp session, keyed by working directory.
 *
 * The registry is created per extension binding, never in module scope: omp
 * re-binds the same module for subagent sessions, so a shared map would let a
 * finishing subagent's `session_shutdown` kill the parent's live Devin session
 * and make sibling sessions collide on one Devin conversation.
 */
class DevinSessionRegistry {
	#agents = new Map<string, DevinAgent>();
	#starting = new Map<string, Promise<DevinAgent>>();

	get(cwd: string): DevinAgent | undefined {
		return this.#agents.get(cwd);
	}

	async acquire(
		cwd: string,
		logger: DevinLogger,
		overrides: DevinLaunchOverrides,
		reset: boolean,
		signal?: AbortSignal,
	): Promise<DevinAgent> {
		if (reset) await this.release(cwd);

		const existing = this.#agents.get(cwd);
		if (existing && !existing.alive) await this.release(cwd);
		else if (existing) return await applyOverrides(existing, overrides);

		// Concurrent tool calls in one assistant message share the in-flight
		// start; otherwise the second `set` would orphan the first child.
		const inFlight = this.#starting.get(cwd);
		if (inFlight) return await applyOverrides(await inFlight, overrides);

		const started = DevinAgent.start(cwd, resolveLaunchConfig(overrides), logger, signal)
			.then(agent => {
				this.#agents.set(cwd, agent);
				return agent;
			})
			.finally(() => {
				this.#starting.delete(cwd);
			});
		this.#starting.set(cwd, started);
		return await started;
	}

	/** Stop the agent for one directory, waiting for an in-flight start first. */
	async release(cwd: string): Promise<void> {
		const starting = this.#starting.get(cwd);
		if (starting) await starting.catch(() => undefined);
		const agent = this.#agents.get(cwd);
		this.#agents.delete(cwd);
		await agent?.shutdown();
	}

	async disposeAll(): Promise<void> {
		const cwds = [...new Set([...this.#agents.keys(), ...this.#starting.keys()])];
		await Promise.all(cwds.map(cwd => this.release(cwd)));
	}
}

/** Per-call `mode`/`model` stay in effect for later calls on the same session. */
async function applyOverrides(agent: DevinAgent, overrides: DevinLaunchOverrides): Promise<DevinAgent> {
	if (overrides.sessionMode && overrides.sessionMode !== agent.mode) await agent.setMode(overrides.sessionMode);
	if (overrides.model) await agent.setConfigOption("model", overrides.model);
	if (overrides.thoughtLevel) await agent.setConfigOption("thought_level", overrides.thoughtLevel);
	return agent;
}

function summarize(details: TurnDetails): string {
	const parts: string[] = [];
	for (const call of details.toolCalls) {
		parts.push(`${statusMark(call.status)} ${call.tool ?? call.kind}: ${call.title}`);
	}
	return parts.join("\n");
}

/** Bridge Devin's `session/request_permission` to omp's approval UI. */
async function resolvePermission(
	ctx: ExtensionContext,
	request: RequestPermissionRequest,
	signal: AbortSignal,
): Promise<string | undefined> {
	const options = request.options ?? [];
	const byKind = (prefix: string) => options.find(option => option.kind?.startsWith(prefix));
	const allowOnce = options.find(option => option.kind === "allow_once") ?? byKind("allow");
	const allowAlways = options.find(option => option.kind === "allow_always");
	const reject = options.find(option => option.kind === "reject_once") ?? byKind("reject");
	const title = request.toolCall?.title ?? "tool call";
	const rawInput = request.toolCall?.rawInput ? JSON.stringify(request.toolCall.rawInput) : "";

	const approve = ctx.ui.approve;
	if (approve) {
		const answer = await approve(
			{
				full: `Devin wants to run: ${title}${rawInput ? `\n${rawInput}` : ""}`,
				compact: `Devin: ${title}`,
				session: allowAlways?.name,
			},
			{ signal },
		);
		if (answer === "session") return (allowAlways ?? allowOnce)?.optionId;
		if (answer === "once") return allowOnce?.optionId;
		return reject?.optionId;
	}

	const label = await ctx.ui.select(
		`Devin wants to run: ${title}`,
		options.map(option => ({ label: option.name, description: option.kind })),
		{ signal },
	);
	if (label === undefined) return undefined;
	return options.find(option => option.name === label)?.optionId;
}

export default function devinAcpExtension(pi: ExtensionAPI): void {
	const z = pi.zod;
	const logger: DevinLogger = pi.logger;
	const registry = new DevinSessionRegistry();

	pi.setLabel("Devin (ACP)");

	pi.on("session_shutdown", async () => {
		await registry.disposeAll();
	});

	// `Static<TParams>` does not flow through `registerTool`'s TypeBox generic for
	// omptype schemas, so the validated arguments are annotated to match the
	// schema declared below.
	pi.registerTool({
		name: "devin",
		label: "Devin",
		description:
			"Delegate a coding task to the Devin CLI agent over ACP. Devin runs with its own tools in the current " +
			"working directory and may read, edit, and execute. Consecutive calls continue the same Devin session, " +
			"so follow-ups can reference earlier work. Use for self-contained tasks you want a second agent to own.",
		approval: "exec",
		parameters: z.object({
			prompt: z.string().describe("Task or question for Devin, written as if briefing another engineer"),
			reset: z.boolean().optional().describe("Discard the existing Devin session and start a fresh one"),
			mode: z
				.string()
				.optional()
				.describe("ACP session mode: accept-edits (default), smart, ask (read-only), or plan"),
			model: z.string().optional().describe("Devin model id, e.g. swe-2-high or claude-sonnet-5-5-medium"),
			effort: z.string().optional().describe("Reasoning effort (Devin `thought_level`), e.g. low, medium, high"),
		}),
		async execute(_toolCallId, params: DevinToolParams, signal, onUpdate, ctx) {
			const agent = await registry.acquire(
				ctx.cwd,
				logger,
				{ sessionMode: params.mode, model: params.model, thoughtLevel: params.effort },
				params.reset === true,
				signal,
			);
			const result = await agent.prompt({
				prompt: params.prompt,
				signal,
				onActivity: (view, details) => {
					onUpdate?.({ content: [{ type: "text", text: view }], details });
				},
				resolvePermission: (request, permissionSignal) => resolvePermission(ctx, request, permissionSignal),
			});

			const activity = summarize(result.details);
			const body = result.text.trim() || "(Devin returned no text)";
			const text = result.stopReason === "end_turn" ? body : `${body}\n\n[stopReason: ${result.stopReason}]`;
			// The session id belongs in the text: the model can only report or reuse
			// what it can read, and `details` is renderer-only.
			const footer = `session ${agent.sessionId} · mode ${agent.mode ?? "?"} · model ${
				agent.configValue("model") ?? "?"
			} · effort ${agent.configValue("thought_level") ?? "?"}`;
			return {
				content: [{ type: "text", text: `${text}\n\n---\n${activity ? `${activity}\n` : ""}${footer}` }],
				details: result.details,
			};
		},
	});

	pi.registerCommand("devin", {
		description: "Devin ACP session: status, or `reset` / `mode <id>` / `model <id>` / `effort <id>`",
		handler: async (args, ctx) => {
			const [verb, value] = args.trim().split(/\s+/, 2);
			if (verb === "reset") {
				await registry.release(ctx.cwd);
				ctx.ui.notify("Devin session reset", "info");
				return;
			}
			const agent = registry.get(ctx.cwd);
			if (!agent?.alive) {
				ctx.ui.notify("No live Devin session in this directory", "info");
				return;
			}
			if (verb === "mode" && value) {
				await agent.setMode(value);
				ctx.ui.notify(`Devin mode: ${value}`, "info");
				return;
			}
			// `model` and `effort` are both session config options; Devin names the
			// effort axis `thought_level`.
			const configId = verb === "model" ? "model" : verb === "effort" ? "thought_level" : undefined;
			if (configId && value) {
				await agent.setConfigOption(configId, value);
				ctx.ui.notify(`Devin ${verb}: ${value}`, "info");
				return;
			}
			const models = agent.configValues("model");
			ctx.ui.notify(
				`${agent.agentTitle} session ${agent.sessionId} · mode ${agent.mode ?? "?"} · model ${
					agent.configValue("model") ?? "?"
				} · effort ${agent.configValue("thought_level") ?? "?"} · ${models.length} models available`,
				"info",
			);
		},
	});
}
