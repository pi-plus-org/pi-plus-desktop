/**
 * packages-app.ts — standalone pi package maintenance window (its own
 * top-level window, opened from the app menu: Packages… / ⌘⇧,).
 *
 * pi packages contribute extensions, skills, prompt templates and themes.
 * They live in the base ~/.pi/agent settings + npm dir, so they are shared
 * by every profile and tab (the same declarations `pipi install` writes);
 * this window only manages the global (user-scope) set. Open sessions are
 * offered a restart when a change lands; otherwise changes take effect when
 * a new session starts.
 *
 * Backed by `src/main/packages.ts` (PackageStore); every mutation resolves
 * to the fresh package list, which re-renders the grid.
 */
import "../styles.css";
import type { PackageDTO, PackageToolsSettingsDTO } from "../../shared/ipc-types.ts";

function el(tag: string, className?: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

type SourceClass = "npm" | "git" | "local";

/** npm package spec: optional @scope/, lowercase name (npm's own rule), optional @version/range. */
const NPM_SPEC_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[^@/\s]+)?$/;
/** Looser npm-ish shape, used only to produce a targeted lowercase error. */
const NPM_LOOSE_RE = /^@?[A-Za-z0-9][\w./-]*$/;

function isLocalPathLike(s: string): boolean {
	return s.startsWith(".") || s.startsWith("~") || s.startsWith("/") || /^[A-Za-z]:[\\/]/.test(s) || s.startsWith("file:");
}

