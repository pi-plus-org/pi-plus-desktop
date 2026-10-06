/**
 * TodoStrip: the pinned todo glance above the status strip — a read-only view
 * of the active tab's task list (pi-plus-tasks store, agent-managed via
 * TaskCreate/TaskUpdate). Sits above the composer toolbar (the status line)
 * inside #composer; visible only while the active session has tasks, hidden
 * otherwise. No add/check-off affordances by design.
 */

import type { TaskDTO } from "../../shared/ipc-types.ts";
import { store } from "./store.ts";

function el(tag: string, className?: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

const STATUS_GLYPH: Record<TaskDTO["status"], string> = {
	pending: "○",
	in_progress: "◐",
	completed: "✓",
};

export class TodoStrip {
	private el: HTMLElement;

	constructor(root: HTMLElement) {
		this.el = el("div", "todo-strip todo-hidden");
		// Above the status strip (composer toolbar), items stacked vertically.
		root.insertBefore(this.el, root.querySelector(".composer-toolbar"));
	}

	/** Reflect the active tab's task list (call on "tasks"/"active" events). */
	sync(): void {
		const active = store.active;
		const tasks = active?.tasks ?? [];
		if (!active || tasks.length === 0) {
			this.el.classList.add("todo-hidden");
			this.el.replaceChildren();
			return;
		}
		this.el.classList.remove("todo-hidden");
		this.el.replaceChildren(...tasks.map((task) => this.line(task)));
	}

	/** Mirrors the SDK's formatTaskLine shape: `#3 [in_progress] Fix auth bug
	 *  (alice) [blocked by #1]` — glyph conveys the status. */
	private line(task: TaskDTO): HTMLElement {
		const line = el("div", `todo-item todo-${task.status}`);
		line.append(el("span", "todo-glyph", STATUS_GLYPH[task.status]));
		line.append(el("span", "todo-id", `#${task.id}`));
		line.append(el("span", "todo-subject", task.activeForm ?? task.subject));
		if (task.owner) line.append(el("span", "todo-owner", `(${task.owner})`));
		if (task.blockedBy.length > 0) {
			line.append(el("span", "todo-blocked", `[blocked by ${task.blockedBy.map((id) => `#${id}`).join(", ")}]`));
		}
		return line;
	}
}
