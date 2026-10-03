/**
 * Profile form modal: creates and edits pi-plus profiles. Opened from the
 * Settings panel and reused by the delete flow (with confirm).
 *
 * The form exposes five fields (name, provider, model IDs, API key, base URL)
 * and a provider-login path: `Sign in` runs the SDK's interactive login
 * (OAuth when the provider offers it, else api-key setup) against the
 * profile's agent dir without saving the profile — a draft only gets the dir
 * (dropped if the form closes unsaved), and once a login is in place the API
 * key and base URL are ignored on save, because the credential lives in
 * auth.json and a stored token would overwrite it during materialization.
 */

import type { AuthPromptDTO, ProfileAuthStatusDTO, ProfileDTO } from "../../shared/ipc-types.ts";

function el(tag: string, className?: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

const PROVIDERS = [
	"anthropic", "openai", "google", "deepseek", "openrouter", "moonshotai", "moonshotai-cn",
	"kimi-coding", "zai", "zai-coding-cn", "xai", "groq", "mistral", "minimax", "minimax-cn",
	"qwen-token-plan", "xiaomi", "nvidia", "cerebras", "fireworks", "together", "amazon-bedrock",
	"azure-openai-responses", "cloudflare-ai-gateway", "huggingface", "opencode", "vercel-ai-gateway",
];

/** Parsed model list; rejects the >3 case the SDK's addProfileModel enforces. */
function parseModels(raw: string, errorRow: HTMLElement): string[] | null {
	const models = raw
		.split(",")
		.map((model) => model.trim())
		.filter(Boolean);
	if (models.length > 3) {
		errorRow.textContent = "A profile can have at most 3 models.";
		return null;
	}
	return models;
}

/** Renderer-side message for a rejected `ipcRenderer.invoke`: strip Electron's
 *  "Error invoking remote method '…': " wrapper so hints/Errors show the
 *  main-process reason only. */
function errText(err: unknown): string {
	const message = String((err as Error)?.message ?? err);
	return message.replace(/^Error invoking remote method '[^']+':\s+(?:Error:\s*)?/, "");
}

/**
 * Which profile dir a login has already put credentials into: true when the
 * materialized auth.json holds an entry for the profile's provider and the
 * profile itself stores no API key (a stored key wins over the login file).
 */
function loggedInAlready(profile: ProfileDTO, status: ProfileAuthStatusDTO): boolean {
	if (profile.hasToken) return false;
	const provider = profile.provider;
	if (!provider) return false;
	return status.providers.some((entry) => entry.id === provider);
}

interface FormState {
	loggedIn: boolean;
	/** Name the profile is stored under once created (or pre-existing on edit). */
	savedName?: string;
	/** Login flow running; Save/Login blocked, Cancel offered. */
	loginRunning: boolean;
}

export class ProfileForm {
	private root: HTMLElement;

	constructor(root: HTMLElement) {
		this.root = root;
	}

	/** Create flow: name + fields; resolves when closed. */
	openCreate(): void {
		this.openForm({ title: "New Profile", existing: undefined });
	}

	openEdit(name: string): void {
		void Promise.all([window.pi.listProfiles(), window.pi.getProfileAuthStatus(name)])
			.then(([data, status]) => {
				const profile = data.profiles[name];
				if (!profile) {
					this.alert(`Profile '${name}' no longer exists.`);
					return;
				}
				this.openForm({ title: `Edit Profile: ${name}`, existing: { name, profile }, authStatus: status });
			})
			.catch((err) => this.alert(errText(err)));
	}

	openDelete(name: string): void {
		const overlay = this.shell(`Delete Profile: ${name}?`);
		const box = overlay.box;
		box.append(el("div", "dialog-message", `This removes the profile and its materialized agent dir at ~/.pi/pi-hub/profiles/${name}. Sessions are shared and stay intact.`));
		const buttons = el("div", "dialog-buttons");
		const del = el("button", "dialog-btn dialog-btn-danger", "Delete");
		del.addEventListener("click", () => {
			overlay.dismiss();
			void window.pi.removeProfile(name).catch((err) => this.alert(errText(err)));
		});
		const cancel = el("button", "dialog-btn", "Cancel");
		cancel.addEventListener("click", () => overlay.dismiss());
		buttons.append(del, cancel);
		box.append(buttons);
	}

	private openForm(opts: {
		title: string;
		existing?: { name: string; profile: ProfileDTO };
		authStatus?: ProfileAuthStatusDTO;
	}): void {
		const { overlay, box, dismiss } = this.shell(opts.title);
		const state: FormState = {
			loggedIn: opts.existing !== undefined && opts.authStatus !== undefined && loggedInAlready(opts.existing.profile, opts.authStatus),
			savedName: opts.existing?.name,
			loginRunning: false,
		};

		// ---- Identity ----
		box.append(el("div", "settings-section-title", "Identity"));

		const nameRow = el("label", "form-row");
		nameRow.append(el("span", "form-label", "Name"));
		const nameInput = el("input", "form-input") as HTMLInputElement;
		nameInput.placeholder = "my-profile";
		if (opts.existing) {
			nameInput.value = opts.existing.name;
			// Profiles are keyed by name in profiles.json; renaming lives in the
			// SDK (renameProfile) and is not exposed here.
			nameInput.disabled = true;
			nameInput.title = "Names cannot be changed from this form";
		}
		nameRow.append(nameInput);
		box.append(nameRow);

		const providerRow = el("label", "form-row");
		providerRow.append(el("span", "form-label", "Provider"));
		const providerInput = el("select", "form-input") as HTMLSelectElement;
		providerInput.append(new Option("(inherit default)", ""));
		for (const p of PROVIDERS) providerInput.append(new Option(p, p));
		providerInput.value = opts.existing?.profile.provider ?? "";
		providerRow.append(providerInput);
		box.append(providerRow);

		// ---- Models ----
		box.append(el("div", "settings-section-title", "Models"));

		const modelRow = el("label", "form-row");
		modelRow.append(el("span", "form-label", "Model IDs"));
		const modelInput = el("input", "form-input") as HTMLInputElement;
		modelInput.placeholder = "comma-separated — first is the default";
		modelInput.value = opts.existing?.profile.model ?? opts.existing?.profile.models?.join(", ") ?? "";
		modelRow.append(modelInput);
		box.append(modelRow);

		// ---- Credentials: API key / base URL  or  provider sign-in ----
		box.append(el("div", "settings-section-title", "Credentials"));

		const credentials = el("div", "form-credentials");
		const manualCol = el("div", "form-credentials-col");
		manualCol.append(el("div", "form-credentials-label", "API key"));

		const tokenInput = el("input", "form-input") as HTMLInputElement;
		tokenInput.type = "password";
		tokenInput.placeholder = opts.existing?.profile.hasToken ? "(stored — type to replace, 'clear' to remove)" : "API key (optional)";
		manualCol.append(tokenInput);

		const urlInput = el("input", "form-input") as HTMLInputElement;
		urlInput.placeholder = "https://… (base URL override, optional)";
		urlInput.value = opts.existing?.profile.url ?? "";
		manualCol.append(urlInput);

		const orBadge = el("div", "form-or", "or");

		const loginCol = el("div", "form-credentials-col");
		loginCol.append(el("div", "form-credentials-label", "Provider sign-in"));

		const loginRow = el("div", "form-login-row");
		const loginBtn = el("button", "dialog-btn dialog-btn-login", "Sign in with provider") as HTMLButtonElement;
		const loginCancel = el("button", "dialog-btn form-login-cancel", "Cancel") as HTMLButtonElement;
		loginCancel.hidden = true;
		loginRow.append(loginBtn, loginCancel);
		loginCol.append(loginRow);

		const loginHint = el("div", "form-login-hint");
		loginCol.append(loginHint);

		credentials.append(manualCol, orBadge, loginCol);
		box.append(credentials);

		const errorRow = el("div", "form-error");
		box.append(errorRow);

		const buttons = el("div", "dialog-buttons");
		const save = el("button", "dialog-btn dialog-btn-primary", state.savedName ? "Save" : "Create") as HTMLButtonElement;
		const cancel = el("button", "dialog-btn", "Cancel");
		buttons.append(save, cancel);
		box.append(buttons);

		// ---- State application ----

		/** Reflect the login state onto the manual-credential fields. */
		const applyLoggedIn = () => {
			tokenInput.disabled = state.loggedIn;
			urlInput.disabled = state.loggedIn;
			if (state.loggedIn) {
				tokenInput.value = "";
				urlInput.value = "";
				const provider = providerInput.value || "provider";
				setHint(`Signed in via ${provider} — API key and Base URL are ignored.`, "ok");
			}
		};

		const setHint = (message: string, tone?: "ok" | "err"): void => {
			loginHint.textContent = message;
			loginHint.classList.toggle("form-login-hint-ok", tone === "ok");
			loginHint.classList.toggle("form-login-hint-err", tone === "err");
		};

		const setRunning = (running: boolean): void => {
			state.loginRunning = running;
			loginBtn.disabled = running;
			save.disabled = running;
			loginCancel.hidden = !running;
		};

		const buildProfile = (): ProfileDTO | null => {
			const models = parseModels(modelInput.value, errorRow);
			if (models === null) return null;
			const profile: ProfileDTO = {};
			if (providerInput.value) profile.provider = providerInput.value;
			if (models.length > 0) {
				profile.models = models;
				profile.model = models[0];
			}
			// Fields the form no longer exposes are carried over: updateProfile
			// replaces the whole profile server-side.
			const existing = opts.existing?.profile;
			if (existing?.thinking) profile.thinking = existing.thinking;
			if (existing?.settings) profile.settings = { ...existing.settings };
			if (state.loggedIn) {
				// Login way: token cleared ("" so main keeps it out of auth.json and
				// never overwrites the OAuth entry), url omitted entirely.
				profile.token = "";
			} else {
				const token = tokenInput.value;
				if (token === "clear") profile.token = "";
				else if (token) profile.token = token;
				if (urlInput.value.trim()) profile.url = urlInput.value.trim();
			}
			return profile;
		};

		// ---- Provider login ----

		let unsubscribe: (() => void) | null = null;
		/** Name the running (or last attempted) login targets. */
		let loginTargetName: string | null = null;
		/** Draft names whose agent dirs main created for sign-in attempts. */
		const draftTargets = new Set<string>();

		const runLogin = async (): Promise<void> => {
			errorRow.textContent = "";
			if (!providerInput.value) {
				errorRow.textContent = "Select a provider first.";
				return;
			}
			// Sign-in never persists the profile: the provider comes straight
			// from the form, and main runs the flow against the profile dir
			// (a draft dir is created on the spot and removed if the form
			// closes unsaved). Save later adopts the credential auth.json holds.
			const target = state.savedName ?? nameInput.value.trim();
			if (!target) {
				errorRow.textContent = "Name is required.";
				return;
			}
			loginTargetName = target;
			if (!state.savedName) draftTargets.add(target);

			setRunning(true);
			setHint("Waiting for the sign-in flow…");
			try {
				unsubscribe?.();
				unsubscribe = subscribeAuth(target, {
					onPrompt: (prompt) => this.showAuthPrompt(prompt),
					onPromptCancel: (requestId) => this.dismissAuthPrompt(requestId),
					onNotify: (note) => setHint(note.message),
				});
				await window.pi.loginProfile(target, providerInput.value);
				state.loggedIn = true;
				if (!state.savedName) {
					// auth.json now belongs to this name — lock it.
					nameInput.disabled = true;
					nameInput.title = "Signed-in profile name cannot change until saved";
				}
				applyLoggedIn();
			} catch (err) {
				setHint(errText(err), "err");
			} finally {
				unsubscribe?.();
				unsubscribe = null;
				setRunning(false);
			}
		};

		loginBtn.addEventListener("click", () => void runLogin());
		loginCancel.addEventListener("click", () => {
			if (loginTargetName) void window.pi.abortLogin(loginTargetName).catch(() => undefined);
		});

		// ---- Save ----

		save.addEventListener("click", () => {
			errorRow.textContent = "";
			if (!nameInput.value.trim()) {
				errorRow.textContent = "Name is required.";
				return;
			}
			const profile = buildProfile();
			if (!profile) return;
			const saved = state.savedName;
			const name = nameInput.value.trim();
			const action = saved === undefined ? window.pi.createProfile(name, profile) : window.pi.updateProfile(saved, profile);
			action
				.then(() => {
					// Mark adopted before close() so draft dirs are not culled.
					if (saved === undefined) state.savedName = name;
					close();
				})
				.catch((err) => {
					errorRow.textContent = errText(err);
				});
		});

		cancel.addEventListener("click", () => close());
		overlay.addEventListener("mousedown", (e) => {
			if (e.target === overlay) close();
		});

		/** Closing while a flow runs aborts it so main never waits on nothing. */
		const close = (): void => {
			if (state.loginRunning && loginTargetName) void window.pi.abortLogin(loginTargetName).catch(() => undefined);
			unsubscribe?.();
			unsubscribe = null;
			dismiss();
			// A never-saved form's draft agent dirs (login attempts) are dropped;
			// main double-checks the profile is unstored before removing.
			if (!state.savedName) {
				for (const draft of draftTargets) void window.pi.cleanProfileDir(draft).catch(() => undefined);
				draftTargets.clear();
			}
		};

		if (state.loggedIn) applyLoggedIn();
	}

	/** Modal host: the overlay is removed via `dismiss` (no global teardown, so
	 *  login prompt modals can stack alongside the form). */
	private shell(title: string): { overlay: HTMLElement; box: HTMLElement; dismiss: () => void } {
		const overlay = el("div", "dialog-overlay");
		const box = el("div", "dialog-box dialog-form");
		box.append(el("div", "dialog-title", title));
		overlay.append(box);
		this.root.append(overlay);
		return { overlay, box, dismiss: () => overlay.remove() };
	}

	/** Prompt modals opened by the login flow, keyed by requestId. */
	private readonly promptBoxes = new Map<string, HTMLElement>();

	private showAuthPrompt(prompt: AuthPromptDTO): void {
		this.dismissAuthPrompt(prompt.requestId);
		const overlay = el("div", "dialog-overlay");
		const box = el("div", "dialog-box dialog-form auth-prompt-box");
		box.append(el("div", "dialog-title", "Provider sign-in"));
		box.append(el("div", "dialog-message", prompt.message));

		const respond = (value: string | null): void => {
			this.promptBoxes.delete(prompt.requestId);
			overlay.remove();
			window.pi.respondAuthPrompt(prompt.requestId, value);
		};

		if (prompt.type === "select") {
			for (const option of prompt.options ?? []) {
				const label = option.description ? `${option.label} — ${option.description}` : option.label;
				const item = el("button", "dialog-option", label);
				item.addEventListener("click", () => respond(option.id));
				box.append(item);
			}
			// A select has no free-text input, so give it an explicit cancel.
			const buttons = el("div", "dialog-buttons");
			const cancel = el("button", "dialog-btn", "Cancel");
			cancel.addEventListener("click", () => respond(null));
			buttons.append(cancel);
			box.append(buttons);
		} else {
			const input = el("input", "form-input") as HTMLInputElement;
			input.placeholder = prompt.placeholder ?? "";
			if (prompt.type === "secret") input.type = "password";
			const submit = (): void => {
				const value = input.value.trim();
				if (!value) return;
				respond(value);
			};
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") submit();
				if (e.key === "Escape") respond(null);
			});
			box.append(input);
			const buttons = el("div", "dialog-buttons");
			const ok = el("button", "dialog-btn dialog-btn-primary", "Submit");
			ok.addEventListener("click", submit);
			const cancel = el("button", "dialog-btn", "Cancel");
			cancel.addEventListener("click", () => respond(null));
			buttons.append(ok, cancel);
			box.append(buttons);
		}
		overlay.append(box);
		this.root.append(overlay);
		this.promptBoxes.set(prompt.requestId, overlay);
		if (prompt.type !== "select") (box.querySelector("input") as HTMLInputElement | null)?.focus();
	}

	private dismissAuthPrompt(requestId: string): void {
		const overlay = this.promptBoxes.get(requestId);
		if (!overlay) return;
		this.promptBoxes.delete(requestId);
		overlay.remove();
	}

	private alert(message: string): void {
		const { overlay, box, dismiss } = this.shell("pi-plus-desktop");
		box.append(el("div", "dialog-message", message));
		const buttons = el("div", "dialog-buttons");
		const ok = el("button", "dialog-btn dialog-btn-primary", "OK");
		ok.addEventListener("click", () => dismiss());
		buttons.append(ok);
		box.append(buttons);
	}
}

/** Subscribe to the bridged login channels for one profile. Returns cleanup. */
function subscribeAuth(
	name: string,
	handlers: {
		onPrompt: (prompt: AuthPromptDTO) => void;
		onPromptCancel: (requestId: string) => void;
		onNotify: (note: { name: string; message: string }) => void;
	},
): () => void {
	const subs = [
		window.pi.onAuthPrompt((prompt) => {
			if (prompt.name === name) handlers.onPrompt(prompt);
		}),
		window.pi.onAuthPromptCancel((msg) => handlers.onPromptCancel(msg.requestId)),
		window.pi.onAuthNotify((note) => {
			if (note.name === name) handlers.onNotify(note);
		}),
	];
	return () => {
		for (const unsubscribe of subs) unsubscribe();
	};
}
