/**
 * Bridges the SDK's PlusUIDialogHandlers (used by extensions such as ask_user)
 * to modal dialogs in the renderer. Requests are serialized per tab, time out
 * after five minutes, and resolve as cancelled when their tab closes — the
 * extension flow in the main process always settles, never hangs.
 */

import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import type { PlusUIDialogHandlers } from "pi-plus-sdk";
import { IPC, type DialogKind, type DialogRequestDTO } from "../shared/ipc-types.ts";

const DIALOG_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingDialog {
	tabId: string;
	resolve: (value: unknown) => void;
	timer: NodeJS.Timeout;
}

export class DialogBridge {
	private pending = new Map<string, PendingDialog>();
	/** Tail of the per-tab serialization chain. */
	private tabChains = new Map<string, Promise<void>>();

	constructor(private getWebContents: (tabId: string) => WebContents | undefined) {}

	private enqueue<T>(tabId: string, kind: DialogKind, params: Omit<DialogRequestDTO, "tabId" | "requestId" | "kind">): Promise<T> {
		const run = async (): Promise<T> => {
			const webContents = this.getWebContents(tabId);
			if (!webContents || webContents.isDestroyed()) return undefined as T;

			const requestId = randomUUID();
			const request: DialogRequestDTO = { tabId, requestId, kind, ...params };

			const result = new Promise<T>((resolve) => {
				const timer = setTimeout(() => {
					this.pending.delete(requestId);
					resolve(undefined as T);
				}, DIALOG_TIMEOUT_MS);
				this.pending.set(requestId, { tabId, resolve: resolve as (value: unknown) => void, timer });
			});

			webContents.send(IPC.push.dialogRequest, request);
			return result;
		};

		// Serialize per tab: extensions can ask several questions in sequence.
		const chain = this.tabChains.get(tabId) ?? Promise.resolve();
		const next = chain.then(run, run);
		this.tabChains.set(tabId, next.then(() => undefined, () => undefined));
		return next;
	}

	handlersFor(tabId: string): PlusUIDialogHandlers {
		return {
			select: (title, options) => this.enqueue<string | undefined>(tabId, "select", { title, options }),
			confirm: async (title, message) => {
				const answer = await this.enqueue<boolean | undefined>(tabId, "confirm", { title, message });
				return answer === true;
			},
			input: (title, placeholder) => this.enqueue<string | undefined>(tabId, "input", { title, placeholder }),
			editor: (title, prefill) => this.enqueue<string | undefined>(tabId, "editor", { title, prefill }),
			notify: (message, type) => {
				const webContents = this.getWebContents(tabId);
				if (webContents && !webContents.isDestroyed()) {
					webContents.send(IPC.push.dialogNotify, { message, type });
				}
			},
		};
	}

	/** Called from the renderer's dialog:respond handler. */
	respond(requestId: string, value: unknown): void {
		const dialog = this.pending.get(requestId);
		if (!dialog) return;
		clearTimeout(dialog.timer);
		this.pending.delete(requestId);
		dialog.resolve(value);
	}

	/** Resolve every pending dialog for a tab as cancelled (tab closed). */
	cancelForTab(tabId: string): void {
		for (const [requestId, dialog] of this.pending) {
			if (dialog.tabId !== tabId) continue;
			clearTimeout(dialog.timer);
			this.pending.delete(requestId);
			dialog.resolve(undefined);
		}
		this.tabChains.delete(tabId);
	}
}
