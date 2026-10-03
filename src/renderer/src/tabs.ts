/**
 * Tab bar: one strip item per tab with a streaming spinner, a label, the
 * profile badge (click to switch the tab's profile) and a close button.
 * Session actions live in the composer's "⋯" menu next to the paperclip.
 */

import type { ProfilesDataDTO } from "../../shared/ipc-types.ts";
import { store, type TabState } from "./store.ts";

function el(tag: string, className?: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

export class TabsBar {
	private root: HTMLElement;
	private profiles: ProfilesDataDTO = { profiles: {} };
	private onSelectProfile: (tab: TabState, profileName: string) => void;

	constructor(root: HTMLElement, onSelectProfile: (tab: TabState, profileName: string) => void) {
		this.root = root;
		this.onSelectProfile = onSelectProfile;
	}

	setProfiles(data: ProfilesDataDTO): void {
		this.profiles = data;
		this.render();
	}

	render(): void {
		this.root.replaceChildren();
		for (const tabId of store.order) {
			const tab = store.tabs.get(tabId);
			if (tab) this.root.append(this.renderTab(tab));
		}
		// Trailing "+": File > New Chat (⌘N, ⌘T alias) as a visible affordance.
		const add = el("button", "tab-add", "+");
		add.title = "New chat (⌘N)";
		add.addEventListener("click", () => window.dispatchEvent(new CustomEvent("pi:new-tab")));
		this.root.append(add);
	}

	private renderTab(tab: TabState): HTMLElement {
		const node = el("div", "tab");
		node.dataset.tabId = tab.tabId;
		if (tab.tabId === store.activeTabId) node.classList.add("tab-active");
		node.title = `${tab.cwd}\n${tab.model || ""}`;

		if (tab.streaming) node.append(el("span", "tab-spinner"));

		const label = el("span", "tab-label", store.tabLabel(tab));
		node.append(label);

		const badge = el("button", "tab-profile", tab.profileName ?? "(no profile)");
		badge.title = "Session profile — click to switch";
		badge.addEventListener("click", (e) => {
			e.stopPropagation();
			this.openProfileMenu(tab, badge);
		});
		node.append(badge);

		const close = el("button", "tab-close", "×");
		close.title = "Close tab (⌘W)";
		close.addEventListener("click", (e) => {
			e.stopPropagation();
			window.dispatchEvent(new CustomEvent("pi:close-tab", { detail: { tabId: tab.tabId } }));
		});
		node.append(close);

		node.addEventListener("click", () => {
			store.setActive(tab.tabId);
		});
		return node;
	}

	private openProfileMenu(tab: TabState, anchor: HTMLElement): void {
		document.querySelector(".profile-menu")?.remove();
		const menu = el("div", "profile-menu");
		const entries: { name: string; label: string }[] = Object.keys(this.profiles.profiles)
			.sort((a, b) => a.localeCompare(b))
			.map((name) => ({ name, label: name }));
		for (const entry of entries) {
			const item = el("div", "profile-menu-item");
			if (tab.profileName === entry.name) item.classList.add("profile-menu-checked");
			item.textContent = "● " + entry.label;
			item.addEventListener("click", () => {
				menu.remove();
				this.onSelectProfile(tab, entry.name);
			});
			menu.append(item);
		}
		const rect = anchor.getBoundingClientRect();
		menu.style.left = `${rect.left}px`;
		menu.style.top = `${rect.bottom + 4}px`;
		document.body.append(menu);
		const dismiss = (e: MouseEvent) => {
			if (!menu.contains(e.target as Node)) {
				menu.remove();
				document.removeEventListener("mousedown", dismiss);
			}
		};
		document.addEventListener("mousedown", dismiss);
	}
}