function isGitLike(s: string): boolean {
	return (
		/^(github|gitlab|bitbucket):/i.test(s) ||
		/^(https?|ssh|git):\/\//i.test(s) ||
		/^[\w.-]+@[\w.-]+:/.test(s) || // user@host:path
		s.endsWith(".git") ||
		/^[\w.-]+\/[\w.-]+(#.+)?$/.test(s) // owner/repo[#ref] shorthand
	);
}

/**
 * Classify an entered source, mirroring the SDK's parseSource order (npm:
 * prefix → npm spec → local path → git), with stricter shape validation so
 * typos surface inline instead of as a failed install.
 */
function classifySource(source: string): { cls: SourceClass; error?: string } {
	const s = source.trim();
	if (!s) return { cls: "local", error: "Source is required." };
	if (/\s/.test(s)) return { cls: "local", error: "Source must not contain whitespace." };
	if (s.startsWith("npm:")) {
		const spec = s.slice(4);
		if (!spec) return { cls: "npm", error: "'npm:' needs a package name after it (e.g. npm:lodash)." };
		if (!NPM_SPEC_RE.test(spec)) return { cls: "npm", error: `Invalid npm package spec '${spec}' — use name or @scope/name, optionally @version.` };
		return { cls: "npm" };
	}
	if (isLocalPathLike(s)) return { cls: "local" };
	if (isGitLike(s)) return { cls: "git" };
	if (NPM_SPEC_RE.test(s)) return { cls: "npm" };
	if (NPM_LOOSE_RE.test(s))
		return { cls: "npm", error: `Invalid npm package name '${s}' — npm names are lowercase; use name, @scope/name, optionally @version.` };
	return {
		cls: "local",
		error: "Unrecognized source — use an npm name (@scope/name@version), a git URL (https://…, git@host:path, or owner/repo), or a local path (./…).",
	};
}

const TOOL_HINTS = {
	npm: "npm isn't available on this machine — npm packages can't be installed. Install Node.js (https://nodejs.org or `brew install node`), or set a manual npm path in the Package tools section, then retry.",
	git: "git isn't available on this machine — git packages can't be installed. Install git (`xcode-select --install` or https://git-scm.com), or set a manual git path in the Package tools section, then retry.",
} as const;

function init(): void {
	const root = document.querySelector<HTMLElement>("#packages-root");
	if (!root) return;

	const content = el("div", "settings-content");
	root.append(content);

	// Page header: real title + one-line subtitle (kept short; the details live
	// in the section hints below).
	const pkgHeader = el("div", "pkg-header");
	pkgHeader.append(el("div", "pkg-title", "Packages"));
	const pkgSubtitle = el("div", "pkg-subtitle");
	pkgSubtitle.append("Extensions, skills, prompt templates and themes — installed globally in ");
	pkgSubtitle.append(el("code", "pkg-code", "~/.pi/agent"));
	pkgSubtitle.append(", shared by every profile and tab (the same list ");
	pkgSubtitle.append(el("code", "pkg-code", "pipi"));
	pkgSubtitle.append(" manages). Open sessions are offered a restart when a change lands; otherwise changes take effect when a new session starts.");
	pkgHeader.append(pkgSubtitle);
	content.append(pkgHeader);

	const pkgToolbar = el("div", "pkg-toolbar");
	const pkgAddBtn = el("button", "dialog-btn dialog-btn-primary", "Add package") as HTMLButtonElement;
	const pkgUpdateAllBtn = el("button", "dialog-btn", "Update all") as HTMLButtonElement;
	pkgToolbar.append(pkgAddBtn, pkgUpdateAllBtn);
	const pkgStatus = el("div", "pkg-status"); // hidden while empty
	const pkgListBox = el("div", "pkg-list");
	content.append(pkgToolbar, pkgStatus, pkgListBox);

	// Package tools section: where npm/git live (auto-detect on PATH or a manual
	// binary path) with a live resolved/missing pill per tool.
	content.append(el("div", "settings-section-title", "Package tools"));
	content.append(
		el(
			"div",
			"settings-hint",
			"Installing npm or git packages shells out to these tools. Auto-detect finds them on PATH; Manual lets you point at a specific binary (its directory is used to run installs).",
		),
	);
	const pkgToolRows = el("div", "pkg-tools");
	const toolStatusEls: Record<"npm" | "git", HTMLSpanElement> = {
		npm: el("span", "pkg-tool-pill") as HTMLSpanElement,
		git: el("span", "pkg-tool-pill") as HTMLSpanElement,
	};
	content.append(pkgToolRows);

	let pkgBusy = false; // a mutation is running — buttons disabled
	let pkgLoaded = false;
	let pkgList: PackageDTO[] | null = null;
	let pkgTools: { npm: string | null; git: string | null } | null = null;

	const setPkgStatus = (message: string, kind: "info" | "error" = "info"): void => {
		pkgStatus.textContent = message;
		pkgStatus.classList.toggle("pkg-status-error", kind === "error");
		pkgStatus.style.display = message ? "" : "none";
	};

	const renderPackages = (list: PackageDTO[]): void => {
		pkgListBox.replaceChildren();
		if (!list.length) {
			// Empty state carries its own CTA instead of relying on the toolbar.
			const empty = el("div", "pkg-empty");
			empty.append(el("div", "pkg-empty-glyph", "📦"));
			empty.append(el("div", "pkg-empty-title", "No packages installed"));
			empty.append(el("div", "pkg-empty-sub", "Add an npm package, a git repo, or a local path — anything `pipi install` accepts."));
			const cta = el("button", "dialog-btn dialog-btn-primary", "Add package") as HTMLButtonElement;
			cta.addEventListener("click", openAddPackageDialog);
			empty.append(cta);
			pkgListBox.append(empty);
			return;
		}
		for (const pkg of list) {
			const row = el("div", "pkg-row");

			const main = el("div", "pkg-row-main");
			const head = el("div", "pkg-row-head");
			head.append(el("span", "pkg-row-source", pkg.source));
			const cls = classifySource(pkg.source).cls;
			head.append(el("span", "pkg-badge pkg-badge-type", cls));
			head.append(el("span", "pkg-badge", pkg.scope === "user" ? "user" : "project"));
			if (pkg.filtered) head.append(el("span", "pkg-badge pkg-badge-filtered", "filtered"));
			main.append(head);

			if (pkg.installedPath) main.append(el("div", "pkg-row-path", pkg.installedPath));
			row.append(main);

			// npm/git ops shell out to those tools — disable when unavailable.
			const toolMissing =
				(cls === "npm" && pkgTools !== null && !pkgTools.npm) || (cls === "git" && pkgTools !== null && !pkgTools.git);

			const actions = el("div", "pkg-row-actions");
			const updateBtn = el("button", "dialog-btn", "Update") as HTMLButtonElement;
			updateBtn.title = toolMissing ? TOOL_HINTS[cls as "npm" | "git"] : "Upgrade this package";
			updateBtn.disabled = pkgBusy || toolMissing;
			updateBtn.addEventListener("click", () => runPkgOp(`Updating ${pkg.source}`, window.pi.updatePackages(pkg.source)));
			const removeBtn = el("button", "dialog-btn dialog-btn-danger", "Remove") as HTMLButtonElement;
			removeBtn.disabled = pkgBusy || toolMissing;
			removeBtn.title = toolMissing ? TOOL_HINTS[cls as "npm" | "git"] : "Remove this package";
			removeBtn.addEventListener("click", () => openRemovePackageDialog(pkg.source));
			actions.append(updateBtn, removeBtn);
			row.append(actions);
			pkgListBox.append(row);
		}
	};

	/** One mutation lifecycle: busy flag + status line, then list refresh. */
	const errorMessage = (err: unknown): string =>
		String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, "");
	const runPkgOp = (label: string, op: Promise<PackageDTO[]>): void => {
		pkgBusy = true;
		pkgAddBtn.disabled = true;
		pkgUpdateAllBtn.disabled = true;
		if (pkgList !== null) renderPackages(pkgList); // re-render with disabled buttons
		setPkgStatus(`${label}…`);
		op.then(
			(list) => {
				pkgList = list;
				pkgLoaded = true;
				renderPackages(list);
				setPkgStatus("");
			},
			(err) => setPkgStatus(errorMessage(err), "error"),
		);
		op.finally(() => {
			pkgBusy = false;
			pkgAddBtn.disabled = false;
			pkgUpdateAllBtn.disabled = pkgList !== null && pkgList.length === 0;
			if (pkgList !== null) renderPackages(pkgList);
		});
	};

	const refreshPackages = (): void => {
		void window.pi
			.listPackages()
			.then((list) => {
				pkgList = list;
				pkgLoaded = true;
				renderPackages(list);
				pkgUpdateAllBtn.disabled = pkgBusy || list.length === 0;
			})
			.catch((err) => {
				console.warn("[packages] listPackages failed", err);
				if (!pkgLoaded)
					pkgListBox.replaceChildren(el("div", "pkg-empty-title", "Couldn't load packages. Check the main process logs."));
			});
	};

	let pkgToolSettings: PackageToolsSettingsDTO | null = null;

	const renderToolStatus = (): void => {
		for (const tool of ["npm", "git"] as const) {
			const status = toolStatusEls[tool];
			const resolved = pkgTools?.[tool];
			if (resolved) {
				status.textContent = `Using ${resolved}`;
				status.className = "pkg-tool-pill pkg-tool-pill-ok";
				status.title = resolved;
			} else if (pkgTools === null) {
				status.textContent = "Checking…";
				status.className = "pkg-tool-pill";
				status.title = "";
			} else {
				// Full remediation hint lives in the tooltip (install command / set a manual path).
				status.textContent = "Not found";
				status.className = "pkg-tool-pill pkg-tool-pill-missing";
				status.title = TOOL_HINTS[tool];
			}
		}
	};

	const renderToolRows = (): void => {
		pkgToolRows.replaceChildren();
		for (const tool of ["npm", "git"] as const) {
			const setting = pkgToolSettings?.[tool] ?? { mode: "auto" as const, path: "" };
			const row = el("div", "pkg-tool-row");
			row.append(el("span", "pkg-tool-name", tool));
			const select = el("select", "form-input") as HTMLSelectElement;
			for (const [value, label] of [
				["auto", "Auto-detect (PATH)"],
				["manual", "Manual path"],
			] as const) {
				const option = el("option", undefined, label) as HTMLOptionElement;
				option.value = value;
				select.append(option);
			}
			select.value = setting.mode;
			row.append(select);
			// The path box only exists in Manual mode — in Auto it would be a
			// permanently disabled input squatting in the layout.
			const input = el("input", "form-input pkg-tool-path") as HTMLInputElement;
			input.placeholder = `/path/to/${tool}`;
			input.value = setting.path;
			input.style.display = setting.mode === "manual" ? "" : "none";
			row.append(input, toolStatusEls[tool]);
			pkgToolRows.append(row);

			// Persist the setting main-side (piPlus block), then re-probe with the
			// new config so the status row and Add-dialog gating reflect it.
			const save = (next: { mode: "auto" | "manual"; path: string }): void => {
				pkgToolSettings = { ...pkgToolSettings, [tool]: next } as PackageToolsSettingsDTO;
				window.pi.setPackageTools({ [tool]: next }).then(
					() => refreshTools(),
					(err) => setPkgStatus(errorMessage(err), "error"),
				);
			};
			let pathSaveTimer: ReturnType<typeof setTimeout> | undefined;
			select.addEventListener("change", () => {
				const mode = select.value === "manual" ? "manual" : "auto";
				input.style.display = mode === "manual" ? "" : "none";
				if (mode === "manual") input.focus();
				save({ mode, path: mode === "manual" ? input.value.trim() : "" });
			});
			input.addEventListener("input", () => {
				if (input.style.display === "none") return;
				clearTimeout(pathSaveTimer);
				pathSaveTimer = setTimeout(() => save({ mode: "manual", path: input.value.trim() }), 400);
			});
		}
	};

	const refreshTools = (): void => {
		void window.pi
			.checkPackageTools()
			.then((tools) => {
				pkgTools = tools;
				renderToolStatus();
				if (pkgList !== null) renderPackages(pkgList); // re-gate per-card buttons
			})
			.catch((err) => console.warn("[packages] checkPackageTools failed", err));
	};

	const loadToolSettings = (): void => {
		void window.pi.getSettings().then(
			(settings) => {
				pkgToolSettings =
					settings.packageTools ??
					({ npm: { mode: "auto", path: "" }, git: { mode: "auto", path: "" } } satisfies PackageToolsSettingsDTO);
				renderToolRows();
				refreshTools();
			},
			(err) => console.warn("[packages] getSettings failed", err),
		);
	};

	const openAddPackageDialog = (): void => {
		document.querySelector(".dialog-overlay")?.remove();
		const overlay = el("div", "dialog-overlay");
		const box = el("div", "dialog-box dialog-form");
		box.append(el("div", "dialog-title", "Add package"));
		box.append(el("div", "dialog-message", "An npm package, a git repo, or a local path — anything `pipi install` accepts."));
		const row = el("label", "form-row");
		row.append(el("span", "form-label", "Source"));
		const input = el("input", "form-input") as HTMLInputElement;
		input.placeholder = "npm:@scope/pkg, github.com/user/repo, or ./local/path";
		row.append(input);
		const errorRow = el("div", "form-error");
		// Live warning below the input when the entered source needs a tool that
		// isn't available (npm/git missing or a bad manual path).
		const warnRow = el("div", "form-error");
		const syncWarn = (): void => {
			const { cls } = classifySource(input.value.trim());
			warnRow.textContent = cls !== "local" && pkgTools !== null && !pkgTools[cls] ? TOOL_HINTS[cls] : "";
		};
		input.addEventListener("input", () => {
			errorRow.textContent = "";
			syncWarn();
		});
		const buttons = el("div", "dialog-buttons");
		const install = el("button", "dialog-btn dialog-btn-primary", "Install");
		const cancel = el("button", "dialog-btn", "Cancel");
		const submit = (): void => {
			const source = input.value.trim();
			const { cls, error } = classifySource(source);
			if (error) {
				errorRow.textContent = error;
				return;
			}
			if (pkgList?.some((pkg) => pkg.source === source)) {
				errorRow.textContent = "'" + source + "' is already installed.";
				return;
			}
			if (cls !== "local" && pkgTools !== null && !pkgTools[cls]) {
				errorRow.textContent = TOOL_HINTS[cls];
				syncWarn();
				return;
			}
			overlay.remove();
			runPkgOp(`Installing ${source}`, window.pi.installPackage(source));
		};
		install.addEventListener("click", submit);
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") submit();
			if (e.key === "Escape") overlay.remove();
		});
		cancel.addEventListener("click", () => overlay.remove());
		buttons.append(install, cancel);
		box.append(row, warnRow, errorRow, buttons);
		overlay.append(box);
		overlay.addEventListener("mousedown", (e) => {
			if (e.target === overlay) overlay.remove();
		});
		document.body.append(overlay);
		input.focus();
	};

	const openRemovePackageDialog = (source: string): void => {
		document.querySelector(".dialog-overlay")?.remove();
		const overlay = el("div", "dialog-overlay");
		const box = el("div", "dialog-box dialog-form");
		box.append(el("div", "dialog-title", "Remove package?"));
		box.append(el("div", "dialog-message", `Remove ${source}? Its declaration and checkout under ~/.pi/agent are deleted.`));
		const buttons = el("div", "dialog-buttons");
		const remove = el("button", "dialog-btn dialog-btn-danger", "Remove");
		remove.addEventListener("click", () => {
			overlay.remove();
			runPkgOp(`Removing ${source}`, window.pi.removePackage(source));
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
	};

	pkgAddBtn.addEventListener("click", openAddPackageDialog);
	pkgUpdateAllBtn.addEventListener("click", () => runPkgOp("Updating all packages", window.pi.updatePackages()));
	// Live clone/install progress from the main-process store.
	window.pi.onPackagesProgress((event) => {
		if (!pkgBusy) return;
		setPkgStatus(event.message ?? `${event.action} ${event.source}…`, event.type === "error" ? "error" : "info");
	});

	refreshPackages();
	refreshTools();
	renderToolRows(); // defaults until loadToolSettings replaces them with the persisted config
	loadToolSettings();
	// Re-list and re-probe tools when the window regains focus (e.g. after the
	// user installs Node/git and restarts... or runs `pipi` alongside).
	window.addEventListener("focus", () => {
		refreshPackages();
		refreshTools();
	});
}

init();
