// pi-plus-sdk re-exports the pi-plus-tasks store at runtime
// (packages/plus-api/src/api.ts re-exports subscribeToTasks / Task /
// TaskListListener / TaskStatus / TaskStore from plus/src/extensions/tasks/store.ts),
// but the hand-authored packages/plus-api/api.d.ts — copied verbatim to
// dist/npm — omits them, and the drift guard only checks `export function`/
// `const`/`interface` forms, not `export { ... } from` re-export blocks.
// Augment the module here so tsc sees what runtime already provides.
// Remove this file once the SDK's api.d.ts carries these declarations.
export {};

declare module "pi-plus-sdk" {
	export type TaskStatus = "pending" | "in_progress" | "completed";

	export interface Task {
		id: string;
		subject: string;
		description: string;
		activeForm?: string;
		owner?: string;
		status: TaskStatus;
		blocks: string[];
		blockedBy: string[];
		metadata?: Record<string, unknown>;
	}

	export type TaskListListener = (tasks: Task[]) => void;

	export function subscribeToTasks(listId: string, listener: TaskListListener): () => void;

	export class TaskStore {
		static forList(listId: string): TaskStore;
		subscribe(listener: TaskListListener): () => void;
		list(): Promise<Task[]>;
	}
}
