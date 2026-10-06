/**
 * Reduces AgentSession events and message snapshots to compact, JSON-safe DTOs
 * before they cross IPC. The raw `message_update` event carries the full
 * partial assistant message on every token — forwarding deltas only keeps IPC
 * traffic ~two orders of magnitude smaller.
 */

import type { ChatMessageDTO, ContentBlockDTO, SanitizedEvent, UpdateDTO } from "../shared/ipc-types.ts";

/**
 * Structural stand-in for the SDK's AgentMessage union (the type itself is not
 * exported from pi-plus-sdk's type surface). All access is defensive because
 * tool results and custom messages carry open-ended payloads.
 */
type AnyAgentMessage = { role: string; content?: unknown; [key: string]: unknown };

const TOOL_PREVIEW_LIMIT = 4096;
const TOOL_DIFF_LIMIT = 32768;
const SNAPSHOT_TEXT_LIMIT = 2048;
const SNAPSHOT_MESSAGE_LIMIT = 500;

function truncate(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}… [truncated ${text.length - limit} chars]`;
}

function preview(value: unknown): string {
	if (value === undefined) return "";
	let text: string;
	if (typeof value === "string") text = value;
	else {
		try {
			text = JSON.stringify(value);
		} catch {
			text = String(value);
		}
	}
	return truncate(text, TOOL_PREVIEW_LIMIT);
}

function toContentBlockDTO(block: unknown): ContentBlockDTO {
	const b = block as Record<string, unknown>;
	switch (b?.type) {
		case "text":
			return { type: "text", text: truncate(String(b.text ?? ""), SNAPSHOT_TEXT_LIMIT) };
		case "thinking":
			return { type: "thinking", thinking: truncate(String(b.thinking ?? ""), SNAPSHOT_TEXT_LIMIT), redacted: b.redacted === true };
		case "toolCall":
			return { type: "toolCall", id: String(b.id ?? ""), name: String(b.name ?? ""), arguments: b.arguments };
		case "image":
			return { type: "image", placeholder: true };
		default:
			return { type: "text", text: "[unknown content block]" };
	}
}

/** Convert a finalized SDK message to a display DTO (safe for structured clone). */
export function messageToDTO(message: AnyAgentMessage): ChatMessageDTO {
	const m = message as Record<string, unknown>;
	const dto: ChatMessageDTO = {
		role: m.role as ChatMessageDTO["role"],
		content: typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map(toContentBlockDTO) : "",
		provider: m.provider as string | undefined,
		model: m.model as string | undefined,
		errorMessage: m.errorMessage as string | undefined,
		toolCallId: m.toolCallId as string | undefined,
		toolName: m.toolName as string | undefined,
		isError: m.isError as boolean | undefined,
		customType: m.customType as string | undefined,
		display: m.display as boolean | undefined,
		timestamp: m.timestamp as number | undefined,
	};
	// The edit tool's result carries a display-formatted diff in `details`;
	// lift it so the renderer can show a colorful diff (live and replay alike,
	// since snapshots go through this same function).
	if (dto.role === "toolResult") {
		const details = m.details as Record<string, unknown> | undefined;
		if (typeof details?.diff === "string") {
			dto.diff = details.diff.length > TOOL_DIFF_LIMIT ? `${details.diff.slice(0, TOOL_DIFF_LIMIT)}\n… [diff truncated]` : details.diff;
		}
	}
	const usage = m.usage as Record<string, unknown> | undefined;
	if (usage && dto.role === "assistant") {
		const cost = usage.cost as Record<string, unknown> | undefined;
		dto.usage = {
			input: Number(usage.input ?? 0),
			output: Number(usage.output ?? 0),
			cacheRead: Number(usage.cacheRead ?? 0),
			cacheWrite: Number(usage.cacheWrite ?? 0),
			total: Number(usage.totalTokens ?? 0),
			costTotal: Number(cost?.total ?? 0),
		};
	}
	return dto;
}

/** Extract a compact tool-call preview from a partial message's content block. */
function toolCallPreview(partial: unknown, contentIndex: number) {
	const content = (partial as Record<string, unknown>)?.content;
	const block = Array.isArray(content) ? (content[contentIndex] as Record<string, unknown> | undefined) : undefined;
	return {
		id: String(block?.id ?? ""),
		name: String(block?.name ?? "tool"),
		argumentsPreview: preview(block?.arguments),
	};
}

/** Reduce a raw AgentSessionEvent to its sanitized DTO form; null = drop. */
export function sanitizeEvent(event: Record<string, unknown>): SanitizedEvent | null {
	switch (event.type) {
		case "turn_start":
		case "agent_start":
		case "agent_settled":
		case "message_start":
			return { type: event.type } as SanitizedEvent;

		case "agent_end":
			return { type: "agent_end", willRetry: event.willRetry === true };

		case "message_end":
			return { type: "message_end", message: messageToDTO(event.message as AnyAgentMessage) };

		case "message_update": {
			const e = event.assistantMessageEvent as Record<string, unknown> | undefined;
			if (!e) return null;
			let update: UpdateDTO;
			switch (e.type) {
				case "text_start":
				case "thinking_start":
					update = { type: e.type, contentIndex: Number(e.contentIndex) };
					break;
				case "text_delta":
				case "thinking_delta":
				case "toolcall_delta":
					update = { type: e.type, contentIndex: Number(e.contentIndex), delta: String(e.delta ?? "") };
					break;
				case "text_end":
				case "thinking_end":
					update = { type: e.type, contentIndex: Number(e.contentIndex), content: String(e.content ?? "") };
					break;
				case "toolcall_start":
				case "toolcall_end":
					update = {
						type: e.type,
						contentIndex: Number(e.contentIndex),
						toolCall: toolCallPreview(e.partial, Number(e.contentIndex)),
					};
					break;
				case "done":
					update = { type: "done", reason: String(e.reason ?? "stop"), message: messageToDTO(e.message as AnyAgentMessage) };
					break;
				case "error":
					update = { type: "error", reason: String(e.reason ?? "error"), message: messageToDTO(e.error as AnyAgentMessage) };
					break;
				default:
					return null;
			}
			return { type: "message_update", update };
		}

		case "tool_execution_start":
			return {
				type: "tool_execution_start",
				toolCallId: String(event.toolCallId ?? ""),
				toolName: String(event.toolName ?? "tool"),
				argsPreview: preview(event.args),
			};

		case "tool_execution_update":
			return {
				type: "tool_execution_update",
				toolCallId: String(event.toolCallId ?? ""),
				partialResultPreview: preview(event.partialResult),
			};

		case "tool_execution_end":
			return {
				type: "tool_execution_end",
				toolCallId: String(event.toolCallId ?? ""),
				resultPreview: preview(event.result),
				isError: event.isError === true,
			};

		case "compaction_start":
			return { type: "compaction_start", reason: String(event.reason ?? "manual") };

		case "compaction_end": {
			const result = event.result as Record<string, unknown> | undefined;
			const tokensBefore = Number(result?.tokensBefore);
			const estimatedTokensAfter = Number(result?.estimatedTokensAfter);
			return {
				type: "compaction_end",
				reason: String(event.reason ?? "manual"),
				aborted: event.aborted === true,
				errorMessage: event.errorMessage as string | undefined,
				tokensBefore: Number.isFinite(tokensBefore) ? tokensBefore : undefined,
				estimatedTokensAfter: Number.isFinite(estimatedTokensAfter) ? estimatedTokensAfter : undefined,
			};
		}

		case "queue_update": {
			const steering = event.steering;
			const followUp = event.followUp;
			return {
				type: "queue_update",
				steering: Array.isArray(steering) ? steering.map(String) : [],
				followUp: Array.isArray(followUp) ? followUp.map(String) : [],
			};
		}

		case "session_info_changed":
			return { type: "session_info_changed", name: event.name as string | undefined };

		case "thinking_level_changed":
			return { type: "thinking_level_changed", level: String(event.level ?? "") };

		case "auto_retry_start":
			return {
				type: "auto_retry_start",
				attempt: Number(event.attempt ?? 1),
				maxAttempts: Number(event.maxAttempts ?? 1),
				errorMessage: String(event.errorMessage ?? ""),
			};

		case "auto_retry_end":
			return {
				type: "auto_retry_end",
				success: event.success === true,
				attempt: Number(event.attempt ?? 1),
				finalError: event.finalError as string | undefined,
			};

		case "entry_appended":
			// Only used as a "history changed" signal; the entry itself stays in main.
			return { type: "entry_appended" };

		case "bash_execution_update":
			return null; // per-chunk terminal mirroring; not needed in the desktop UI

		default:
			return null;
	}
}

/** Snapshot of prior messages for a resumed session. */
export function sanitizeSnapshot(messages: readonly unknown[]): ChatMessageDTO[] {
	const droppedSystem = messages.filter((m) => (m as { role?: string }).role !== "system");
	const capped = droppedSystem.length > SNAPSHOT_MESSAGE_LIMIT ? droppedSystem.slice(-SNAPSHOT_MESSAGE_LIMIT) : droppedSystem;
	return capped.map((m) => messageToDTO(m as AnyAgentMessage));
}
