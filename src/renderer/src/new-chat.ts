/**
 * New-chat form: the blank launch state. A centered card with an empty
 * prompt area and a "New chat" button. Enter (or the button) starts the
 * tab flow; typed text becomes the session's first prompt.
 */

export class NewChatForm {
	private root: HTMLElement;
	private textarea: HTMLTextAreaElement;
	private button: HTMLButtonElement;
	private onCreate: (text: string) => void;

	constructor(root: HTMLElement, onCreate: (text: string) => void) {
		this.root = root;
		this.onCreate = onCreate;

		const title = document.createElement("div");
		title.className = "newchat-title";
		title.textContent = "Pi+";

		const card = document.createElement("div");
		card.className = "newchat-card";

		this.textarea = document.createElement("textarea");
		this.textarea.className = "newchat-input";
		this.textarea.placeholder = "What should we work on?";
		this.textarea.rows = 3;

		const foot = document.createElement("div");
		foot.className = "newchat-foot";

		this.button = document.createElement("button");
		this.button.className = "newchat-btn";
		this.button.textContent = "New chat";

		const hint = document.createElement("div");
		hint.className = "newchat-hint";
		hint.textContent = "Enter to start a chat · Shift+Enter for newline";

		foot.append(this.button, hint);
		card.append(this.textarea, foot);
		root.append(title, card);

		this.textarea.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				this.submit();
			}
		});
		this.button.addEventListener("click", () => this.submit());
	}

	private submit(): void {
		this.onCreate(this.textarea.value.trim());
	}

	clear(): void {
		this.textarea.value = "";
	}

	setVisible(visible: boolean): void {
		this.root.classList.toggle("newchat-visible", visible);
	}

	focus(): void {
		this.textarea.focus();
	}
}
