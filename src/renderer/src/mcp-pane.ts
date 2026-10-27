/**
 * Settings → MCP pane: the desktop front end for the SDK's MCP API, served by
 * src/main/mcp.ts. One merged view of the two files pi loads — the selected
 * profile's (or the base agent dir's) global `mcp.json` and an optional
 * project's `.pi/mcp.json`, whose same-named entries override the global ones.
 *
 * The pane only ever paints what main returned: add / edit (raw JSON with live
 * `validateMcpServer` feedback), enable / disable, exposure, connection check,
 * OAuth sign in / out, remove, and the stored-credential summary. Config
 * crosses IPC **raw** — `${VAR}` and `!cmd` templates are shown and written as
 * spelled (pi expands them only when a server connects) and credentials carry
 * no secret material. Every mutation resolves to a fresh snapshot, so a row is
 * never left displaying a state the disk disagrees with.
 */

import type {
	McpCheckResultDTO,
	McpCredentialDTO,
	McpServerDTO,
	McpSnapshotDTO,
	McpStatusDTO,
	McpTargetDTO,
	ProfilesDataDTO,
} from "../../shared/ipc-types.ts";
import { notify } from "./dialogs.ts";

function el(tag: string, className?: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

const errText = (err: unknown): string => String((err as Error)?.message ?? err);

/** Server-level exposure values pi accepts (the SDK's default is "codemode"). */
const EXPOSURES = ["codemode", "deferred", "direct", "hidden"];

export function buildMcpPane(): HTMLElement {
	const pane = el("div", "settings-pane");

	const state = {
		/** "" = base agent dir (~/.pi/agent) — the one `pipi` uses. */
		profile: "",
		/** "" = no project file participates in the view. */
		cwd: "",
		/** true = writes go to <cwd>/.pi/mcp.json instead of the agent dir. */
		local: false,
		snapshot: null as McpSnapshotDTO | null,
		statuses: null as Record<string, McpStatusDTO> | null,
		credentials: [] as McpCredentialDTO[],
		checking: false,
		/** Server with an in-flight row action (its buttons go dead meanwhile). */
		busy: "",
	};
	let profiles: ProfilesDataDTO | null = null;

	const profileSelect = el("select", "form-input mcp-profile") as HTMLSelectElement;
	const cwdInput = el("input", "form-input mcp-cwd") as HTMLInputElement;
	cwdInput.placeholder = "Project directory (optional)";
	const localCheck = el("input") as HTMLInputElement;
	localCheck.type = "checkbox";
	const scopeLabel = el("label", "mcp-scope");
	scopeLabel.append(localCheck, document.createTextNode(" write to project file"));
	scopeLabel.title = "Unchecked: writes go to the agent dir's mcp.json";
	const pathsEl = el("div", "settings-caption mcp-paths");
	const noteEl = el("div", "settings-hint mcp-note");
	const errorsEl = el("div", "form-error mcp-errors");
	const listEl = el("div", "mcp-list");
	const credsEl = el("div", "mcp-creds");
	const checkBtn = el("button", "dialog-btn", "Check connections") as HTMLButtonElement;
	const addBtn = el("button", "dialog-btn dialog-btn-primary", "Add server") as HTMLButtonElement;
	const browseBtn = el("button", "dialog-btn", "Browse…") as HTMLButtonElement;
	const reloadBtn = el("button", "dialog-btn", "⟳") as HTMLButtonElement;

	/** What the pane is pointed at. A cwd is only sent when one was picked:
	 *  omitted, the SDK falls back to process.cwd() — "/" in a packaged app. */
	function target(): McpTargetDTO {
		const value: McpTargetDTO = {};
		if (state.profile) value.profile = state.profile;
		if (state.cwd) value.cwd = state.cwd;
		// The project file needs a project; never write relative to nothing.
		if (state.local && state.cwd) value.local = true;
		return value;
	}

	function option(value: string, label: string, selected: boolean): HTMLOptionElement {
		const node = el("option", undefined, label) as HTMLOptionElement;
		node.value = value;
		node.selected = selected;
		return node;
	}

	function pill(text: string, cls = ""): HTMLElement {
		return el("span", `mcp-pill${cls ? ` ${cls}` : ""}`, text);
	}

	/** Live pill from the last Check run — "not checked" until one has run. */
	function statusPill(name: string): HTMLElement {
		const status = state.statuses?.[name];
		if (!status) return pill("not checked", "mcp-state-none");
		const node = pill(
			status.error ? `${status.state} · error` : `${status.state} · ${status.tools.length} tools`,
			`mcp-state-${status.state}`,
		);
		node.title = status.error ?? (status.tools.length ? status.tools.join("\n") : "");
		return node;
	}

	async function refresh(): Promise<void> {
		try {
			state.snapshot = await window.pi.mcpSnapshot(target());
		} catch (err) {
			state.snapshot = null;
			notify(`MCP: ${errText(err)}`, "error");
		}
		// A malformed mcp-auth.json must not hide the server list, so credentials
		// are read on their own terms.
		try {
			state.credentials = await window.pi.mcpCredentials(target());
		} catch (err) {
			state.credentials = [];
			console.warn("[settings] MCP credential list failed", err);
		}
		render();
	}

	async function runCheck(): Promise<void> {
		if (state.checking) return;
		state.checking = true;
		render();
		let result: McpCheckResultDTO | null = null;
		try {
			result = await window.pi.mcpCheck(target());
		} catch (err) {
			notify(`MCP check failed: ${errText(err)}`, "error");
		}
		state.checking = false;
		if (!result) return;
		state.statuses = Object.fromEntries(result.statuses.map((status) => [status.name, status]));
		render();
		for (const error of result.errors) notify(`MCP: ${error}`, "warning");
	}

	function isSnapshot(value: unknown): value is McpSnapshotDTO {
		return typeof value === "object" && value !== null && Array.isArray((value as { servers?: unknown }).servers);
	}

	/** One mutation: mark the row busy, apply it, paint the snapshot it returns. */
	async function action(name: string, run: () => Promise<unknown>): Promise<void> {
		if (state.busy) return;
		state.busy = name;
		render();
		try {
			const result = await run();
			if (isSnapshot(result)) state.snapshot = result;
			else await refresh();
		} catch (err) {
			notify(`MCP: ${errText(err)}`, "error");
			// A failure can still have touched the file (a rejected write, an
			// aborted sign-in) — repaint from disk, not from optimism.
			await refresh();
		}
		state.busy = "";
		render();
	}

	function render(): void {
		// Profile names arrive asynchronously and change as profiles are edited,
		// so the selector is rebuilt only when its contents actually differ.
		const names = Object.keys(profiles?.profiles ?? {}).sort((a, b) => a.localeCompare(b));
		const signature = `${names.join(",")}|${profiles?.default ?? ""}|${state.profile}`;
		if (profileSelect.dataset.signature !== signature) {
			profileSelect.dataset.signature = signature;
			profileSelect.replaceChildren(
				option("", "Base agent dir (~/.pi/agent)", state.profile === ""),
				...names.map((name) =>
					option(name, name === profiles?.default ? `Profile: ${name} · default` : `Profile: ${name}`, name === state.profile),
				),
			);
		}
		if (cwdInput.value !== state.cwd) cwdInput.value = state.cwd;
		localCheck.checked = state.local && Boolean(state.cwd);
		localCheck.disabled = !state.cwd;
		scopeLabel.title = state.cwd ? scopeLabel.title : "Pick a project directory first";
		checkBtn.disabled = state.checking;
		checkBtn.textContent = state.checking ? "Checking…" : "Check connections";

		const snap = state.snapshot;
		pathsEl.replaceChildren();
		if (snap) {
			const writingProject = state.local && state.cwd;
			pathsEl.append(
				el("span", "mcp-path", `global: ${snap.paths.global}`),
				openFileBtn(snap.paths.global),
				el("span", "mcp-path", `project: ${snap.paths.project}${writingProject ? " (writes here)" : ""}`),
				openFileBtn(snap.paths.project),
			);
		}
		noteEl.hidden = !snap?.note;
		noteEl.textContent = snap?.note ?? "";
		errorsEl.replaceChildren();
		errorsEl.hidden = !snap || snap.errors.length === 0;
		for (const error of snap?.errors ?? []) errorsEl.append(el("div", "mcp-error", error));

		listEl.replaceChildren();
		if (!snap) {
			listEl.append(el("div", "settings-empty", "No MCP config to show."));
		} else if (snap.servers.length === 0) {
			listEl.append(el("div", "settings-empty", "No servers configured — \"Add server\" writes the first entry."));
		} else {
			for (const server of snap.servers) listEl.append(row(server));
		}

		credsEl.replaceChildren();
		if (state.credentials.length === 0) credsEl.append(el("div", "settings-empty", "No stored sign-ins."));
		for (const credential of state.credentials) {
			const rowEl = el("div", "mcp-cred");
			rowEl.append(
				el("code", "mcp-cred-key", credential.key),
				pill(
					credential.hasTokens
						? credential.tokensExpireAt
							? `tokens expire ${new Date(credential.tokensExpireAt).toLocaleString()}`
							: "tokens stored"
						: "client registered only",
				),
			);
			credsEl.append(rowEl);
		}
	}

	/** shell.openPath resolves to "" on success, an error string otherwise — a
	 *  file that was never written counts as missing, which is what we show. */
	function openFileBtn(path: string): HTMLButtonElement {
		const btn = el("button", "dialog-btn mcp-mini-btn", "Open") as HTMLButtonElement;
		btn.title = `Open ${path}`;
		btn.addEventListener("click", () => {
			void window.pi.openPath(path).then((result) => {
				if (result) notify(result, "error");
			});
		});
		return btn;
	}

	function rowBtn(label: string, disabled: boolean, onClick: () => void, cls = "", title = ""): HTMLButtonElement {
		const btn = el("button", `dialog-btn${cls ? ` ${cls}` : ""}`, label) as HTMLButtonElement;
		btn.disabled = disabled;
		if (title) btn.title = title;
		btn.addEventListener("click", onClick);
		return btn;
	}

	function row(server: McpServerDTO): HTMLElement {
		const node = el("div", "mcp-row");
		if (!server.enabled) node.classList.add("mcp-row-off");
		const busy = state.busy === server.name;
		if (busy) node.classList.add("mcp-row-busy");
		// Extension-registered servers live in code, not in mcp.json.
		const editable = server.scope !== "extension";

		const head = el("div", "mcp-row-head");
		head.append(el("span", "mcp-name", server.name));
		if (server.scope !== "global") head.append(pill(server.scope));
		if (server.overridden) head.append(pill("overridden by project"));
		if (server.kind === "override") head.append(pill("override only"));
		head.append(statusPill(server.name));

		const transport = el("div", "mcp-transport", server.transport || "(no command or url)");
		transport.title = `${server.source}\n${server.kind} · exposure ${server.exposure}`;

		const actions = el("div", "mcp-actions");
		actions.append(
			rowBtn(server.enabled ? "Disable" : "Enable", !editable || busy, () => {
				void action(server.name, () => window.pi.mcpPatch(server.name, { enabled: !server.enabled }, "auto", target()));
			}),
		);

		const exposure = el("select", "form-input mcp-exposure") as HTMLSelectElement;
		for (const value of EXPOSURES) exposure.append(option(value, value, server.exposure === value));
		exposure.disabled = !editable || busy;
		exposure.title = "How the model sees this server's tools";
		exposure.addEventListener("change", () => {
			if (exposure.value === server.exposure) return;
			void action(server.name, () => window.pi.mcpPatch(server.name, { exposure: exposure.value }, "auto", target()));
		});
		actions.append(exposure);

		if (server.oauth) {
			actions.append(
				rowBtn(
					"Sign in",
					!editable || busy,
					() =>
						void action(server.name, async () => {
							const tools = await window.pi.mcpLogin(server.name, target());
							notify(`Signed in to ${server.name} — ${tools.length} tools`);
							return null;
						}),
					"",
					"Opens your browser and waits for the OAuth callback (5-minute deadline)",
				),
				rowBtn(
					"Sign out",
					!editable || busy,
					() =>
						void action(server.name, async () => {
							const removed = await window.pi.mcpLogout(server.name, target());
							notify(removed ? `Signed out of ${server.name}` : `${server.name} had no stored credentials`);
							return null;
						}),
					"dialog-btn-danger",
				),
			);
		}

		actions.append(
			rowBtn("Edit", !editable || busy, () => openForm(server), "", editable ? "" : "Registered by an extension — not editable in mcp.json"),
			rowBtn("Remove", !editable || busy, () => openRemoveDialog(server), "dialog-btn-danger"),
		);

		node.append(head, transport, actions);
		return node;
	}

	function openRemoveDialog(server: McpServerDTO): void {
		const overlay = el("div", "dialog-overlay");
		const box = el("div", "dialog-box dialog-form");
		box.append(el("div", "dialog-title", "Remove MCP server?"));
		const where =
			state.local && state.cwd ? state.snapshot?.paths.project ?? "the project config" : state.snapshot?.paths.global ?? "the agent-dir config";
		box.append(
			el(
				"div",
				"dialog-message",
				`Remove "${server.name}" from ${where}? The entry is deleted; stored OAuth credentials are kept (use "Sign out" for those).`,
			),
		);
		const buttons = el("div", "dialog-buttons");
		const remove = el("button", "dialog-btn dialog-btn-danger", "Remove");
		remove.addEventListener("click", () => {
			overlay.remove();
			void action(server.name, () => window.pi.mcpRemove(server.name, target()));
		});
		const cancel = el("button", "dialog-btn", "Cancel");
		cancel.addEventListener("click", () => overlay.remove());
		buttons.append(remove, cancel);
		box.append(buttons);
		overlay.append(box);
		overlay.addEventListener("mousedown", (e) => {
			if (e.target === overlay) overlay.remove();
		});
		document.body.append(overlay);
	}

	/** Add / edit: a name plus the raw JSON entry, validated live by the SDK's
	 *  own validator, so what can be submitted is exactly what pi will accept. */
	function openForm(server?: McpServerDTO): void {
		const editing = Boolean(server);
		const overlay = el("div", "dialog-overlay");
		const box = el("div", "dialog-box dialog-form mcp-dialog");
		box.append(el("div", "dialog-title", editing ? `Edit MCP server "${server?.name}"` : "Add MCP server"));

		const nameInput = el("input", "form-input") as HTMLInputElement;
		nameInput.placeholder = "name (letters, digits, _ or -)";
		nameInput.value = server?.name ?? "";
		// The name is the entry's key: editing means editing that key.
		nameInput.disabled = editing;

		const jsonInput = el("textarea", "form-input mcp-json") as HTMLTextAreaElement;
		jsonInput.rows = 12;
		jsonInput.spellcheck = false;
		jsonInput.value = JSON.stringify(
			server?.config ?? { command: "npx", args: ["-y", "@modelcontextprotocol/server-example"], env: {}, exposure: "codemode" },
			null,
			2,
		);

		const hint = el("div", "settings-caption");
		hint.textContent =
			`Writes to ${state.local && state.cwd ? "the project's .pi/mcp.json" : "the agent dir's mcp.json"}. ` +
			"Values may be ${VAR} templates or !command substitutions — they are stored as written and only " +
			"expand when the server connects.";
		const errorEl = el("div", "form-error");

		const buttons = el("div", "dialog-buttons");
		const submit = el("button", "dialog-btn dialog-btn-primary", editing ? "Save" : "Add") as HTMLButtonElement;
		const cancel = el("button", "dialog-btn", "Cancel");
		submit.disabled = true;

		let valid = false;
		const validate = (): void => {
			const name = nameInput.value.trim();
			const text = jsonInput.value;
			submit.disabled = true;
			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch (err) {
				valid = false;
				errorEl.textContent = `Invalid JSON: ${errText(err)}`;
				return;
			}
			if (!name) {
				valid = false;
				// Silent otherwise: the user would see a dead button and no reason.
				errorEl.textContent = "A name is required.";
				return;
			}
			// pi's own rules, main-side: the renderer never re-implements the schema.
			void window.pi
				.mcpValidate(name, parsed)
				.then((error) => {
					// A slower answer about a superseded draft must not paint over a newer one.
					if (nameInput.value.trim() !== name || jsonInput.value !== text) return;
					valid = !error;
					errorEl.textContent = error ?? "";
					submit.disabled = !valid;
				})
				.catch((err) => {
					valid = false;
					errorEl.textContent = errText(err);
				});
		};
		let timer = 0;
		const schedule = (): void => {
			window.clearTimeout(timer);
			timer = window.setTimeout(validate, 250);
			submit.disabled = true;
		};
		jsonInput.addEventListener("input", schedule);
		if (!editing) nameInput.addEventListener("input", schedule);
		validate();

		const close = (): void => overlay.remove();
		const commit = (): void => {
			if (!valid) return;
			const name = nameInput.value.trim();
			let parsed: unknown;
			try {
				parsed = JSON.parse(jsonInput.value);
			} catch (err) {
				errorEl.textContent = `Invalid JSON: ${errText(err)}`;
				return;
			}
			overlay.remove();
			// addMcpServer replaces an entry of the same name, which is also "Save".
			void action(name, async () => {
				await window.pi.mcpAdd(name, parsed, target());
				notify(editing ? `Saved "${name}"` : `Added "${name}"`);
				return null;
			});
		};
		submit.addEventListener("click", commit);
		cancel.addEventListener("click", close);
		jsonInput.addEventListener("keydown", (e) => {
			// Cmd/Ctrl+Enter submits; a bare Enter is a newline in JSON.
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
			if (e.key === "Escape") close();
		});
		nameInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") commit();
			if (e.key === "Escape") close();
		});
		buttons.append(submit, cancel);
		box.append(nameInput, jsonInput, hint, errorEl, buttons);
		overlay.append(box);
		overlay.addEventListener("mousedown", (e) => {
			if (e.target === overlay) close();
		});
		document.body.append(overlay);
		jsonInput.focus();
	}

	profileSelect.addEventListener("change", () => {
		state.profile = profileSelect.value;
		state.statuses = null;
		void refresh();
	});
	cwdInput.addEventListener("change", () => {
		state.cwd = cwdInput.value.trim();
		state.statuses = null;
		void refresh();
	});
	browseBtn.addEventListener("click", () => {
		void window.pi.pickDirectory().then((picked) => {
			if (!picked) return;
			state.cwd = picked;
			state.statuses = null;
			void refresh();
		});
	});
	localCheck.addEventListener("change", () => {
		state.local = localCheck.checked;
		render();
	});
	checkBtn.addEventListener("click", () => void runCheck());
	addBtn.addEventListener("click", () => openForm());
	reloadBtn.addEventListener("click", () => void refresh());

	pane.append(el("div", "settings-section-title", "MCP servers"));
	const hint = el("div", "settings-hint");
	hint.textContent =
		"Servers come from two mcp.json files: the agent dir's (global) and an optional project's " +
		".pi/mcp.json, whose entries replace same-named global ones. The list always shows the merged " +
		"view; writes go to whichever file the scope checkbox selects. A session loads its servers when it " +
		"starts, so reopen the tab after editing.";
	const toolbar = el("div", "settings-toolbar mcp-toolbar");
	profileSelect.title = "Whose agent dir holds the global config";
	browseBtn.title = "Pick a project whose .pi/mcp.json joins the view";
	checkBtn.title = "Connect to every enabled server (starts stdio processes)";
	reloadBtn.title = "Re-read the config files";
	toolbar.append(profileSelect, cwdInput, browseBtn, scopeLabel, checkBtn, addBtn, reloadBtn);
	pane.append(hint, toolbar, pathsEl, noteEl, errorsEl, listEl);

	pane.append(
		el("div", "settings-section-title", "Sign-in records"),
		el("div", "settings-hint", "OAuth records in this agent dir's mcp-auth.json. Token material never leaves the main process."),
		credsEl,
	);

	void window.pi
		.listProfiles()
		.then((data) => {
			profiles = data;
			render();
		})
		.catch((err) => console.warn("[settings] MCP profile list failed", err));
	// Profile edits (renames, new profiles) change the selector's contents.
	window.pi.onProfilesChanged((data) => {
		profiles = data;
		render();
	});
	void refresh();
	return pane;
}
