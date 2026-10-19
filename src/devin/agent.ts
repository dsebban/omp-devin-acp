import * as fs from "node:fs/promises";
import { AcpMethodNotFound, AcpPeer, AcpRpcError } from "../acp/peer";
import {
	ACP_PROTOCOL_VERSION,
	type ClientCapabilities,
	type InitializeResponse,
	type NewSessionResponse,
	type PromptResponse,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionConfigOption,
	type SessionNotification,
} from "../acp/types";
import { type DevinLaunchConfig, prepareLaunch } from "./launch";
import { type TurnDetails, TurnTranscript } from "./transcript";

/** Structural subset of `pi.logger` so the driver stays host-independent. */
export interface DevinLogger {
	debug(message: string, data?: Record<string, unknown>): void;
	warn(message: string, data?: Record<string, unknown>): void;
	error(message: string, data?: Record<string, unknown>): void;
}

/**
 * Returns the chosen `optionId`, or undefined to answer `cancelled`. The signal
 * fires when the turn is cancelled, so a host dialog can close itself.
 */
export type DevinPermissionResolver = (
	request: RequestPermissionRequest,
	signal: AbortSignal,
) => Promise<string | undefined>;

export interface DevinPromptOptions {
	prompt: string;
	signal?: AbortSignal;
	/** Called on every streamed update with a compact live view. */
	onActivity?: (view: string, details: TurnDetails) => void;
	resolvePermission?: DevinPermissionResolver;
}

export interface DevinTurnResult {
	text: string;
	stopReason: string;
	details: TurnDetails;
}

/**
 * Devin advertises `fs`/`terminal` client capabilities as unsupported on
 * purpose: with `terminal: true` the agent routes shell work through
 * `terminal/create` and reports "the terminal failed to start" unless the
 * client implements all five terminal methods. Declaring them false makes Devin
 * use its own exec tool, which is the behavior a delegated worker wants.
 */
const CLIENT_CAPABILITIES: ClientCapabilities = {
	fs: { readTextFile: false, writeTextFile: false },
	terminal: false,
};

