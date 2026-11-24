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

/** Clipboard write with a selection-based fallback: the async Clipboard API
 *  can reject for an unfocused document, so keep execCommand as the safety
 *  net instead of surfacing a failure. */
async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.append(ta);
		ta.select();
		const ok = document.execCommand("copy");
		ta.remove();
		return ok;
	}
}

/** Post-process a container holding sanitized markdown: wrap every fenced code
 *  block and give it a copy button (top right, revealed on hover). Runs after
 *  DOMPurify on purpose — the button markup is ours, never the model's.
 *  Idempotent, so repeated re-renders of the same node are safe. */
export function enhanceCodeBlocks(root: HTMLElement): void {
	for (const pre of Array.from(root.querySelectorAll("pre"))) {
		if (pre.parentElement?.classList.contains("code-block")) continue;
		const wrap = document.createElement("div");
		wrap.className = "code-block";
		pre.replaceWith(wrap);
		wrap.append(pre);
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "code-copy";
		btn.textContent = "Copy";
		btn.title = "Copy code";
		btn.addEventListener("click", () => {
			// marked terminates the code text with a trailing newline; copying it
			// would paste a blank first line in most editors.
			const raw = pre.textContent ?? "";
			const text = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
			void copyText(text).then((ok) => {
				btn.textContent = ok ? "Copied" : "Copy failed";
				setTimeout(() => {
					btn.textContent = "Copy";
				}, 1200);
			});
		});
		wrap.append(btn);
	}
}

/** Inline rendering for one-line previews (sidebar, notices). */
export function escapeHtml(text: string): string {
	const div = document.createElement("div");
	div.textContent = text;
	return div.innerHTML;
}
