import * as os from "node:os";
import * as path from "node:path";
import type { ContentBlock, PlanEntry, SessionUpdate, TokenUsage, ToolCallUpdate } from "../acp/types";

export interface TurnToolCall {
	id: string;
	title: string;
	kind: string;
	status: string;
	/** Devin's internal tool name (`exec`, `apply_patch`, …) when it reports one. */
	tool?: string;
	/** Compact target extracted from `locations` or `rawInput` (relative path, command, query, …). */
	detail?: string;
}

export interface TurnToolActivity {
	/** One-line label for omp's working/spinner row (latest active tool, or latest settled tool). */
	working: string;
	/** Ordered tool-call lines for omp's live widget above the editor, bounded to widget height. */
	lines: string[];
}

export interface TurnDetails {
	sessionId: string;
	stopReason?: string;
	mode?: string;
	toolCalls: TurnToolCall[];
	plan: PlanEntry[];
	usage?: TokenUsage;
	thoughtChars: number;
}

const INFERENCE_TOOL_NAME_KEY = "cognition.ai/inferenceToolName";
const EDITABLE_COMMAND_KEY = "cognition.ai/editableCommand";
const STATUS_MARK: Record<string, string> = {
	pending: "·",
	in_progress: "▸",
	completed: "✓",
	failed: "✗",
};
const ACTIVE_STATUSES = new Set(["pending", "in_progress"]);
const GENERIC_TITLES = new Set([
	"tool call",
	"read file",
	"edit file",
	"write file",
	"run command",
	"execute command",
	"list files",
	"search files",
]);
const DETAIL_MAX_CHARS = 80;
const WIDGET_MAX_LINES = 8;

/** Glyph for a tool call's ACP status; unknown statuses read as pending. */
export function statusMark(status: string): string {
	return STATUS_MARK[status] ?? "·";
}

/** Live-view bounds: a turn can stream unbounded text and tool updates. */
const TAIL_LIMIT = 2048;
const ACTIVITY_LIMIT = 64;

export function blockText(content: ContentBlock | undefined): string {
	if (!content) return "";
	if (typeof content.text === "string") return content.text;
	return "";
}

