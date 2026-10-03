/**
 * Renderer bootstrap: wires the store to UI modules and the window.pi IPC
 * surface, and owns tab-level actions (new tab, close tab, resume, prompt).
 */

import type { EnsureResult, SessionListItemDTO } from "../../shared/ipc-types.ts";
import "../styles.css";
import { ChatView } from "./chat-view.ts";
import { Composer, type TabActions } from "./composer.ts";
import { Dialogs } from "./dialogs.ts";
import { NewChatForm } from "./new-chat.ts";
import { clampSidebarWidth, Sidebar } from "./sidebar.ts";
import { store, type TabState } from "./store.ts";
import { TabsBar } from "./tabs.ts";
import { installTooltip } from "./tooltip.ts";

const $ = <T extends HTMLElement>(selector: string): T => {
	const node = document.querySelector<T>(selector);
	if (!node) throw new Error(`Missing element ${selector}`);
	return node;
};

/** The profile new tabs start under: the Settings "Set Default" pick, but
 *  only while it still names an existing profile. */
async function resolveDefaultProfile(): Promise<string | null> {
	const data = await window.pi.listProfiles();
	return data.default && data.profiles[data.default] ? data.default : null;
}

const NO_DEFAULT_PROFILE_MSG = "No default profile — create one in Settings (⌘,) and click Set Default.";

/** Folder picker + tab + session. Optional text becomes the first prompt. */
async function newTab(firstPrompt?: string): Promise<boolean> {
	const profileName = await resolveDefaultProfile();
	if (!profileName) {
		dialogs.notify(NO_DEFAULT_PROFILE_MSG, "error");
		return false;
	}
	// macOS native open panels ignore the dialog title, so the reason for the
	// pick lives in a toast under the sheet (see main pickDirectory title too).
	dialogs.notify("Select a folder for CWD — the chat will work inside it.", "info", 12000);
	const dir = (await window.pi.pickDirectory()) ?? store.active?.cwd ?? "";
	if (!dir) return false; // user cancelled and no fallback cwd
	const desc = await window.pi.createTab({ cwd: dir, profileName });
	const tab = store.addTab(desc);
	try {
		const result = await window.pi.ensureSession(tab.tabId);
		store.applyEnsure(tab, result);
	} catch (err) {
		dialogs.notify(`Failed to start session: ${String((err as Error).message ?? err)}`, "error");
		return false;
	}
	if (firstPrompt) await sendPrompt(firstPrompt);
	return true;
}

async function closeTab(tabId: string): Promise<void> {
	await window.pi.closeTab(tabId);
	store.removeTab(tabId);
}

/** ⌘⇧[ / ⌘⇧] — move active-tab focus with wrap-around. */
function selectTabByOffset(offset: number): void {
	const { order, activeTabId } = store;
	if (order.length < 2) return;
	const index = order.indexOf(activeTabId ?? "");
	const next = ((((index === -1 ? 0 : index + offset) % order.length) + order.length) % order.length);
	const target = order[next];
	if (target) store.setActive(target);
}

async function resumeSession(item: SessionListItemDTO): Promise<void> {
	// Already open: bring that tab to front instead of duplicating the session.
	const liveTabId = store.liveSessions.get(item.id);
	if (liveTabId && store.tabs.has(liveTabId)) {
		store.setActive(liveTabId);
		return;
	}
	// Resume into a new tab so the history entry keeps its own context.
	// Sessions are shared across profile agent dirs, so the default profile
	// can load any listed session.
	const profileName = await resolveDefaultProfile();
	if (!profileName) {
		dialogs.notify(NO_DEFAULT_PROFILE_MSG, "error");
		return;
	}
	const desc = await window.pi.createTab({ cwd: item.cwd, profileName });
	const tab = store.addTab(desc);
	try {
		const result = await window.pi.ensureSession(tab.tabId, item.path);
		store.applyEnsure(tab, result);
	} catch (err) {
		store.removeTab(tab.tabId);
		await window.pi.closeTab(tab.tabId);
		dialogs.notify(`Failed to resume session: ${String((err as Error).message ?? err)}`, "error");
		return;
	}
}

let composerRef: Composer | null = null;
let sidebarRef: Sidebar | null = null;

