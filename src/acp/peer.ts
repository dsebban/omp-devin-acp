import type { JsonRpcError, JsonRpcMessage, JsonRpcRequest, JsonRpcResponse } from "./types";

/** JSON-RPC error raised by the agent, with the wire `code`/`data` preserved. */
export class AcpRpcError extends Error {
	code: number;
	data: unknown;

	constructor(error: JsonRpcError) {
		super(error.message);
		this.name = "AcpRpcError";
		this.code = error.code;
		this.data = error.data;
	}
}

/** Thrown by request handlers for methods this client does not implement. */
export class AcpMethodNotFound extends Error {
	constructor(method: string) {
		super(`Method not found: ${method}`);
		this.name = "AcpMethodNotFound";
	}
}

export interface AcpPeerHandlers {
	/** Agent → client notification (`session/update`, …). */
	onNotification(method: string, params: unknown): void;
	/** Agent → client request (`session/request_permission`, `fs/*`, `terminal/*`). */
	onRequest(method: string, params: unknown): Promise<unknown>;
	/** Transport ended: the agent process closed stdout or exited. */
	onClose(reason: string): void;
}

export interface AcpRequestOptions {
	/** Reject if the agent does not answer in time. Omit for long-running calls. */
	timeoutMs?: number;
}

interface PendingRequest {
	resolve(value: unknown): void;
	reject(reason: Error): void;
	timer?: Timer;
}

/**
 * Bidirectional newline-delimited JSON-RPC 2.0 peer, client side.
 *
 * Messages are classified by field presence, never by key order: Devin's
 * serializer emits `id` after `method`/`params` for agent→client requests.
 */
export class AcpPeer {
	#stdin: Bun.FileSink;
	#handlers: AcpPeerHandlers;
	#pending = new Map<number, PendingRequest>();
	#encoder = new TextEncoder();
	#nextId = 1;
	#closed: string | undefined;
	#readerDone: Promise<void>;

	constructor(stdin: Bun.FileSink, stdout: ReadableStream<Uint8Array>, handlers: AcpPeerHandlers) {
		this.#stdin = stdin;
		this.#handlers = handlers;
		this.#readerDone = this.#readLoop(stdout);
	}

	/** Resolves once the agent's stdout has ended and pending calls were settled. */
	get finished(): Promise<void> {
		return this.#readerDone;
	}

	request<T>(method: string, params: unknown, options: AcpRequestOptions = {}): Promise<T> {
		if (this.#closed) return Promise.reject(new Error(`ACP connection closed: ${this.#closed}`));
		const id = this.#nextId++;
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		const entry: PendingRequest = {
			resolve: value => resolve(value as T),
			reject,
		};
		if (options.timeoutMs !== undefined) {
			entry.timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`ACP request timed out after ${options.timeoutMs}ms: ${method}`));
			}, options.timeoutMs);
		}
		this.#pending.set(id, entry);
		this.#write({ jsonrpc: "2.0", id, method, params });
		return promise;
	}

	notify(method: string, params: unknown): void {
		if (this.#closed) return;
		this.#write({ jsonrpc: "2.0", method, params });
	}

	close(reason: string): void {
		if (this.#closed) return;
		this.#closed = reason;
		this.#rejectAll(new Error(`ACP connection closed: ${reason}`));
		try {
			this.#stdin.end();
		} catch {
			// The child may already be gone; nothing to flush.
		}
	}

	#write(message: JsonRpcMessage): void {
		this.#stdin.write(this.#encoder.encode(`${JSON.stringify(message)}\n`));
		void this.#stdin.flush();
	}

	async #readLoop(stdout: ReadableStream<Uint8Array>): Promise<void> {
		const reader = stdout.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					if (line) this.#dispatchLine(line);
					newline = buffer.indexOf("\n");
				}
			}
			// A response written without a trailing newline right before exit is
			// still a response.
			buffer += decoder.decode();
			const tail = buffer.trim();
			if (tail) this.#dispatchLine(tail);
		} catch (error) {
			this.#handlers.onClose(error instanceof Error ? error.message : String(error));
			this.close("stdout error");
			return;
		}
		this.#handlers.onClose("agent stdout closed");
		this.close("agent stdout closed");
	}

	/** One malformed line, or a throwing update listener, must not end the session. */
	#dispatchLine(line: string): void {
		try {
			this.#dispatchMessage(line);
		} catch (error) {
			this.#handlers.onNotification("$/clientError", {
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	#dispatchMessage(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			// Devin interleaves no stdout noise today, but a stray banner must not
			// kill the session.
			return;
		}
		if (typeof parsed !== "object" || parsed === null) return;
		const message = parsed as JsonRpcMessage;
		const rawId = (message as JsonRpcResponse).id;
		const method = (message as JsonRpcRequest).method;
		if (typeof method === "string") {
			if (rawId === undefined || rawId === null) {
				this.#handlers.onNotification(method, (message as JsonRpcRequest).params);
				return;
			}
			void this.#serveRequest(rawId, method, (message as JsonRpcRequest).params);
			return;
		}
		const response = message as JsonRpcResponse;
		// A null id on an error response is a parse/transport failure that belongs
		// to no single call: fail everything rather than hang.
		if (rawId === null && response.error) {
			this.#rejectAll(new AcpRpcError(response.error));
			return;
		}
		const id = typeof rawId === "string" ? Number(rawId) : rawId;
		if (typeof id !== "number" || !Number.isFinite(id)) return;
		const pending = this.#pending.get(id);
		if (!pending) return;
		this.#pending.delete(id);
		clearTimeout(pending.timer);
		if (response.error) pending.reject(new AcpRpcError(response.error));
		else pending.resolve(response.result);
	}

	#rejectAll(error: Error): void {
		for (const [id, pending] of this.#pending) {
			clearTimeout(pending.timer);
			this.#pending.delete(id);
			pending.reject(error);
		}
	}

	async #serveRequest(id: number | string, method: string, params: unknown): Promise<void> {
		try {
			const result = await this.#handlers.onRequest(method, params);
			this.#write({ jsonrpc: "2.0", id, result });
		} catch (error) {
			const notFound = error instanceof AcpMethodNotFound;
			this.#write({
				jsonrpc: "2.0",
				id,
				error: {
					code: notFound ? -32601 : -32603,
					message: error instanceof Error ? error.message : String(error),
				},
			});
		}
	}
}
