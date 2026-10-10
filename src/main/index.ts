/**
 * Main process entry: window creation, IPC wiring, menu, lifecycle.
 * All SDK sessions live here (SessionHost); the renderer only sees DTOs.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, shell } from "electron";
import { isImagePath } from "../shared/attachments.ts";
import { IPC, type CompactionPatch, type DirEntryDTO, type ListDirResultDTO, type PermissionMode, type ProfileDTO, type ThemeMode } from "../shared/ipc-types.ts";
import { LoginBridge } from "./auth-bridge.ts";
import { DialogBridge } from "./dialogs.ts";
import { listAvailableEditors, openInEditor } from "./editor.ts";
import { buildApplicationMenu } from "./menu.ts";
import { ProfileStore } from "./profiles.ts";
import { AppSettings } from "./settings.ts";
import { SessionHost } from "./session-host.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Keys mirror IMAGE_EXTENSIONS in shared/attachments.ts (isImagePath gate above).
const MAX_PREVIEW_IMAGE_BYTES = 10 * 1024 * 1024;
// Dropped/pasted payloads without a filesystem path are persisted before they
// can join the path-reference attachment pipeline; keep the inbox generous but
// bounded so a misdropped video can't fill the disk.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_LIST_DIR_ENTRIES = 60;
const IMAGE_MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	svg: "image/svg+xml",
	avif: "image/avif",
};

// The SDK performs a version check meant for the CLI; skip it in the desktop host.
process.env.PI_SKIP_VERSION_CHECK = "1";

// pi-plus-sdk and its bundled deps target Node >= 22.19; Electron <= 38 ships
// Node 22.18 and would fail at runtime inside the SDK or pi-hub-style code.
{
	const [major, minor] = process.versions.node.split(".").map(Number);
	if (major !== undefined && minor !== undefined && (major < 22 || (major === 22 && minor < 19))) {
		dialog.showErrorBox(
			"pi-plus-desktop",
			`This app requires Electron with Node.js >= 22.19 ( Electron >= 39 ); found Node ${process.versions.node}.`,
		);
		app.exit(1);
	}
}

const profileStore = new ProfileStore();
const settings = new AppSettings();
settings.load();
nativeTheme.themeSource = settings.theme;

// Single main window: one WebContents serves every tab, keyed by tabId.
// The Settings window is a separate top-level window.
let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;

// App icon: dist/assets (dev / plain build) or Resources/assets (packaged .app).
function appIcon(): Electron.NativeImage | undefined {
	const candidates = [
		path.join(process.resourcesPath ?? "", "assets/icon.png"),
		path.join(__dirname, "assets/icon.png"),
	];
	for (const p of candidates) {
		if (existsSync(p)) return nativeImage.createFromPath(p);
	}
	return undefined;
}

function webContentsForTab(_tabId: string) {
	return mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : undefined;
}

const dialogBridge = new DialogBridge(webContentsForTab);
const sessionHost = new SessionHost(webContentsForTab, dialogBridge, profileStore, () => settings.defaultPermissionMode);

// Provider-login prompts are driven by the Settings window (login is only
// started from the profile form there).
const loginBridge = new LoginBridge(
	() => (settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow.webContents : undefined),
	profileStore,
);

const webPreferences = {
	preload: path.join(__dirname, "preload.cjs"),
	contextIsolation: true,
	nodeIntegration: false,
	sandbox: true,
	webSecurity: true,
};

function createWindow(): void {
	mainWindow = new BrowserWindow({
		width: 1280,
		height: 840,
		minWidth: 720,
		minHeight: 480,
		title: "pi-plus",
		icon: appIcon(),
		webPreferences,
	});
	mainWindow.loadFile(path.join(__dirname, "renderer/index.html"));
	mainWindow.on("closed", () => {
		mainWindow = null;
	});
}

function openSettingsWindow(): void {
	if (settingsWindow && !settingsWindow.isDestroyed()) {
		settingsWindow.focus();
		return;
	}
	settingsWindow = new BrowserWindow({
		width: 600,
		height: 680,
		minWidth: 480,
		minHeight: 400,
		title: "Settings",
		icon: appIcon(),
		webPreferences,
	});
	settingsWindow.loadFile(path.join(__dirname, "renderer/settings.html"));
	settingsWindow.on("closed", () => {
		settingsWindow = null;
		// Login flows answer from this window; abort them rather than hang.
		loginBridge.cancelAll();
	});
}

function broadcastProfilesChanged(): void {
	const data = profileStore.list();
	for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.push.profilesChanged, data);
}

// The menu is static now that profiles/theme live in the Settings panel;
// store changes only need a renderer broadcast.
profileStore.onChanged = broadcastProfilesChanged;

function registerIpc(): void {
	// Profile mutations refresh the native menu + broadcast via profileStore.onChanged.
	ipcMain.handle(IPC.invoke.createTab, (_e, opts: { cwd?: string; profileName?: string | null }) => sessionHost.createTab(opts));
	ipcMain.handle(IPC.invoke.ensureSession, (_e, tabId: string, resumePath?: string) => sessionHost.ensureSession(tabId, resumePath));
	ipcMain.handle(IPC.invoke.prompt, (_e, tabId: string, text: string, attachments?: string[], mode?: "steer" | "followUp") => sessionHost.prompt(tabId, text, attachments, mode));
	ipcMain.handle(IPC.invoke.abort, (_e, tabId: string) => sessionHost.abort(tabId));
	ipcMain.handle(IPC.invoke.closeTab, async (_e, tabId: string) => sessionHost.closeTab(tabId));
	ipcMain.handle(IPC.invoke.setTabProfile, (_e, tabId: string, profileName: string | null) => sessionHost.setProfile(tabId, profileName));
	ipcMain.handle(IPC.invoke.listSessions, () => sessionHost.listSessions());
	ipcMain.handle(IPC.invoke.searchSessions, (_e, query: string) => sessionHost.searchSessions(query));
	ipcMain.handle(IPC.invoke.deleteSession, (_e, path: string) => sessionHost.deleteSession(path));
	ipcMain.handle(IPC.invoke.setModel, (_e, tabId: string, modelRef: string) => sessionHost.setModel(tabId, modelRef));
	ipcMain.handle(IPC.invoke.setThinkingLevel, (_e, tabId: string, level: string) => sessionHost.setThinkingLevel(tabId, level));
	ipcMain.handle(IPC.invoke.compact, (_e, tabId: string, customInstructions?: string) => sessionHost.compact(tabId, customInstructions));
	ipcMain.handle(IPC.invoke.abortCompaction, (_e, tabId: string) => sessionHost.abortCompaction(tabId));
	ipcMain.handle(IPC.invoke.setAutoCompaction, (_e, tabId: string, enabled: boolean) => sessionHost.setAutoCompaction(tabId, enabled));
	ipcMain.handle(IPC.invoke.clone, (_e, tabId: string) => sessionHost.clone(tabId));
	ipcMain.handle(IPC.invoke.cd, (_e, tabId: string, dirPath: string) => sessionHost.cd(tabId, dirPath));
	ipcMain.handle(IPC.invoke.listForkTargets, (_e, tabId: string) => sessionHost.listForkTargets(tabId));
	ipcMain.handle(IPC.invoke.forkFromMessage, (_e, tabId: string, entryId: string) => sessionHost.forkFromMessage(tabId, entryId));
	ipcMain.handle(IPC.invoke.rewind, (_e, tabId: string, entryId: string, summarize: boolean) => sessionHost.rewind(tabId, entryId, summarize));
	ipcMain.handle(IPC.invoke.renameSession, (_e, tabId: string, name: string) => sessionHost.renameSession(tabId, name));
	ipcMain.handle(IPC.invoke.clearQueue, (_e, tabId: string) => sessionHost.clearQueue(tabId));
	ipcMain.handle(IPC.invoke.listSkills, (_e, tabId: string) => sessionHost.listSkills(tabId));
	ipcMain.handle(IPC.invoke.listCommands, (_e, tabId: string) => sessionHost.listCommands(tabId));
	ipcMain.handle(IPC.invoke.listModels, (_e, tabId: string) => sessionHost.listModels(tabId));
	ipcMain.handle(IPC.invoke.setPermissionMode, (_e, tabId: string, mode: PermissionMode) => sessionHost.setPermissionMode(tabId, mode));

	ipcMain.handle(IPC.invoke.listProfiles, () => profileStore.list());
	ipcMain.handle(IPC.invoke.createProfile, (_e, name: string, profile: ProfileDTO) => profileStore.create(name, profile));
	ipcMain.handle(IPC.invoke.updateProfile, (_e, name: string, profile: ProfileDTO) => profileStore.update(name, profile));
	ipcMain.handle(IPC.invoke.removeProfile, (_e, name: string) => profileStore.remove(name));
	ipcMain.handle(IPC.invoke.renameProfile, (_e, oldName: string, newName: string) => profileStore.rename(oldName, newName));
	ipcMain.handle(IPC.invoke.setDefaultProfile, (_e, name: string) => profileStore.setDefault(name));
	ipcMain.handle(IPC.invoke.setDefaultModel, (_e, name: string, model: string) => profileStore.setDefaultModel(name, model));
	ipcMain.handle(IPC.invoke.addModel, (_e, name: string, model: string) => profileStore.addModel(name, model));
	ipcMain.handle(IPC.invoke.removeModel, (_e, name: string, model: string) => profileStore.removeModel(name, model));

	// Provider login (OAuth / interactive api-key setup) driven from the profile form.
	ipcMain.handle(IPC.invoke.loginProfile, (_e, name: string, provider?: string) => loginBridge.login(name, provider));
	ipcMain.handle(IPC.invoke.abortLogin, (_e, name: string) => loginBridge.cancel(name));
	ipcMain.handle(IPC.invoke.authStatus, (_e, name: string) => profileStore.authStatus(name));
	ipcMain.handle(IPC.invoke.cleanProfileDir, (_e, name: string) => profileStore.cleanProfileDir(name));

	ipcMain.handle(IPC.invoke.getSettings, () => ({
		theme: settings.theme,
		editor: settings.editor,
		sidebarWidth: settings.sidebarWidth,
		filetreeWidth: settings.filetreeWidth,
		defaultPermissionMode: settings.defaultPermissionMode,
	}));
	ipcMain.handle(IPC.invoke.setDefaultPermissionMode, async (_e, mode: PermissionMode) => {
		if (mode === "bypass" || mode === "acceptEdits" || mode === "plan") {
			settings.defaultPermissionMode = mode;
			await settings.save();
		}
	});
	ipcMain.handle(IPC.invoke.setTheme, async (_e, theme: ThemeMode) => {
		settings.theme = theme;
		await settings.save();
		// The renderer picks the new palette up via prefers-color-scheme.
		nativeTheme.themeSource = theme;
	});
	ipcMain.handle(IPC.invoke.setEditor, async (_e, command: string) => {
		settings.editor = command.trim();
		await settings.save();
	});
	ipcMain.handle(IPC.invoke.openInEditor, (_e, text: string) => openInEditor(settings.editor, text));
	ipcMain.handle(IPC.invoke.listEditors, () => listAvailableEditors());
	ipcMain.handle(IPC.invoke.setSidebarWidth, async (_e, width: number) => {
		if (Number.isFinite(width)) {
			settings.sidebarWidth = Math.round(width);
			await settings.save();
		}
	});
	ipcMain.handle(IPC.invoke.setFiletreeWidth, async (_e, width: number) => {
		if (Number.isFinite(width)) {
			settings.filetreeWidth = Math.round(width);
			await settings.save();
		}
	});

	ipcMain.handle(IPC.invoke.getCompaction, () => sessionHost.getCompactionSettings());
	ipcMain.handle(IPC.invoke.setCompaction, (_e, patch: CompactionPatch) => sessionHost.setCompactionSettings(patch));

	ipcMain.handle(IPC.invoke.pickDirectory, async () => {
		if (!mainWindow) return undefined;
		const result = await dialog.showOpenDialog(mainWindow, {
			title: "Select a folder for CWD",
			buttonLabel: "Start chat here",
			properties: ["openDirectory", "createDirectory"],
		});
		return result.canceled ? undefined : result.filePaths[0];
	});

	ipcMain.handle(IPC.invoke.pickFiles, async () => {
		if (!mainWindow) return [];
		// macOS lets openFile + openDirectory coexist, so one panel picks either;
		// other platforms keep files-only (folders arrive via the @-menu).
		const properties: ("openFile" | "openDirectory" | "multiSelections")[] = ["openFile", "multiSelections"];
		if (process.platform === "darwin") properties.push("openDirectory");
		const result = await dialog.showOpenDialog(mainWindow, {
			title: "Attach files to the prompt",
			buttonLabel: "Attach",
			properties,
		});
		return result.canceled ? [] : result.filePaths;
	});

	// Reveal an absolute path in the system file explorer: Finder/Explorer open
	// the *parent* folder with the item selected (shell.showItemInFolder), which
	// is fire-and-forget and silently no-ops on a missing path — hence the
	// existence check so the caller gets a real error instead of nothing.
	ipcMain.handle(IPC.invoke.revealPath, async (_e, target: string) => {
		if (!target) return "No path given";
		if (!existsSync(target)) return `'${target}' does not exist`;
		try {
			shell.showItemInFolder(target);
			return "";
		} catch {
			// No file manager to reveal in (e.g. headless Linux): just open it.
			return shell.openPath(target);
		}
	});

	// One-segment directory listing for the composer's @-menu, clamped to the
	// tab's cwd, prefix-filtered *before* the cap so "keep typing to narrow"
	// can surface entries beyond it. Type-ahead UIs treat vanished/locked dirs
	// as "no suggestions", so errors resolve to an empty listing.
	ipcMain.handle(IPC.invoke.listDir, async (_e, tabId: string, subpath: string, prefixRaw?: string): Promise<ListDirResultDTO> => {
		const empty: ListDirResultDTO = { entries: [], truncated: false };
		let cwd: string;
		try {
			cwd = sessionHost.cwdFor(tabId);
		} catch {
			return empty; // unknown tab
		}
		const resolved = path.resolve(cwd, subpath ?? "");
		if (resolved !== cwd && !resolved.startsWith(cwd.endsWith(path.sep) ? cwd : cwd + path.sep)) return empty;
		let relBase: string;
		try {
			relBase = path.relative(cwd, resolved).split(path.sep).join("/");
			const dirents = await readdir(resolved, { withFileTypes: true });
			const prefix = (typeof prefixRaw === "string" ? prefixRaw : "").toLowerCase();
			// Dotfiles stay hidden unless the user is explicitly typing them.
			const wantHidden = prefix.startsWith(".");
			const entries: DirEntryDTO[] = [];
			for (const dirent of dirents) {
				if (!wantHidden && dirent.name.startsWith(".")) continue;
				if (prefix && !dirent.name.toLowerCase().startsWith(prefix)) continue;
				let isDir = dirent.isDirectory();
				if (!isDir && !dirent.isFile()) {
					// Symlinks resolve to their target (a linked dir stays browsable);
					// broken links and sockets/fifos/devices are skipped.
					try {
						const target = await stat(path.join(resolved, dirent.name));
						isDir = target.isDirectory();
						if (!isDir && !target.isFile()) continue;
					} catch {
						continue;
					}
				}
				entries.push({ name: dirent.name, relPath: relBase ? `${relBase}/${dirent.name}` : dirent.name, isDir });
			}
			entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.isDir ? -1 : 1));
			const truncated = entries.length > MAX_LIST_DIR_ENTRIES;
			const visible = truncated ? entries.slice(0, MAX_LIST_DIR_ENTRIES) : entries;
			return { entries: visible, truncated };
		} catch {
			return empty; // not a dir / permission / deleted mid-typing
		}
	});

	// Image previews for the renderer's CSP ('self' + data: only): main reads the
	// file and hands back a data URL. Unreadable/too-large/missing -> undefined.
	ipcMain.handle(IPC.invoke.readImage, async (_e, filePath: string): Promise<string | undefined> => {
		if (typeof filePath !== "string" || !isImagePath(filePath)) return undefined;
		const mime = IMAGE_MIME_BY_EXT[path.extname(filePath).slice(1).toLowerCase()];
		if (!mime) return undefined;
		try {
			const info = await stat(filePath);
			if (!info.isFile() || info.size > MAX_PREVIEW_IMAGE_BYTES) return undefined;
			const data = await readFile(filePath);
			return `data:${mime};base64,${data.toString("base64")}`;
		} catch {
			return undefined;
		}
	});

	// Inbox for pasted/dropped payloads that carry no filesystem path
	// (clipboard images, files dragged out of a browser): save the bytes and
	// hand back an absolute path the attachment pipeline can reference.
	ipcMain.handle(IPC.invoke.saveAttachment, async (_e, name: string, dataUrl: string): Promise<string> => {
		if (typeof name !== "string" || typeof dataUrl !== "string") throw new Error("Invalid attachment payload.");
		const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
		if (!match?.[2]) throw new Error("Attachment must be a base64 data URL.");
		const bytes = Buffer.from(match[3] ?? "", "base64");
		if (bytes.byteLength === 0) throw new Error("Attachment is empty.");
		if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment too large (max ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB).`);
		// Keep only a safe basename; derive an extension from the mime type when
		// the payload name carries none ("image/png" → .png).
		const rawBase = path.basename(name).replace(/[^\w.()-]+/g, "_").replace(/^_+|_+$/g, "");
		const mimeExt = match[1]?.split("/")[1]?.replace(/\+.*$/, "");
		const ext = path.extname(rawBase) || (mimeExt ? `.${mimeExt}` : "");
		const base = rawBase || "attachment";
		const dir = path.join(app.getPath("userData"), "media-inbox");
		await mkdir(dir, { recursive: true });
		let candidate = path.join(dir, `${base}${ext}`);
		for (let n = 2; existsSync(candidate); n++) candidate = path.join(dir, `${base}-${n}${ext}`);
		await writeFile(candidate, bytes);
		return candidate;
	});

	// One-way channel — no menu refresh needed.
	ipcMain.on(IPC.invoke.respondDialog, (_e, requestId: string, value: unknown) => {
		dialogBridge.respond(requestId, value);
	});

	ipcMain.on(IPC.invoke.respondAuthPrompt, (_e, requestId: string, value: string | null) => {
		loginBridge.respond(requestId, value);
	});
}

// Dev runner (scripts/dev.mjs) signals renderer/preload rebuilds via SIGUSR1.
process.on("SIGUSR1", () => {
	for (const win of BrowserWindow.getAllWindows()) win.webContents.reload();
});

app.whenReady().then(() => {
	registerIpc();
	buildApplicationMenu(openSettingsWindow, () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : undefined));
	// Unpackaged runs get a generic Electron Dock icon; replace it with ours.
	if (process.platform === "darwin" && !app.isPackaged) {
		const icon = appIcon();
		if (icon) app.dock?.setIcon(icon);
	}
	createWindow();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

// Runtime disposal is async (session_shutdown handlers may await), so quit is
// a two-phase dance: prevent the first pass, dispose with a timeout backstop,
// then hard-exit.
let quitting = false;
app.on("before-quit", (e) => {
	if (quitting) {
		e.preventDefault(); // block the re-entrant quit from app.exit until done
		return;
	}
	quitting = true;
	e.preventDefault();
	void (async () => {
		try {
			await Promise.race([sessionHost.disposeAll(), new Promise((resolve) => setTimeout(resolve, 5000))]);
		} catch (err) {
			console.warn("[main] error disposing sessions", err);
		}
		try {
			profileStore.syncAllToSource();
		} catch (err) {
			console.warn("[main] error syncing profile dirs", err);
		}
		app.exit(0);
	})();
});
