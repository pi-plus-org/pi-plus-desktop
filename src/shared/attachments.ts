/**
 * Prompt-attachment helpers shared by main (composing the prompt text and the
 * readImage preview IPC) and the renderer (parsing composed prompts back into
 * chips/previews, including on session resume where only the stored text
 * survives). Keep the format in lockstep with AgentSession transcripts.
 */

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"]);

/** Extension-based image test; good enough for picker paths and previews. */
export function isImagePath(path: string): boolean {
	const dot = path.lastIndexOf(".");
	if (dot === -1 || dot === path.length - 1) return false;
	return IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

export const ATTACHMENT_MARKER = "[Attached files — read them to answer]";

export const MAX_ATTACHMENTS = 20;

/**
 * Path-reference attachments: the SDK's native `images` option is base64-only,
 * so files are appended to the prompt text by absolute path and the agent's
 * own file tools read them.
 */
export function composePromptText(text: string, attachments?: string[]): string {
	const paths = [...new Set(attachments ?? [])];
	if (paths.length === 0) return text;
	if (paths.length > MAX_ATTACHMENTS) {
		throw new Error(`Too many attachments (${paths.length}; max ${MAX_ATTACHMENTS}).`);
	}
	const lines = paths.map((p) => `- ${p}`).join("\n");
	return `${text}\n\n${ATTACHMENT_MARKER}\n${lines}`;
}

/**
 * Inverse of composePromptText: split a stored user message back into display
 * text + attachment paths. Returns the input untouched when no marker is present.
 */
export function parseComposedPrompt(text: string): { text: string; attachments: string[] } {
	const markerAt = text.lastIndexOf(`\n\n${ATTACHMENT_MARKER}\n`);
	if (markerAt === -1) return { text, attachments: [] };
	const block = text.slice(markerAt + ATTACHMENT_MARKER.length + 3);
	const paths: string[] = [];
	for (const line of block.split("\n")) {
		if (!line.startsWith("- ")) return { text, attachments: [] }; // not our format
		paths.push(line.slice(2));
	}
	if (paths.length === 0) return { text, attachments: [] };
	return { text: text.slice(0, markerAt), attachments: paths };
}
