/**
 * Renderer-side dialogs: renders modal select/confirm/input/editor requests
 * from the main process (extension ask_user flows) and answers via
 * dialog:respond. Esc and backdrop close resolve as cancelled. The
 * promptLocal/selectLocal/confirmLocal helpers render the same overlay for
 * renderer-initiated asks (rename, fork pickers, compaction instructions).
 */

import type { DialogRequestDTO } from "../../shared/ipc-types.ts";
import { renderMarkdownToHtml } from "./markdown.ts";

function el(tag: string, className?: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

export class Dialogs {
	private root: HTMLElement;
	private current: { requestId: string; resolve: (value: unknown) => void } | null = null;
	/** Cancels a renderer-initiated local dialog when a bridge request preempts it. */
	private cancelLocal: (() => void) | null = null;

	constructor(root: HTMLElement) {
		this.root = root;
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
			// A bridge request can't preempt this, but two locals shouldn't stack.
			this.cancelLocal?.();
			this.root.replaceChildren();
			let settled = false;
			const finish = (value: T | undefined) => {
				if (settled) return;
				settled = true;
				this.cancelLocal = null;
				this.root.replaceChildren();
				resolve(value);
			};
			this.cancelLocal = () => finish(undefined);
			const overlay = el("div", "dialog-overlay");
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

	handleRequest(request: DialogRequestDTO): void {
		// Only one modal at a time; unexpected extras resolve as cancelled.
		if (this.current) {
			window.pi.respondDialog(this.current.requestId, undefined);
			this.current = null;
		}
		// A bridge dialog outranks a renderer-local one.
		this.cancelLocal?.();
		this.root.replaceChildren();

		const overlay = el("div", "dialog-overlay");
		const box = el("div", "dialog-box");
		box.append(el("div", "dialog-title", request.title));

		const finish = (value: unknown) => {
			this.root.replaceChildren();
			this.current = null;
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
				const buttons = el("div", "dialog-buttons");
				const approveEdits = el("button", "dialog-btn dialog-btn-primary", "Approve & auto-accept edits");
				approveEdits.title = "Run the plan with permission mode accept-edits (file edits unattended)";
				approveEdits.addEventListener("click", () => finish("approveAcceptEdits"));
				const approveBypass = el("button", "dialog-btn", "Approve & bypass permissions");
				approveBypass.title = "Run the plan fully automatically (permission mode bypass)";
				approveBypass.addEventListener("click", () => finish("approveBypass"));
				const edit = el("button", "dialog-btn", "Edit plan");
				edit.addEventListener("click", () => finish("edit"));
				const stay = el("button", "dialog-btn", "Stay in plan mode");
				stay.addEventListener("click", () => finish("stay"));
				buttons.append(approveEdits, approveBypass, edit, stay);
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
		this.current = { requestId: request.requestId, resolve: finish };
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