async function sendPrompt(text: string, attachments: string[] = [], mode?: "steer" | "followUp"): Promise<void> {
	const tabId = store.activeTabId;
	if (!tabId) return;
	// Local echo: the SDK emits no event for user messages.
	const index = store.appendUserItem(tabId, text, attachments);
	try {
		await window.pi.prompt(tabId, text, attachments, mode);
	} catch (err) {
		store.removeItemAt(tabId, index);
		composerRef?.restoreAttachments(attachments);
		dialogs.notify(`Send failed: ${String((err as Error).message ?? err)}`, "error");
	}
}

/** Apply the snapshot a session-replacing capability returns. */
function applyCapability(tabId: string, result: EnsureResult, action: string): void {
	if (result.cancelled) {
		dialogs.notify(`${action}: cancelled.`, "info");
		return;
	}
	store.replaceSnapshot(tabId, result);
	if (result.editorText) composerRef?.loadText(result.editorText);
}

async function runCapability(tabId: string, action: string, fn: () => Promise<EnsureResult>): Promise<void> {
	try {
		applyCapability(tabId, await fn(), action);
	} catch (err) {
		dialogs.notify(`${action} failed: ${String((err as Error).message ?? err)}`, "error");
	}
}

/** Shared message picker for fork/rewind (user messages of the active transcript). */
async function pickForkTarget(tab: TabState, title: string): Promise<string | undefined> {
	const targets = await window.pi.listForkTargets(tab.tabId);
	if (targets.length === 0) {
		dialogs.notify("No user messages in this session yet.", "info");
		return undefined;
	}
	const chosen = await dialogs.selectLocal(
		title,
		targets.map((t) => ({ id: t.entryId, label: t.text || "(empty message)" })),
	);
	return chosen;
}

const tabActions: TabActions = {
	rename(tab: TabState): void {
		void (async () => {
			const name = await dialogs.promptLocal("Session name", tab.meta?.sessionName ?? "", "e.g. refactor auth flow");
			if (name === undefined) return;
			try {
				await window.pi.renameSession(tab.tabId, name);
			} catch (err) {
				dialogs.notify(`Rename failed: ${String((err as Error).message ?? err)}`, "error");
			}
		})();
	},
	clone(tab: TabState): void {
		void runCapability(tab.tabId, "Clone", () => window.pi.clone(tab.tabId));
	},
	changeFolder(tab: TabState): void {
		void (async () => {
			const dir = await window.pi.pickDirectory();
			if (!dir) return;
			await runCapability(tab.tabId, "Change folder", () => window.pi.cd(tab.tabId, dir));
		})();
	},
	forkMessage(tab: TabState): void {
		void (async () => {
			try {
				const entryId = await pickForkTarget(tab, "Fork from which message?");
				if (!entryId) return;
				await runCapability(tab.tabId, "Fork", () => window.pi.forkFromMessage(tab.tabId, entryId));
			} catch (err) {
				dialogs.notify(`Fork failed: ${String((err as Error).message ?? err)}`, "error");
			}
		})();
	},
	rewind(tab: TabState): void {
		void (async () => {
			try {
				const entryId = await pickForkTarget(tab, "Rewind to which message?");
				if (!entryId) return;
				const summarize = await dialogs.confirmLocal("Rewind session", "Summarize the dropped messages into a branch summary? (Cancel = rewind without summarizing)");
				await runCapability(tab.tabId, "Rewind", () => window.pi.rewind(tab.tabId, entryId, summarize));
			} catch (err) {
				dialogs.notify(`Rewind failed: ${String((err as Error).message ?? err)}`, "error");
			}
		})();
	},
	createAgentsMd(tab: TabState): void {
		store.setActive(tab.tabId);
		void sendPrompt("/init");
	},
};

