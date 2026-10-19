import type { ContentBlock, PlanEntry, SessionUpdate, TokenUsage, ToolCallUpdate } from "../acp/types";

export interface TurnToolCall {
	id: string;
	title: string;
	kind: string;
	status: string;
	/** Devin's internal tool name (`exec`, `apply_patch`, …) when it reports one. */
	tool?: string;
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
const STATUS_MARK: Record<string, string> = {
	pending: "·",
	in_progress: "▸",
	completed: "✓",
	failed: "✗",
};

/** Glyph for a tool call's ACP status; unknown statuses read as pending. */
export function statusMark(status: string): string {
	return STATUS_MARK[status] ?? "·";
}

/** Live-view bounds: a turn can stream unbounded text and tool updates. */
const TAIL_LIMIT = 2048;
const ACTIVITY_LIMIT = 64;

function blockText(content: ContentBlock | undefined): string {
	if (!content) return "";
	if (typeof content.text === "string") return content.text;
	return "";
}

function inferenceToolName(update: ToolCallUpdate): string | undefined {
	const raw = update._meta?.[INFERENCE_TOOL_NAME_KEY];
	return typeof raw === "string" ? raw : undefined;
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
	/** Bounded mirror of `#text`'s end, so the live view never re-joins the answer. */
	#tail = "";
	/** Bounded ring of recent tool-call ids; a long turn emits thousands of updates. */
	#recent: string[] = [];
	/** A tool call interrupted the answer: separate the next message from it. */
	#breakBeforeText = false;

	constructor(sessionId: string, mode?: string) {
		this.#sessionId = sessionId;
		this.#mode = mode;
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
			if (call) lines.push(`${statusMark(call.status)} ${call.tool ?? call.kind}: ${call.title}`);
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
