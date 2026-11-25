/**
 * Display sanitizer for the skill-invocation blocks pi writes into user
 * messages (`<skill name="..." location="...">\n...\n</skill>`, produced by
 * `_formatSkillInvocation` in the pi agent session). Transcripts store the
 * expanded text because the model reads it, but the chat view would otherwise
 * show the whole skill definition as the user's message. Stripping is
 * display-only: the transcript and the model keep the expanded text.
 */

const SKILL_BLOCK = /^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>\n*/;

/**
 * Remove leading skill-invocation blocks from a user message for display:
 * returns the user's own text after the blocks, or the invoked skill names
 * (`/skill:<name>`) when the message was only the invocation. Messages without
 * a leading block are returned unchanged.
 */
export function stripLeadingSkillBlocks(text: string): string {
	let rest = text;
	const names: string[] = [];
	for (;;) {
		const match = SKILL_BLOCK.exec(rest);
		if (!match || match[1] === undefined) break;
		names.push(match[1]);
		rest = rest.slice(match[0].length);
	}
	if (names.length === 0) return text;
	return rest.trim() || names.map((name) => `/skill:${name}`).join(" ");
}
