/**
 * Renderer-side dialogs: renders modal select/confirm/input/editor requests
 * from the main process (extension ask_user flows) and answers via
 * dialog:respond. Esc and backdrop close resolve as cancelled. Bridge
 * dialogs are individual per session tab: each tab owns its own overlay,
 * only the active tab's is visible, and a dialog raised in a background tab
 * stays pending (never cancelled by another tab's question) until its tab
 * is shown. The promptLocal/selectLocal/confirmLocal helpers render the
 * same overlay for renderer-initiated asks (rename, fork pickers,
 * compaction instructions).
 */

import type { DialogRequestDTO } from "../../shared/ipc-types.ts";
import { renderMarkdownToHtml, enhanceCodeBlocks } from "./markdown.ts";

function el(tag: string, className?: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

interface BridgeDialogEntry {
	requestId: string;
	overlay: HTMLElement;
}

export class Dialogs {
	private root: HTMLElement;
	private getActiveTabId: () => string;
	/** One bridge dialog per tab; only the active tab's overlay is visible. */
	private bridge = new Map<string, BridgeDialogEntry>();
	/** Cancels a renderer-initiated local dialog when a bridge request preempts it. */
	private cancelLocal: (() => void) | null = null;

	constructor(root: HTMLElement, getActiveTabId: () => string) {
		this.root = root;
		this.getActiveTabId = getActiveTabId;
	}

	// ------------------------------------------------------------------
	// Local (renderer-initiated) dialogs — same overlay, promise-based
	// ------------------------------------------------------------------

	/** Single-line text prompt; resolves undefined on cancel ("" = accepted-empty). */
	promptLocal(title: string, prefill = "", placeholder = ""): Promise<string | undefined> {
		return this.showLocal<string>((box, finish, accept) => {
			const input = el("input", "dialog-input") as HTMLInputElement;
			input.type = "text";
			input.value = prefill;
			input.placeholder = placeholder;
			const buttons = el("div", "dialog-buttons");
			const ok = el("button", "dialog-btn dialog-btn-primary", "OK");
			ok.addEventListener("click", () => finish(input.value.trim()));
			const cancel = el("button", "dialog-btn", "Cancel");
			cancel.addEventListener("click", () => finish(undefined));
			buttons.append(ok, cancel);
			box.append(input, buttons);
			accept(() => finish(input.value.trim()));
			setTimeout(() => input.focus(), 0);
		}, title);
	}

	/** Option list; resolves the chosen id, or undefined on cancel. */
	selectLocal(title: string, items: { id: string; label: string; disabled?: boolean }[]): Promise<string | undefined> {
		return this.showLocal<string>((box, finish) => {
			for (const item of items) {
				const btn = el("button", "dialog-option", item.label);
				if (item.disabled) (btn as HTMLButtonElement).disabled = true;
				btn.addEventListener("click", () => finish(item.id));
				box.append(btn);
			}
			const cancel = el("button", "dialog-btn", "Cancel");
			cancel.addEventListener("click", () => finish(undefined));
			box.append(cancel);
		}, title);
	}

	/** Yes/no ask; false on cancel. */
	confirmLocal(title: string, message: string): Promise<boolean> {
		return this.showLocal((box, finish) => {
			box.append(el("div", "dialog-message", message));
			const buttons = el("div", "dialog-buttons");
			const ok = el("button", "dialog-btn dialog-btn-primary", "OK");
			ok.addEventListener("click", () => finish(true));
			const cancel = el("button", "dialog-btn", "Cancel");
			cancel.addEventListener("click", () => finish(false));
			buttons.append(ok, cancel);
			box.append(buttons);
		}, title).then((value) => value === true);
	}

	private showLocal<T>(render: (box: HTMLElement, finish: (value: T | undefined) => void, accept: (fn: () => void) => void) => void, title: string): Promise<T | undefined> {
		return new Promise((resolve) => {
			// Two locals shouldn't stack; bridge dialogs live in their own overlays.
			this.cancelLocal?.();
			let settled = false;
			let overlay: HTMLElement;
			const finish = (value: T | undefined) => {
				if (settled) return;
				settled = true;
				this.cancelLocal = null;
				overlay.remove();
				resolve(value);
			};
			this.cancelLocal = () => finish(undefined);
			overlay = el("div", "dialog-overlay");
			const box = el("div", "dialog-box");
			box.append(el("div", "dialog-title", title));
			let onAccept: (() => void) | null = null;
			render(box, finish, (fn) => {
				onAccept = fn;
			});
			box.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && onAccept) {
					e.preventDefault();
					onAccept();
				}
			});
			overlay.addEventListener("mousedown", (e) => {
				if (e.target === overlay) finish(undefined);
			});
			overlay.append(box);
			this.root.append(overlay);
		});
	}

	/** Show only the active tab's bridge dialog; a visible bridge dialog outranks a local one. */
	setActiveTab(tabId: string): void {
		for (const [id, entry] of this.bridge) {
			entry.overlay.style.display = id === tabId ? "" : "none";
		}
		if (this.bridge.has(tabId)) this.cancelLocal?.();
	}

	/** Drop a closed tab's overlay; the main process already settled its promise. */
	removeTab(tabId: string): void {
		const entry = this.bridge.get(tabId);
		if (!entry) return;
		entry.overlay.remove();
		this.bridge.delete(tabId);
	}

	/** Tab ids that currently hold a bridge dialog overlay. */
	openTabIds(): string[] {
		return [...this.bridge.keys()];
	}

	handleRequest(request: DialogRequestDTO): void {
		// One bridge dialog per tab; an unexpected duplicate cancels the older one.
		// Dialogs from OTHER tabs are untouched — they wait for their tab to be shown.
		const existing = this.bridge.get(request.tabId);
		if (existing) {
			existing.overlay.remove();
			this.bridge.delete(request.tabId);
			window.pi.respondDialog(existing.requestId, undefined);
		}
		const isActive = request.tabId === this.getActiveTabId();
		if (isActive) {
			// A bridge dialog outranks a renderer-local one.
			this.cancelLocal?.();
		}

		const overlay = el("div", "dialog-overlay");
		if (!isActive) overlay.style.display = "none";
		const box = el("div", "dialog-box");
		box.append(el("div", "dialog-title", request.title));

		const finish = (value: unknown) => {
			overlay.remove();
			if (this.bridge.get(request.tabId)?.requestId === request.requestId) {
				this.bridge.delete(request.tabId);
			}
			window.pi.respondDialog(request.requestId, value);
		};

		switch (request.kind) {
			case "select": {
				for (const option of request.options ?? []) {
					const btn = el("button", "dialog-option", option);
					btn.addEventListener("click", () => finish(option));
					box.append(btn);
				}
				break;
			}
			case "confirm": {
				if (request.message) box.append(el("div", "dialog-message", request.message));
				const buttons = el("div", "dialog-buttons");
				const ok = el("button", "dialog-btn dialog-btn-primary", "OK");
				ok.addEventListener("click", () => finish(true));
				const cancel = el("button", "dialog-btn", "Cancel");
				cancel.addEventListener("click", () => finish(false));
				buttons.append(ok, cancel);
				box.append(buttons);
				break;
			}
			case "planReview": {
				box.classList.add("dialog-box-wide");
				const body = el("div", "dialog-plan-body");
				// The plan is model output — sanitize via the shared markdown pipeline.
				body.innerHTML = renderMarkdownToHtml(request.plan ?? "");
				enhanceCodeBlocks(body);
				const buttons = el("div", "dialog-buttons");
				const approveEdits = el("button", "dialog-btn dialog-btn-primary", "Approve & auto-accept edits");
				approveEdits.title = "Run the plan with permission mode accept-edits (file edits unattended)";
				approveEdits.addEventListener("click", () => finish("approveAcceptEdits"));
				const approveAuto = el("button", "dialog-btn", "Approve & run in auto mode");
				approveAuto.title = "Run the plan with permission mode auto (unclassified actions judged by the model, blocks offered for override)";
				approveAuto.addEventListener("click", () => finish("approveAuto"));
				const approveBypass = el("button", "dialog-btn", "Approve & bypass permissions");
				approveBypass.title = "Run the plan fully automatically (permission mode bypass)";
				approveBypass.addEventListener("click", () => finish("approveBypass"));
				const stay = el("button", "dialog-btn", "Stay in plan mode");
				stay.addEventListener("click", () => finish("stay"));
				buttons.append(approveEdits, approveAuto, approveBypass, stay);
				box.append(body, buttons);
				break;
			}
			case "input":
			case "editor": {
				const input =
					request.kind === "editor"
						? el("textarea", "dialog-input dialog-editor")
						: el("input", "dialog-input");
				if (request.kind === "input") {
					(input as HTMLInputElement).type = "text";
					(input as HTMLInputElement).placeholder = request.placeholder ?? "";
				} else {
					(input as HTMLTextAreaElement).value = request.prefill ?? "";
				}
				const buttons = el("div", "dialog-buttons");
				const ok = el("button", "dialog-btn dialog-btn-primary", "OK");
				const submit = () => finish((input as HTMLInputElement).value || undefined);
				ok.addEventListener("click", submit);
				const cancel = el("button", "dialog-btn", "Cancel");
				cancel.addEventListener("click", () => finish(undefined));
				buttons.append(ok, cancel);
				box.append(input, buttons);
				input.addEventListener("keydown", (e) => {
					if (e.key === "Enter" && request.kind === "input") {
						e.preventDefault();
						submit();
					}
				});
				setTimeout(() => input.focus(), 0);
				break;
			}
		}

		overlay.addEventListener("mousedown", (e) => {
			if (e.target === overlay) finish(undefined);
		});
		overlay.append(box);
		this.root.append(overlay);
		this.bridge.set(request.tabId, { requestId: request.requestId, overlay });
	}

	notify(message: string, type?: string, durationMs = 4000): void {
		notify(message, type, durationMs);
	}
}

/** Transient toast (top-center); standalone so any module can notify without a Dialogs instance. */
export function notify(message: string, type?: string, durationMs = 4000): void {
	const toast = el("div", `toast toast-${type ?? "info"}`, message);
	document.body.append(toast);
	setTimeout(() => toast.classList.add("toast-show"), 10);
	setTimeout(() => {
		toast.classList.remove("toast-show");
		setTimeout(() => toast.remove(), 300);
	}, durationMs);
}
