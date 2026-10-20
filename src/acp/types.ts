/**
 * Minimal Agent Client Protocol (protocolVersion 1) type subset — only what the
 * Devin driver sends or reads. Deliberately self-contained: out-of-tree
 * extensions cannot resolve host subpath packages such as
 * `@oh-my-pi/pi-utils/acp` (verified against omp 18.12.1).
 */

export const ACP_PROTOCOL_VERSION = 1;

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number | string;
	method: string;
	params?: unknown;
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

export interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: number | string;
	result?: unknown;
	error?: JsonRpcError;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface ClientCapabilities {
	fs: { readTextFile: boolean; writeTextFile: boolean };
	terminal: boolean;
}

export interface AuthMethod {
	id: string;
	name: string;
	description?: string | null;
}

export interface InitializeResponse {
	protocolVersion: number;
	agentInfo?: { name?: string; title?: string; version?: string };
	agentCapabilities?: Record<string, unknown>;
	authMethods?: AuthMethod[];
}

export interface SessionModeState {
	currentModeId: string;
	availableModes: { id: string; name: string; description?: string | null }[];
}

/**
 * Devin exposes model/effort choice through config options rather than
 * `session/set_model`, which it does not implement (`-32601`).
 */
export interface SessionConfigOption {
	id: string;
	name: string;
	category?: string;
	type?: string;
	currentValue?: unknown;
	options?: { id?: string; value?: unknown; name?: string }[];
}

export interface NewSessionResponse {
	sessionId: string;
	modes?: SessionModeState | null;
	configOptions?: SessionConfigOption[] | null;
}

export interface ContentBlock {
	type: string;
	text?: string;
	path?: string;
	oldText?: string | null;
	newText?: string;
	content?: ContentBlock;
	[key: string]: unknown;
}

export interface ToolCallLocation {
	path: string;
	line?: number | null;
}

export interface ToolCallUpdate {
	toolCallId: string;
	title?: string;
	kind?: string;
	status?: "pending" | "in_progress" | "completed" | "failed";
	content?: { type: string; content?: ContentBlock; path?: string; oldText?: string | null; newText?: string }[];
	locations?: ToolCallLocation[];
	rawInput?: Record<string, unknown>;
	_meta?: Record<string, unknown>;
}

export interface PlanEntry {
	content: string;
	status: "pending" | "in_progress" | "completed";
	priority?: string;
}

/** Devin reports `inputTokens` inclusive of both cache counters. */
export interface TokenUsage {
	totalTokens?: number;
	inputTokens?: number;
	outputTokens?: number;
	cachedReadTokens?: number;
	cachedWriteTokens?: number;
}

export type SessionUpdate =
	| { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
	| { sessionUpdate: "agent_thought_chunk"; content: ContentBlock }
	| { sessionUpdate: "user_message_chunk"; content: ContentBlock }
	| ({ sessionUpdate: "tool_call" } & ToolCallUpdate)
	| ({ sessionUpdate: "tool_call_update" } & ToolCallUpdate)
	| { sessionUpdate: "plan"; entries: PlanEntry[] }
	| { sessionUpdate: "current_mode_update"; currentModeId: string }
	| { sessionUpdate: "config_option_update"; configOptions?: SessionConfigOption[] }
	| { sessionUpdate: "available_commands_update"; availableCommands?: { name: string; description?: string }[] }
	| { sessionUpdate: "usage_update"; usage?: TokenUsage }
	| { sessionUpdate: "session_info_update"; info?: Record<string, unknown> }
	| { sessionUpdate: string; [key: string]: unknown };

export interface SessionNotification {
	sessionId: string;
	update: SessionUpdate;
}

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" | string;

export interface PromptResponse {
	stopReason: StopReason;
	usage?: TokenUsage;
}

export interface PermissionOption {
	optionId: string;
	name: string;
	kind?: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

export interface RequestPermissionRequest {
	sessionId: string;
	toolCall: ToolCallUpdate;
	options: PermissionOption[];
}

export type RequestPermissionResponse =
	| { outcome: { outcome: "selected"; optionId: string } }
	| { outcome: { outcome: "cancelled" } };