const INITIALIZE_TIMEOUT_MS = 30_000;
const SESSION_TIMEOUT_MS = 60_000;
const CONFIG_TIMEOUT_MS = 20_000;
/** Time a cancelled turn gets to unwind before the child is killed. */
const SHUTDOWN_GRACE_MS = 1_500;
/** Time an aborted turn gets to answer `session/cancel` before the child is killed. */
const CANCEL_GRACE_MS = 10_000;
/** Time SIGTERM gets before SIGKILL; a stopped child never answers it. */
const EXIT_GRACE_MS = 1_000;
/** Values listed in a rejected-option error; `model` advertises 94 of them. */
const OPTIONS_IN_ERROR = 12;
/** Stdout and stderr end together; wait briefly so the cause reaches the error. */
const STDERR_DRAIN_MS = 200;
const STDERR_RETAIN_LINES = 20;
const NOISE_PATTERN = /^\s*(?:\d{4}-\d{2}-\d{2}|\[?(?:INFO|DEBUG|TRACE)\b)/;

function isAuthError(error: unknown): boolean {
	if (!(error instanceof AcpRpcError)) return false;
	return error.code === -32000 || /auth/i.test(error.message);
}

export class DevinAgent {
	#proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
	#peer: AcpPeer;
	#logger: DevinLogger;
	#cwd: string;
	#sessionId = "";
	#mode: string | undefined;
	#availableModes: string[] = [];
	/** Serializes `session/prompt` turns; an ACP session handles one at a time. */
	#queue: Promise<void> = Promise.resolve();
	#configOptions: SessionConfigOption[] = [];
	#activeTurn: TurnTranscript | undefined;
	/** Resolves when the in-flight turn settles; used to unwind before killing. */
	#turnSettled: Promise<void> | undefined;
	#resolvePermission: DevinPermissionResolver | undefined;
	/** Cancels host-side permission dialogs when the turn is aborted. */
	#permissionAborter: AbortController | undefined;
	#stderrTail: string[] = [];
	#exitReason: string | undefined;
	/** Exit code or signal of the child, once it is gone; attached to errors. */
	#exitStatus: string | undefined;
	#agentTitle = "Devin";
	#disposed = false;
	/** Per-launch MCP isolation overlay to remove once the child is gone. */
	#overlayRoot: string | undefined;
	/** Binary that was spawned; named in exit diagnostics. */
	readonly #binaryLabel: string;

	private constructor(
		proc: Bun.Subprocess<"pipe", "pipe", "pipe">,
		logger: DevinLogger,
		cwd: string,
		overlayRoot: string | undefined,
		binaryLabel: string,
	) {
		this.#proc = proc;
		this.#logger = logger;
		this.#cwd = cwd;
		this.#overlayRoot = overlayRoot;
		this.#binaryLabel = binaryLabel;
		this.#peer = new AcpPeer(proc.stdin, proc.stdout as ReadableStream<Uint8Array>, {
			onNotification: (method, params) => this.#onNotification(method, params),
			onRequest: (method, params) => this.#onRequest(method, params),
			onClose: reason => {
				this.#exitReason ??= reason;
			},
		});
		// "ACP connection closed" alone cannot be diagnosed: a wrong binary, a
		// crash, and an external kill all look the same without the exit status.
		void proc.exited.then(code => {
			this.#exitStatus = proc.signalCode ? `killed by ${proc.signalCode}` : `exit code ${code}`;
		});
		void this.#readStderr();
	}

	static async start(
		cwd: string,
		config: DevinLaunchConfig,
		logger: DevinLogger,
		signal?: AbortSignal,
	): Promise<DevinAgent> {
		const { argv, env, overlayRoot } = await prepareLaunch(config);
		let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
		try {
			proc = Bun.spawn(argv, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" }) as Bun.Subprocess<
				"pipe",
				"pipe",
				"pipe"
			>;
		} catch (error) {
			// The overlay is built before the spawn, so a missing binary would
			// otherwise leave a fully populated directory behind.
			if (overlayRoot) await fs.rm(overlayRoot, { recursive: true, force: true }).catch(() => {});
			throw error;
		}
		const agent = new DevinAgent(proc, logger, cwd, overlayRoot, argv[0] ?? "devin");
		// Bootstrap requests carry minute-scale timeouts; without this an abort
		// cannot escape a child that spawns but never speaks ACP.
		const onAbort = () => void agent.shutdown("aborted during startup");
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			if (signal?.aborted) onAbort();
			await agent.#bootstrap(config);
		} catch (error) {
			await agent.shutdown();
			throw error;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
		return agent;
	}

	get sessionId(): string {
		return this.#sessionId;
	}

	get mode(): string | undefined {
		return this.#mode;
	}

	get agentTitle(): string {
		return this.#agentTitle;
	}

	get cwd(): string {
		return this.#cwd;
	}

	get alive(): boolean {
		return (
			!this.#disposed && this.#exitReason === undefined && !this.#proc.killed && this.#proc.exitCode === null
		);
	}

	/** Mode ids this session advertises, empty when the agent exposes no modes. */
	get availableModes(): string[] {
		return this.#availableModes;
	}

	/** Allowed values of a session config option, e.g. `model` or `thought_level`. */
	configValues(optionId: string): string[] {
		const option = this.#configOptions.find(candidate => candidate.id === optionId);
		if (!option?.options) return [];
		const values: string[] = [];
		for (const choice of option.options) {
			const value = choice.id ?? choice.value;
			if (typeof value === "string") values.push(value);
		}
		return values;
	}

	/** Current value of a session config option, as last reported by the agent. */
	configValue(optionId: string): string | undefined {
		const current = this.#configOptions.find(candidate => candidate.id === optionId)?.currentValue;
		return typeof current === "string" ? current : undefined;
	}

	async #bootstrap(config: DevinLaunchConfig): Promise<void> {
		let initialize: InitializeResponse;
		try {
			initialize = await this.#peer.request<InitializeResponse>(
				"initialize",
				{
					protocolVersion: ACP_PROTOCOL_VERSION,
					clientCapabilities: CLIENT_CAPABILITIES,
					clientInfo: { name: "omp" },
				},
				{ timeoutMs: INITIALIZE_TIMEOUT_MS },
			);
		} catch (error) {
			// A rejected flag or env var kills the child before it speaks ACP; the
			// reason is only on stderr.
			throw await this.#withDiagnostics(error);
		}
		this.#agentTitle = initialize.agentInfo?.title ?? initialize.agentInfo?.name ?? "Devin";
		this.#logger.debug("devin-acp: initialized", {
			protocolVersion: initialize.protocolVersion,
			agent: this.#agentTitle,
		});

		let session: NewSessionResponse;
		try {
			session = await this.#peer.request<NewSessionResponse>(
				"session/new",
				{ cwd: this.#cwd, mcpServers: [] },
				{ timeoutMs: SESSION_TIMEOUT_MS },
			);
		} catch (error) {
			throw await this.#withDiagnostics(error);
		}
		this.#sessionId = session.sessionId;
		this.#mode = session.modes?.currentModeId;
		this.#availableModes = session.modes?.availableModes.map(mode => mode.id) ?? [];
		this.#configOptions = session.configOptions ?? [];

		if (config.sessionMode && config.sessionMode !== this.#mode) await this.setMode(config.sessionMode);
		if (config.model) await this.setConfigOption("model", config.model);
		if (config.thoughtLevel) await this.setConfigOption("thought_level", config.thoughtLevel);
	}

	/**
	 * Devin accepts any `modeId` without complaint and silently stays in its
	 * current mode, so an unknown id is rejected here instead of leaving the
	 * caller believing a read-only mode took effect.
	 */
	async setMode(modeId: string): Promise<void> {
		if (this.#availableModes.length > 0 && !this.#availableModes.includes(modeId)) {
			throw new Error(`Unknown ${this.#agentTitle} mode "${modeId}". Available: ${this.#availableModes.join(", ")}`);
		}
		await this.#peer.request("session/set_mode", { sessionId: this.#sessionId, modeId }, {
			timeoutMs: CONFIG_TIMEOUT_MS,
		});
		this.#mode = modeId;
	}

	/**
	 * Devin has no `session/set_model`; `model`, `thought_level`, and `speed` are
	 * config options. The request field is `configId` — `optionId` is rejected
	 * with `-32602 missing field \`configId\``. The reply carries the refreshed
	 * `configOptions`; Devin sends no `config_option_update` notification for an
	 * option the client itself set, so the reply is the only refresh source.
	 */
	async setConfigOption(configId: string, value: string): Promise<void> {
		const allowed = this.configValues(configId);
		if (allowed.length > 0 && !allowed.includes(value)) {
			// `model` advertises 94 ids; the full list is a 3 KB error string.
			const shown = allowed.slice(0, OPTIONS_IN_ERROR).join(", ");
			const rest = allowed.length > OPTIONS_IN_ERROR ? ` (+${allowed.length - OPTIONS_IN_ERROR} more)` : "";
			throw new Error(`Unknown ${this.#agentTitle} ${configId} "${value}". Available: ${shown}${rest}`);
		}
		const reply = await this.#peer.request<{ configOptions?: SessionConfigOption[] }>(
			"session/set_config_option",
			{ sessionId: this.#sessionId, configId, value },
			{ timeoutMs: CONFIG_TIMEOUT_MS },
		);
		if (reply?.configOptions) this.#configOptions = reply.configOptions;
	}

	/**
	 * Run one turn. An ACP session is a single conversation, so concurrent tool
	 * calls queue instead of racing: the host does not serialize extension tools,
	 * and Devin answers one `session/prompt` at a time.
	 */
	async prompt(options: DevinPromptOptions): Promise<DevinTurnResult> {
		const turn = this.#queue.then(() => this.#runPrompt(options));
		this.#queue = turn.then(
			() => undefined,
			() => undefined,
		);
		return await turn;
	}

	async #runPrompt(options: DevinPromptOptions): Promise<DevinTurnResult> {
		if (!this.alive) throw new Error(`${this.#agentTitle} exited: ${this.#exitReason ?? "unknown reason"}`);

		const transcript = new TurnTranscript(this.#sessionId, this.#mode);
		const settled = Promise.withResolvers<void>();
		this.#activeTurn = transcript;
		this.#turnSettled = settled.promise;
		this.#resolvePermission = options.resolvePermission;
		this.#permissionAborter = new AbortController();
		const emit = options.onActivity;
		let lastView = "";
		const onUpdate = () => {
			if (!emit) return;
			const view = transcript.liveView();
			if (view === lastView) return;
			lastView = view;
			emit(view, transcript.details());
		};
		const unsubscribe = this.#onTurnUpdate(onUpdate);

		// `session/cancel` is advisory: a wedged or stopped child never answers it,
		// and `session/prompt` has no timeout, so the kill is the backstop.
		let killTimer: Timer | undefined;
		const abort = () => {
			this.#cancelTurn();
			killTimer ??= setTimeout(() => {
				this.#logger.warn("devin-acp: cancel unanswered, stopping agent", { sessionId: this.#sessionId });
				void this.shutdown(`cancel unanswered after ${CANCEL_GRACE_MS / 1000}s, agent stopped`);
			}, CANCEL_GRACE_MS);
		};
		if (options.signal?.aborted) abort();
		options.signal?.addEventListener("abort", abort, { once: true });

		try {
			const response = await this.#peer.request<PromptResponse>("session/prompt", {
				sessionId: this.#sessionId,
				prompt: [{ type: "text", text: options.prompt }],
			});
			const details = transcript.details(response.stopReason);
			if (response.usage) details.usage = response.usage;
			return { text: transcript.text(), stopReason: response.stopReason, details };
		} catch (error) {
			throw await this.#withDiagnostics(error);
		} finally {
			clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", abort);
			unsubscribe();
			this.#activeTurn = undefined;
			this.#turnSettled = undefined;
			this.#resolvePermission = undefined;
			this.#permissionAborter = undefined;
			settled.resolve();
		}
	}

	/** Tell Devin to stop and release any dialog waiting on the host. */
	#cancelTurn(): void {
		this.#peer.notify("session/cancel", { sessionId: this.#sessionId });
		this.#permissionAborter?.abort();
	}

	/**
	 * Stop the child. A bare SIGTERM leaves the shell commands Devin started
	 * running (they keep writing to the workspace), so an in-flight turn is
	 * cancelled first and given a bounded moment to unwind.
	 */
	async shutdown(reason = "disposed"): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		if (this.#turnSettled) {
			this.#cancelTurn();
			await Promise.race([this.#turnSettled, Bun.sleep(SHUTDOWN_GRACE_MS)]);
		}
		this.#peer.close(reason);
		if (!this.#proc.killed) this.#proc.kill();
		// Await the exit so the child is reaped: an unreaped zombie holds a process
		// slot for the whole life of the omp session. A wedged or stopped child
		// never answers SIGTERM, so escalate.
		const exited = await Promise.race([
			this.#proc.exited.then(() => true),
			Bun.sleep(EXIT_GRACE_MS).then(() => false),
		]);
		if (!exited) {
			this.#proc.kill("SIGKILL");
			await this.#proc.exited;
		}
		if (this.#overlayRoot) {
			const root = this.#overlayRoot;
			this.#overlayRoot = undefined;
			await fs.rm(root, { recursive: true, force: true }).catch(() => {});
		}
	}

	#turnListeners = new Set<() => void>();

	#onTurnUpdate(listener: () => void): () => void {
		this.#turnListeners.add(listener);
		return () => {
			this.#turnListeners.delete(listener);
		};
	}

	#onNotification(method: string, params: unknown): void {
		if (method !== "session/update") return;
		const notification = params as SessionNotification;
		if (!notification?.update) return;
		if (notification.sessionId && this.#sessionId && notification.sessionId !== this.#sessionId) return;
		if (notification.update.sessionUpdate === "config_option_update") {
			const updated = (notification.update as { configOptions?: SessionConfigOption[] }).configOptions;
			if (updated) this.#configOptions = updated;
		}
		if (notification.update.sessionUpdate === "current_mode_update") {
			this.#mode = (notification.update as { currentModeId?: string }).currentModeId ?? this.#mode;
		}
		this.#activeTurn?.apply(notification.update);
		for (const listener of this.#turnListeners) listener();
	}

	async #onRequest(method: string, params: unknown): Promise<unknown> {
		if (method !== "session/request_permission") throw new AcpMethodNotFound(method);
		const request = params as RequestPermissionRequest;
		const resolver = this.#resolvePermission;
		const aborter = this.#permissionAborter;
		if (!resolver || !aborter) {
			this.#logger.warn("devin-acp: permission request without an active turn", { title: request.toolCall?.title });
			return { outcome: { outcome: "cancelled" } } satisfies RequestPermissionResponse;
		}
		// A cancelled turn must answer the pending request, not leave Devin waiting
		// on a dialog nobody can still see.
		const optionId = aborter.signal.aborted ? undefined : await resolver(request, aborter.signal);
		return (
			optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } }
		) satisfies RequestPermissionResponse;
	}

	async #readStderr(): Promise<void> {
		const reader = (this.#proc.stderr as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			buffer += decoder.decode(value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trimEnd();
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!line) continue;
				if (NOISE_PATTERN.test(line)) {
					this.#logger.debug("devin-acp: stderr", { line });
					continue;
				}
				this.#stderrTail.push(line);
				if (this.#stderrTail.length > STDERR_RETAIN_LINES) this.#stderrTail.shift();
				this.#logger.warn("devin-acp: stderr", { line });
			}
		}
	}

	/** Attach the exit status and recent non-noise stderr to a transport failure. */
	#withStderr(error: unknown): Error {
		const base = error instanceof Error ? error : new Error(String(error));
		const parts: string[] = [];
		if (this.#exitStatus) parts.push(`${this.#binaryLabel} ${this.#exitStatus}`);
		if (this.#stderrTail.length > 0) parts.push(`Devin stderr:\n${this.#stderrTail.join("\n")}`);
		if (parts.length === 0) return base;
		return new Error(`${base.message}\n${parts.join("\n")}`);
	}

	/**
	 * A failing child closes stdout before its exit status and last stderr lines
	 * are observable, which is exactly the information needed to tell a missing
	 * binary from a crash; wait a bounded moment for them.
	 *
	 * Auth failures are reported here rather than at one call site because Devin
	 * accepts `session/new` while logged out and only rejects the first
	 * `session/prompt` (code -32000), and its message instructs the user to run
	 * `/login` — Devin's own TUI command, which does nothing from omp.
	 */
	async #withDiagnostics(error: unknown): Promise<Error> {
		if (isAuthError(error)) {
			return new Error(
				`${this.#agentTitle} rejected the request as unauthenticated. Run \`devin auth login\` and retry. (${
					(error as Error).message
				})`,
			);
		}
		if (!this.#exitStatus || this.#stderrTail.length === 0) {
			await Promise.race([this.#proc.exited, Bun.sleep(STDERR_DRAIN_MS)]);
		}
		return this.#withStderr(error);
	}
}