function init(): void {
	installTooltip();
	// Drag-resized history width (CSS clamps 180–520px live in the Sidebar).
	void window.pi
		.getSettings()
		.then((s) => document.documentElement.style.setProperty("--sidebar-w", `${clampSidebarWidth(s.sidebarWidth)}px`))
		.catch(() => undefined);
	const sidebar = new Sidebar($("#sidebar"), (item) => void resumeSession(item));
	sidebarRef = sidebar;
	const tabsBar = new TabsBar($("#tabbar"), (tab, profileName) => {
		void (async () => {
			// A profile switch is a session-replacing capability: the returned
			// snapshot carries the new profile's default model, so the status
			// line chip shows it right away instead of keeping the disposed
			// session's.
			try {
				const result = await window.pi.setTabProfile(tab.tabId, profileName);
				tab.profileName = profileName; // before the "tabs" render inside
				applyCapability(tab.tabId, result, "Profile switch");
				dialogs.notify(`Tab switched to profile '${profileName}'.`, "info");
			} catch (err) {
				tab.profileName = profileName; // main-side switch already landed
				tabsBar.render();
				dialogs.notify(`Switch to profile '${profileName}' failed: ${String((err as Error).message ?? err)}`, "error");
			}
		})();
	});
	const chatView = new ChatView($("#chat"));
	dialogs = new Dialogs($("#modal-root"));
	const composer = new Composer($("#composer"), (text, attachments, mode) => void sendPrompt(text, attachments, mode), dialogs);
	composer.setActions(tabActions);
	composerRef = composer;
	const mainEl = $("#main");

	// Blank launch state: the centered new-chat form replaces chat + composer
	// until a tab exists. Typed text is sent as the session's first prompt.
	const newChat = new NewChatForm($("#newchat"), (text) => {
		void newTab(text).then((ok) => {
			if (ok) newChat.clear();
		});
	});
	function syncEmptyState(): void {
		const empty = store.order.length === 0;
		mainEl.classList.toggle("no-tabs", empty);
		newChat.setVisible(empty);
		if (empty) newChat.focus();
	}

	store.on((event) => {
		switch (event.type) {
			case "tabs":
				tabsBar.render();
				chatView.showTab(store.activeTabId);
				composer.sync();
				syncEmptyState();
				// History rows carry the live/active highlight.
				sidebar.render();
				break;
			case "active":
				tabsBar.render();
				chatView.showTab(store.activeTabId);
				composer.sync();
				syncEmptyState();
				sidebar.render();
				if (store.activeTabId) composer.focus();
				break;
			case "chat": {
				const tab = store.tabs.get(event.tabId);
				if (tab) chatView.refreshTools(tab);
				// Finalized messages carry usage/cost — refresh the status strip.
				if (event.tabId === store.activeTabId) composer.sync();
				break;
			}
			case "stream": {
				const tab = store.tabs.get(event.tabId);
				if (tab) chatView.renderStream(tab);
				break;
			}
			case "status":
			case "meta": {
				tabsBar.render();
				composer.sync();
				// meta keeps liveSessions (dots + active highlight) current.
				sidebar.render();
				break;
			}
			case "history":
				sidebar.scheduleRefresh();
				break;
		}
	});

	window.pi.onSessionEvent(({ tabId, event }) => store.applyEvent(tabId, event));
	window.pi.onSessionStatus(({ tabId, isStreaming }) => store.applyStatus(tabId, isStreaming));
	window.pi.onSessionMeta(({ tabId, meta }) => store.applyMeta(tabId, meta));
	window.pi.onDialogRequest((req) => dialogs.handleRequest(req));
	window.pi.onDialogNotify(({ message, type }) => dialogs.notify(message, type));
	window.pi.onProfilesChanged((data) => tabsBar.setProfiles(data));
	window.pi.onMenuAction((action) => {
		switch (action.action) {
			case "new-tab":
				void newTab();
				break;
			case "close-active-tab": {
				const active = store.activeTabId;
				if (active) void closeTab(active);
				break;
			}
			case "prev-tab":
				selectTabByOffset(-1);
				break;
			case "next-tab":
				selectTabByOffset(1);
				break;
			case "toggle-sidebar":
				sidebarRef?.toggle();
				break;
			case "edit-externally":
				void composerRef?.editExternally();
				break;
			case "reload-history":
				void sidebarRef?.refresh();
				break;
		}
	});

	window.addEventListener("pi:close-tab", ((e: Event) => {
		void closeTab((e as CustomEvent<{ tabId: string }>).detail.tabId);
	}) as EventListener);
	window.addEventListener("pi:new-tab", () => void newTab());
	window.addEventListener("focus", () => void sidebar.refresh());

	// Launches start blank: no tabs, no dialogs. Chats begin from the
	// new-chat form or File > New Chat (Cmd+N), which is where the folder
	// picker lives.
	void window.pi.listProfiles().then((data) => tabsBar.setProfiles(data));
	void sidebar.refresh();
	syncEmptyState();

	// Debug/automation hook: lets external drivers (CDP smoke) replicate the
	// newTab() flow (create tab + init store + ensure session) without the
	// native folder picker.
	(window as unknown as { __pi: { store: typeof store } }).__pi = { store };
}

let dialogs: Dialogs;

init();