function inferenceToolName(update: ToolCallUpdate): string | undefined {
	const raw = update._meta?.[INFERENCE_TOOL_NAME_KEY];
	return typeof raw === "string" ? raw : undefined;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function clipDetail(text: string): string {
	const single = oneLine(text);
	return single.length > DETAIL_MAX_CHARS ? `${single.slice(0, DETAIL_MAX_CHARS - 1)}…` : single;
}

function formatPath(rawPath: string, cwd: string | undefined): string {
	if (cwd) {
		const normalizedCwd = cwd.replace(/^\/private\//, "/");
		const normalizedPath = rawPath.replace(/^\/private\//, "/");
		const rel = path.relative(normalizedCwd, normalizedPath);
		if (rel === "") return ".";
		if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
	}
	const home = os.homedir();
	if (home && rawPath.startsWith(`${home}/`)) return `~/${rawPath.slice(home.length + 1)}`;
	return rawPath;
}

function firstString(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
	if (!record) return undefined;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

function extractToolDetail(update: ToolCallUpdate, cwd: string | undefined): string | undefined {
	const location = update.locations?.[0];
	if (location?.path) {
		const formatted = formatPath(location.path, cwd);
		return clipDetail(typeof location.line === "number" && location.line > 0 ? `${formatted}:${location.line}` : formatted);
	}
	const rawPath = firstString(update.rawInput, ["file_path", "path", "notebook_path"]);
	if (rawPath) return clipDetail(formatPath(rawPath, cwd));
	const command =
		firstString(update.rawInput, ["command"]) ??
		(typeof update._meta?.[EDITABLE_COMMAND_KEY] === "string" ? update._meta[EDITABLE_COMMAND_KEY] : undefined);
	if (command) return clipDetail(command);
	const query = firstString(update.rawInput, ["pattern", "query", "sql", "url", "project"]);
	if (query) return clipDetail(query);
	return undefined;
}

/**
 * Folds one `session/prompt` turn's `session/update` stream into the final
 * assistant text, a live activity view, and structured details for rendering.
 */
export class TurnTranscript {
	#sessionId: string;
	#text: string[] = [];
	#thoughtChars = 0;
	#toolCalls = new Map<string, TurnToolCall>();
	#plan: PlanEntry[] = [];
	#usage: TokenUsage | undefined;
	#mode: string | undefined;
	#cwd: string | undefined;
	/** Bounded mirror of `#text`'s end, so the live view never re-joins the answer. */
	#tail = "";
	/** Bounded ring of recent tool-call ids; a long turn emits thousands of updates. */
	#recent: string[] = [];
	/** A tool call interrupted the answer: separate the next message from it. */
	#breakBeforeText = false;

	constructor(sessionId: string, mode?: string, cwd?: string) {
		this.#sessionId = sessionId;
		this.#mode = mode;
		this.#cwd = cwd;
	}

	apply(update: SessionUpdate): void {
		switch (update.sessionUpdate) {
			case "agent_message_chunk": {
				const chunk = blockText(update.content as ContentBlock);
				if (!chunk) return;
				if (this.#breakBeforeText) {
					this.#breakBeforeText = false;
					if (this.#text.length > 0) this.#appendText("\n\n");
				}
				this.#appendText(chunk);
				return;
			}
			case "agent_thought_chunk": {
				this.#thoughtChars += blockText(update.content as ContentBlock).length;
				return;
			}
			case "tool_call":
			case "tool_call_update": {
				this.#applyToolCall(update as ToolCallUpdate);
				if (this.#text.length > 0) this.#breakBeforeText = true;
				return;
			}
			case "plan": {
				const entries = (update as { entries?: PlanEntry[] }).entries;
				if (entries) this.#plan = entries;
				return;
			}
			case "current_mode_update": {
				this.#mode = (update as { currentModeId?: string }).currentModeId ?? this.#mode;
				return;
			}
			case "usage_update": {
				this.#usage = (update as { usage?: TokenUsage }).usage ?? this.#usage;
				return;
			}
			default:
				return;
		}
	}

	#applyToolCall(update: ToolCallUpdate): void {
		const id = update.toolCallId;
		if (!id) return;
		const existing = this.#toolCalls.get(id);
		const entry: TurnToolCall = {
			id,
			title: update.title ?? existing?.title ?? "tool call",
			kind: update.kind ?? existing?.kind ?? "other",
			status: update.status ?? existing?.status ?? "pending",
			tool: inferenceToolName(update) ?? existing?.tool,
			detail: extractToolDetail(update, this.#cwd) ?? existing?.detail,
		};
		this.#toolCalls.set(id, entry);
		// One line per tool call, re-rendered as its status advances: pushing per
		// update showed the same call three times (pending, in_progress, done).
		if (!existing) {
			this.#recent.push(id);
			if (this.#recent.length > ACTIVITY_LIMIT) this.#recent.shift();
		}
	}

	#appendText(chunk: string): void {
		this.#text.push(chunk);
		this.#tail = this.#tail.length + chunk.length > TAIL_LIMIT
			? (this.#tail + chunk).slice(-TAIL_LIMIT)
			: this.#tail + chunk;
	}

	/** Compact live view: recent activity plus the tail of the streamed answer. */
	liveView(maxActivity = 6, maxTextChars = 400): string {
		const lines: string[] = [];
		for (const id of this.#recent.slice(-maxActivity)) {
			const call = this.#toolCalls.get(id);
			if (call) lines.push(toolCallLine(call));
		}
		const text = this.#tail.trim();
		if (text) {
			const tail = text.length > maxTextChars ? `…${text.slice(-maxTextChars)}` : text;
			lines.push("", tail);
		} else if (lines.length === 0) {
			lines.push("Devin is working…");
		}
		return lines.join("\n");
	}

	toolCall(id: string): TurnToolCall | undefined {
		return this.#toolCalls.get(id);
	}

	/** Live tool-call snapshot for omp's working message and above-editor widget. */
	toolActivity(maxLines = WIDGET_MAX_LINES): TurnToolActivity | undefined {
		const total = this.#toolCalls.size;
		if (total === 0) return undefined;
		const limit = Math.max(1, maxLines);
		const visibleCount = total > limit ? Math.max(1, limit - 1) : total;
		const visibleCalls: TurnToolCall[] = [];
		for (const id of this.#recent.slice(-visibleCount)) {
			const call = this.#toolCalls.get(id);
			if (call) visibleCalls.push(call);
		}
		if (visibleCalls.length === 0) return undefined;
		const lines = visibleCalls.map(toolCallLine);
		if (total > limit) {
			const hidden = total - visibleCalls.length;
			lines.unshift(`… ${hidden} earlier tool ${hidden === 1 ? "call" : "calls"}`);
		}
		let active: TurnToolCall | undefined;
		for (let i = this.#recent.length - 1; i >= 0; i--) {
			const call = this.#toolCalls.get(this.#recent[i]!);
			if (call && ACTIVE_STATUSES.has(call.status)) {
				active = call;
				break;
			}
		}
		const working = toolCallLine(active ?? visibleCalls[visibleCalls.length - 1]!);
		return { working, lines };
	}

	text(): string {
		return this.#text.join("");
	}

	details(stopReason?: string): TurnDetails {
		return {
			sessionId: this.#sessionId,
			stopReason,
			mode: this.#mode,
			toolCalls: [...this.#toolCalls.values()],
			plan: this.#plan,
			usage: this.#usage,
			thoughtChars: this.#thoughtChars,
		};
	}
}

/** `✓ read: src/index.ts` — one line per tool call, shared by the tool's live view and the provider's live activity widget. */
export function toolCallLine(call: TurnToolCall): string {
	const name = call.tool ?? call.kind;
	const title = oneLine(call.title);
	const detail = call.detail;
	let summary = title;
	if (detail) {
		const lowerTitle = title.toLowerCase();
		if (GENERIC_TITLES.has(lowerTitle) || lowerTitle === name.toLowerCase() || lowerTitle === call.kind.toLowerCase()) {
			summary = detail;
		} else if (!lowerTitle.includes(detail.toLowerCase())) {
			summary = `${title} · ${detail}`;
		}
	}
	return `${statusMark(call.status)} ${name}: ${summary}`;
}
