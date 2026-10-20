/**
 * Carries omp's conversation into a Devin session that has not seen it.
 *
 * A Devin session keeps its own history, so forwarding only the newest user
 * message is right while one session answers every turn. It is wrong whenever
 * the session is new (first Devin turn in a conversation, a model switch into
 * Devin mid-conversation, `/devin reset`, an extension reload) or another model
 * answered in between: Devin then starts blind and re-explores the repo to
 * rebuild context omp already holds. This module renders exactly the messages
 * the session missed.
 */
import type { Context, Message } from "@oh-my-pi/pi-ai";
import historyTemplate from "./prompts/history.md" with { type: "text" };

/** Tail kept when the missed transcript is long; Devin needs the recent work, not all of it. */
const MAX_HISTORY_CHARS = 48_000;
const MAX_TOOL_ARGS_CHARS = 300;
const MAX_TOOL_RESULT_CHARS = 800;

export interface DevinTurnInput {
	/** Text sent as the `session/prompt`. */
	prompt: string;
	/** Timestamp of the user message this turn answers; the session has seen everything up to it. */
	deliveredAt: number;
	/** Missed messages folded into `prompt`, for logging. */
	replayed: number;
}

function contentText(content: Message["content"]): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") parts.push(block.text);
		else if (block.type === "image") parts.push("[image]");
	}
	return parts.join("\n");
}

function clip(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}… [${text.length - limit} more chars]` : text;
}

function renderMessage(message: Message): string | undefined {
	switch (message.role) {
		case "user": {
			const text = contentText(message.content).trim();
			return text ? `User: ${text}` : undefined;
		}
		case "assistant": {
			const lines: string[] = [];
			for (const block of message.content) {
				if (block.type === "text" && block.text.trim()) lines.push(`Assistant (${message.model}): ${block.text.trim()}`);
				else if (block.type === "toolCall") {
					lines.push(`  → ${block.name}(${clip(JSON.stringify(block.arguments), MAX_TOOL_ARGS_CHARS)})`);
				}
			}
			return lines.length > 0 ? lines.join("\n") : undefined;
		}
		case "toolResult": {
			const text = contentText(message.content).trim();
			return `  ← ${message.toolName}${message.isError ? " failed" : ""}: ${clip(text, MAX_TOOL_RESULT_CHARS)}`;
		}
		default:
			return undefined;
	}
}

/**
 * Builds the prompt for one Devin turn. `deliveredAt` is the timestamp of the
 * last user message this Devin session answered, undefined for a new session.
 * Devin's own answers after it are skipped: the session already holds them.
 */
export function buildTurnInput(context: Context, provider: string, deliveredAt: number | undefined): DevinTurnInput {
	const messages = context.messages;
	let latest = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role === "user" && contentText(message.content).trim()) {
			latest = i;
			break;
		}
	}
	const current = latest >= 0 ? messages[latest] : undefined;
	if (!current || current.role !== "user") throw new Error("No user message to forward to Devin.");
	const request = contentText(current.content);

	// Start after the last message this session answered; when it is gone (new
	// session, or omp compacted it away) the session has seen nothing here.
	let start = 0;
	if (deliveredAt !== undefined) {
		const delivered = messages.findIndex(m => m.role === "user" && m.timestamp === deliveredAt);
		if (delivered >= 0) start = delivered + 1;
	}
	const rendered: string[] = [];
	for (let i = start; i < latest; i++) {
		const message = messages[i];
		if (!message) continue;
		if (message.role === "assistant" && message.provider === provider && start > 0) continue;
		const line = renderMessage(message);
		if (line) rendered.push(line);
	}
	if (rendered.length === 0) return { prompt: request, deliveredAt: current.timestamp, replayed: 0 };

	let history = rendered.join("\n\n");
	if (history.length > MAX_HISTORY_CHARS) {
		const omitted = history.length - MAX_HISTORY_CHARS;
		history = `[… ${omitted} earlier characters omitted]\n${history.slice(omitted)}`;
	}
	const prompt = historyTemplate
		.replace("{{history}}", () => history)
		.replace("{{request}}", () => request)
		.trimEnd();
	return { prompt, deliveredAt: current.timestamp, replayed: rendered.length };
}
