/**
 * packages-app.ts — standalone pi package maintenance window (its own
 * top-level window, opened from the app menu: Packages… / ⌘⇧,).
 *
 * pi packages contribute extensions, skills, prompt templates and themes.
 * They live in the base ~/.pi/agent settings + npm dir, so they are shared
 * by every profile and tab (the same declarations `pipi install` writes);
 * this window only manages the global (user-scope) set. Changes take effect
 * when a new session starts.
 *
 * Backed by `src/main/packages.ts` (PackageStore); every mutation resolves
 * to the fresh package list, which re-renders the grid.
 */
import "../styles.css";
import type { PackageDTO } from "../../shared/ipc-types.ts";

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
	npm: "npm is not available on this machine — npm packages can't be installed. Install Node.js (https://nodejs.org or `brew install node`), restart the app, and try again.",
	git: "git is not available on this machine — git packages can't be installed. Install git (`xcode-select --install` or https://git-scm.com), restart the app, and try again.",
} as const;

function init(): void {
	const root = document.querySelector<HTMLElement>("#packages-root");
	if (!root) return;

	const content = el("div", "settings-content");
	root.append(content);

	content.append(el("div", "settings-section-title", "Packages"));
	content.append(
		el(
			"div",
			"settings-hint",
			"Packages contribute extensions, skills, prompt templates and themes. They are installed globally in ~/.pi/agent — shared by every profile and tab, and the same list `pipi` manages — and take effect when a new session starts.",
		),
	);

	const pkgToolbar = el("div", "settings-toolbar");
	const pkgAddBtn = el("button", "dialog-btn dialog-btn-primary", "Add package") as HTMLButtonElement;
	const pkgUpdateAllBtn = el("button", "dialog-btn", "Update all") as HTMLButtonElement;
	// npm/git availability badges — probed main-side on the startup-repaired PATH.
	const npmBadge = el("span", "pkg-badge pkg-tool-badge", "npm");
	const gitBadge = el("span", "pkg-badge pkg-tool-badge", "git");
	pkgToolbar.append(pkgAddBtn, el("div", "settings-toolbar-spacer"), npmBadge, gitBadge, pkgUpdateAllBtn);
	const pkgStatus = el("div", "package-status"); // hidden while empty
	const packagesGrid = el("div", "settings-grid");
	content.append(pkgToolbar, pkgStatus, packagesGrid);

	let pkgBusy = false; // a mutation is running — buttons disabled
	let pkgLoaded = false;
	let pkgList: PackageDTO[] | null = null;
	let pkgTools: { npm: string | null; git: string | null } | null = null;

	const setPkgStatus = (message: string, kind: "info" | "error" = "info"): void => {
		pkgStatus.textContent = message;
		pkgStatus.classList.toggle("package-status-error", kind === "error");
		pkgStatus.style.display = message ? "" : "none";
	};

	const renderPackages = (list: PackageDTO[]): void => {
		packagesGrid.replaceChildren();
		if (!list.length) {
			packagesGrid.append(
				el("div", "settings-empty", "No packages installed yet — add an npm package, a git repo, or a local path."),
			);
			return;
		}
		for (const pkg of list) {
			const card = el("div", "settings-card package-card");

			const head = el("div", "settings-card-head");
			head.append(el("span", "settings-card-name package-card-name", pkg.source));
			head.append(el("span", "pkg-badge", pkg.scope === "user" ? "user" : "project"));
			if (pkg.filtered) head.append(el("span", "pkg-badge pkg-badge-filtered", "filtered"));
			card.append(head);

			if (pkg.installedPath) card.append(el("div", "settings-card-meta", pkg.installedPath));

			// npm/git ops shell out to those tools — disable when unavailable.
			const cls = classifySource(pkg.source).cls;
			const toolMissing =
				(cls === "npm" && pkgTools !== null && !pkgTools.npm) || (cls === "git" && pkgTools !== null && !pkgTools.git);

			const actions = el("div", "package-card-actions");
			const updateBtn = el("button", "dialog-btn", "Update") as HTMLButtonElement;
			updateBtn.title = toolMissing ? TOOL_HINTS[cls as "npm" | "git"] : "Upgrade this package";
			updateBtn.disabled = pkgBusy || toolMissing;
			updateBtn.addEventListener("click", () => runPkgOp(`Updating ${pkg.source}`, window.pi.updatePackages(pkg.source)));
			const removeBtn = el("button", "dialog-btn dialog-btn-danger", "Remove") as HTMLButtonElement;
			removeBtn.disabled = pkgBusy || toolMissing;
			removeBtn.title = toolMissing ? TOOL_HINTS[cls as "npm" | "git"] : "Remove this package";
			removeBtn.addEventListener("click", () => openRemovePackageDialog(pkg.source));
			actions.append(updateBtn, removeBtn);
			card.append(actions);
			packagesGrid.append(card);
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
					packagesGrid.replaceChildren(el("div", "settings-empty", "Couldn't load packages. Check the main process logs."));
			});
	};

	const renderToolBadges = (): void => {
		for (const [badge, tool] of [
			[npmBadge, "npm"],
			[gitBadge, "git"],
		] as const) {
			const available = pkgTools === null ? true : pkgTools[tool] !== null; // unknown = assume ok
			badge.classList.toggle("pkg-badge-missing", !available);
			badge.textContent = tool;
			badge.title = available
				? `${tool} — ${pkgTools?.[tool] ?? "available"}`
				: `${tool} not found on PATH — ${tool} packages can't be installed. ${TOOL_HINTS[tool].split("—")[1]?.trim() ?? ""}`;
		}
	};

	const refreshTools = (): void => {
		void window.pi
			.checkPackageTools()
			.then((tools) => {
				pkgTools = tools;
				renderToolBadges();
				if (pkgList !== null) renderPackages(pkgList); // re-gate per-card buttons
			})
			.catch((err) => console.warn("[packages] checkPackageTools failed", err));
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
		box.append(row, errorRow, buttons);
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
	// Re-list and re-probe tools when the window regains focus (e.g. after the
	// user installs Node/git and restarts... or runs `pipi` alongside).
	window.addEventListener("focus", () => {
		refreshPackages();
		refreshTools();
	});
}

init();
