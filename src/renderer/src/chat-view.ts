/**
 * Chat view: renders a tab's ChatItem list, plus the live streaming buffer.
 * Appends are incremental; streaming deltas mutate the tail node's text
 * directly so per-token updates never re-render the list.
 */

import { isImagePath } from "../../shared/attachments.ts";
import type { ChatMessageDTO, ContentBlockDTO } from "../../shared/ipc-types.ts";
import { thumbSrc } from "./image-thumb.ts";
import { renderMarkdownToHtml, escapeHtml } from "./markdown.ts";
import { store, type TabState, type ToolBlock } from "./store.ts";

function el(tag: string, className?: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function toolBlockFor(tab: TabState, toolCallId: string): ToolBlock | undefined {
	return tab.tools.get(toolCallId);
}

function renderToolRow(tab: TabState, toolCallId: string, fallbackName: string): HTMLElement {
	const tool = toolBlockFor(tab, toolCallId);
	const name = tool?.name ?? fallbackName;
	const status = tool?.status ?? "running";
	const row = el("div", `tool-row tool-${status}`);
	const header = el("div", "tool-header");
	header.append(el("span", "tool-icon", status === "running" ? "▸" : status === "error" ? "✗" : "✓"));
	header.append(el("span", "tool-name", name));
	header.append(el("span", "tool-status", status === "running" ? "running…" : status));
	row.append(header);

	const body = el("div", "tool-body");
	const args = tool?.argsPreview ?? "";
	if (args) body.append(el("pre", "tool-pre", args));
	if (tool?.resultPreview) body.append(el("pre", "tool-pre tool-result", tool.resultPreview));
	if (body.childElementCount > 0) {
		header.classList.add("tool-toggle");
		header.addEventListener("click", () => row.classList.toggle("tool-open"));
		row.append(body);
	}
	return row;
}

function renderUserItem(text: string, attachments?: string[]): HTMLElement {
	const row = el("div", "msg msg-user");
	const bubble = el("div", "msg-user-bubble");
	bubble.textContent = text;
	row.append(bubble);
	if (attachments && attachments.length > 0) {
		const chipRow = el("div", "msg-user-attachments");
		for (const path of attachments) {
			const name = path.split(/[/\\]/).pop() || path;
			if (isImagePath(path)) {
				const img = document.createElement("img");
				img.className = "msg-user-image";
				img.title = path;
				void thumbSrc(path).then((src) => {
					if (src) img.src = src;
					else {
						const chip = el("span", "attachment-chip", `📎 ${name}`);
						chip.title = path;
						chipRow.replaceChild(chip, img); // unreadable -> plain chip
					}
				});
				chipRow.append(img);
			} else {
				const chip = el("span", "attachment-chip", `📎 ${name}`);
				chip.title = path;
				chipRow.append(chip);
			}
		}
		row.append(chipRow);
	}
	return row;
}

function renderNoticeItem(text: string): HTMLElement {
	return el("div", "msg msg-notice", text);
}

function renderCompactionItem(text: string): HTMLElement {
	return el("div", "msg msg-compaction", text);
}

// Per-message token/cost display lives in the composer status strip (see
// Composer.renderUsage) — the chat stays clean of usage noise.

function renderAssistantBlocks(tab: TabState, content: ContentBlockDTO[], container: HTMLElement): void {
	for (const block of content) {
		switch (block.type) {
			case "text": {
				const node = el("div", "md");
				node.innerHTML = renderMarkdownToHtml(block.text);
				container.append(node);
				break;
			}
			case "thinking": {
				const details = el("details", "thinking");
				const summary = el("summary", "thinking-summary", "Thinking");
				details.append(summary);
				details.append(el("div", "thinking-body", block.thinking));
				container.append(details);
				break;
			}
			case "toolCall": {
				container.append(renderToolRow(tab, block.id, block.name));
				break;
			}
			case "image":
				container.append(el("div", "msg-image-placeholder", "[image]"));
				break;
		}
	}
}

function renderAssistantItem(tab: TabState, message: ChatMessageDTO): HTMLElement {
	const row = el("div", "msg msg-assistant");
	const body = el("div", "msg-assistant-body");
	const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
	renderAssistantBlocks(tab, content, body);
	row.append(body);
	if (message.errorMessage) row.append(el("div", "msg-error", message.errorMessage));
	return row;
}

function renderToolResultItem(message: ChatMessageDTO): HTMLElement {
	const row = el("div", "msg msg-toolresult");
	const label = el("div", "toolresult-label", `${message.isError ? "✗" : "✓"} ${message.toolName ?? "tool result"}`);
	row.append(label);
	const text = typeof message.content === "string" ? message.content : message.content.map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[image]" : "")).join("\n");
	if (text.trim()) row.append(el("pre", "tool-pre", text));
	return row;
}

export class ChatView {
	private containers = new Map<string, HTMLElement>();
	private root: HTMLElement;
	/** Node holding the live streaming content for fast delta updates. */
	private streamNode: HTMLElement | null = null;

	constructor(root: HTMLElement) {
		this.root = root;
	}

	containerFor(tab: TabState): HTMLElement {
		let node = this.containers.get(tab.tabId);
		if (!node) {
			node = el("div", "chat-container");
			node.dataset.tabId = tab.tabId;
			this.containers.set(tab.tabId, node);
			this.root.append(node);
		}
		return node;
	}

	/** Full re-render of one tab's message list. */
	renderTab(tab: TabState): void {
		const node = this.containerFor(tab);
		node.replaceChildren();
		this.streamNode = null;
		for (const item of tab.items) {
			node.append(this.renderItem(tab, item));
		}
		this.renderStream(tab);
		this.scrollToEnd(tab);
	}

	private renderItem(tab: TabState, item: TabState["items"][number]): HTMLElement {
		switch (item.kind) {
			case "user":
				return renderUserItem(item.text, item.attachments);
			case "assistant":
				return renderAssistantItem(tab, item.message);
			case "toolResult":
				return renderToolResultItem(item.message);
			case "compaction":
				return renderCompactionItem(item.text);
			case "notice":
				return renderNoticeItem(item.text);
		}
	}

	/** Refresh tool rows only (status/result updates). */
	refreshTools(tab: TabState): void {
		// Tool status changes are infrequent; a full re-render keeps the code path
		// simple and preserves streaming node identity.
		this.renderTab(tab);
	}

	/** Update (or create) the live streaming tail. */
	renderStream(tab: TabState): void {
		const node = this.containerFor(tab);
		if (this.streamNode?.parentElement === node && tab.streamBlocks.size === 0) {
			this.streamNode.remove();
			this.streamNode = null;
			return;
		}
		if (tab.streamBlocks.size === 0) return;

		if (!this.streamNode || this.streamNode.parentElement !== node) {
			if (this.streamNode) this.streamNode.remove();
			this.streamNode = el("div", "msg msg-assistant msg-streaming");
			node.append(this.streamNode);
		}
		const body = el("div", "msg-assistant-body");
		const blocks = [...tab.streamBlocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block);
		renderAssistantBlocks(tab, blocks, body);
		this.streamNode.replaceChildren(body);
		this.scrollToEnd(tab, false);
	}

	removeTab(tabId: string): void {
		this.containers.get(tabId)?.remove();
		this.containers.delete(tabId);
		if (this.streamNode && !this.streamNode.isConnected) this.streamNode = null;
	}

	showTab(tabId: string): void {
		for (const [id, node] of this.containers) {
			node.classList.toggle("chat-hidden", id !== tabId);
		}
		const tab = store.tabs.get(tabId);
		if (tab) this.scrollToEnd(tab, false);
	}

	private scrollToEnd(tab: TabState, force = true): void {
		if (store.activeTabId !== tab.tabId) return;
		const node = this.containers.get(tab.tabId);
		if (!node) return;
		const pane = node.parentElement;
		if (!pane) return;
		const nearBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 120;
		if (force || nearBottom) pane.scrollTop = pane.scrollHeight;
	}
}

export function emptyStateHtml(text: string): string {
	return `<div class="empty-state">${escapeHtml(text)}</div>`;
}
