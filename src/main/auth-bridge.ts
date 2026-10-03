/**
 * Bridges pi-plus-sdk's interactive provider login (loginProvider's
 * AuthInteraction) to the Settings window. The SDK prompts here are forwarded
 * as authPrompt pushes and answered via auth:respond; auth URLs and
 * device-code verification pages are opened from the main process so
 * credential-bearing links never round-trip through renderer-constructed
 * strings. Unlike DialogBridge there is no per-request timeout: an OAuth
 * handoff legitimately waits minutes on the browser, so liveness is bounded
 * by explicit cancels instead (form close, user Cancel button, window closed).
 */

import "./sdk-shim.ts";
import { randomUUID } from "node:crypto";
import { shell, type WebContents } from "electron";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "pi-plus-sdk";
import { IPC, type AuthNotifyDTO, type AuthPromptDTO } from "../shared/ipc-types.ts";
import type { ProfileStore } from "./profiles.ts";

// Same shim-first dynamic import as profiles.ts / session-host.ts.
const sdk = await import("pi-plus-sdk");
const { loginProvider } = sdk;

interface PendingPrompt {
	name: string;
	resolve: (value: string) => void;
	reject: (err: Error) => void;
}

export class LoginBridge {
	private pending = new Map<string, PendingPrompt>();
	/** Running login flows keyed by profile name (one flow per profile). */
	private flows = new Map<string, AbortController>();

	constructor(
		private getSettingsWebContents: () => WebContents | undefined,
		private profileStore: ProfileStore,
	) {}

	/**
	 * Run a profile's provider login to completion. Resolves once a credential
	 * is persisted to the profile dir's auth.json; rejects on cancel/SDK error.
	 * Always settles — pending prompts are never left dangling.
	 */
	async login(name: string, providerArg?: string): Promise<void> {
		if (this.flows.has(name)) throw new Error(`Login already in progress for '${name}'.`);
		const { agentDir, provider } = this.profileStore.loginTarget(name, providerArg);
		const controller = new AbortController();
		this.flows.set(name, controller);
		const interaction: AuthInteraction = {
			prompt: (prompt) => this.prompt(name, prompt),
			notify: (event) => this.notify(name, event),
		};
		const operation = loginProvider(provider, { agentDir, signal: controller.signal, interaction });
		// Never let the invoke hang the UI: cancel() wins the race even if a
		// provider flow ignores the abort signal; the detached operation only
		// logs (a credential that lands later is honored by authStatus on reopen).
		operation.catch((err) => {
			if (!controller.signal.aborted) console.warn(`[auth] login flow failed for '${name}'`, err);
		});
		const cancelled = new Promise<never>((_, reject) => {
			controller.signal.addEventListener("abort", () => reject(new Error("Login cancelled")), { once: true });
		});
		try {
			await Promise.race([operation, cancelled]);
		} finally {
			this.flows.delete(name);
			this.dropPendingFor(name);
		}
	}

	/** Answer a bridged prompt; value null rejects it as cancelled. Late
	 *  answers for unknown ids are ignored (the flow already moved on). */
	respond(requestId: string, value: string | null): void {
		const entry = this.pending.get(requestId);
		if (!entry) return;
		this.pending.delete(requestId);
		if (value === null) entry.reject(new Error("Login cancelled"));
		else entry.resolve(value);
	}

	/** Abort the running flow for a profile and settle its pending prompts. */
	cancel(name: string): void {
		this.flows.get(name)?.abort();
		this.dropPendingFor(name);
	}

	/** Settings window closed mid-login: abort everything it could answer. */
	cancelAll(): void {
		for (const controller of this.flows.values()) controller.abort();
		this.flows.clear();
		for (const [requestId, entry] of [...this.pending]) {
			this.pending.delete(requestId);
			entry.reject(new Error("Login cancelled (settings window closed)"));
		}
	}

	/**
	 * Forward one AuthPrompt to the Settings window. Honors the per-prompt
	 * abort signal (the SDK races e.g. manual-code entry against the loopback
	 * callback: when the callback wins, the prompt is rejected here and the
	 * renderer is told to dismiss its stale modal silently).
	 */
	private prompt(name: string, prompt: AuthPrompt): Promise<string> {
		const webContents = this.getSettingsWebContents();
		if (!webContents || webContents.isDestroyed()) return Promise.reject(new Error("Login cancelled (no settings window)."));
		const requestId = randomUUID();
		return new Promise<string>((resolve, reject) => {
			const onAbort = () => {
				if (!this.pending.delete(requestId)) return;
				webContents.send(IPC.push.authPromptCancel, { requestId });
				reject(new Error("Login cancelled"));
			};
			const settle = (fn: () => void) => {
				prompt.signal?.removeEventListener("abort", onAbort);
				fn();
			};
			this.pending.set(requestId, {
				name,
				resolve: (value) => settle(() => resolve(value)),
				reject: (err) => settle(() => reject(err)),
			});
			if (prompt.signal) {
				if (prompt.signal.aborted) {
					onAbort();
					return;
				}
				prompt.signal.addEventListener("abort", onAbort, { once: true });
			}
			webContents.send(IPC.push.authPrompt, toPromptDTO(name, requestId, prompt));
		});
	}

	/** Forward one AuthEvent as a status line; open its URL externally. */
	private notify(name: string, event: AuthEvent): void {
		let message = "";
		let url: string | undefined;
		switch (event.type) {
			case "info":
				message = event.links?.length ? `${event.message} (${event.links.map((link) => link.label ?? link.url).join(", ")})` : event.message;
				break;
			case "auth_url":
				url = event.url;
				message = event.instructions ?? "Complete the sign-in in your browser.";
				break;
			case "device_code":
				url = event.verificationUri;
				message = `Enter code ${event.userCode} at ${event.verificationUri}`;
				break;
			case "progress":
				message = event.message;
				break;
		}
		if (url) this.openExternal(url);
		const webContents = this.getSettingsWebContents();
		if (webContents && !webContents.isDestroyed()) {
			const dto: AuthNotifyDTO = { name, type: event.type, message, url };
			webContents.send(IPC.push.authNotify, dto);
		}
	}

	private dropPendingFor(name: string): void {
		for (const [requestId, entry] of [...this.pending]) {
			if (entry.name !== name) continue;
			this.pending.delete(requestId);
			entry.reject(new Error("Login cancelled"));
		}
	}

	/** Open only http(s) links; device-code URIs can be bare hosts. */
	private openExternal(url: string): void {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return;
		}
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
		void shell.openExternal(url).catch((err) => console.warn("[auth] openExternal failed", err));
	}
}

function toPromptDTO(name: string, requestId: string, prompt: AuthPrompt): AuthPromptDTO {
	const base = { requestId, name, type: prompt.type, message: prompt.message };
	if (prompt.type === "select") {
		return { ...base, options: prompt.options.map(({ id, label, description }) => ({ id, label, description })) };
	}
	return { ...base, placeholder: prompt.placeholder };
}
