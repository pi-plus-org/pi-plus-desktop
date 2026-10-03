/**
 * Markdown rendering for assistant messages: marked + DOMPurify, both
 * framework-free. All model output is untrusted — never inject without
 * sanitizing.
 */

import DOMPurify from "dompurify";
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: false });

export function renderMarkdownToHtml(text: string): string {
	const html = marked.parse(text, { async: false });
	return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

/** Inline rendering for one-line previews (sidebar, notices). */
export function escapeHtml(text: string): string {
	const div = document.createElement("div");
	div.textContent = text;
	return div.innerHTML;
}
