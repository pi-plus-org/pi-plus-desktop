// Visual renderer for draw_diagram results (see `session-sanitize.ts` — the
// tool result's `details` are lifted into a `DiagramCardDTO` on both the live
// event and the resumed-transcript DTO).
//
// The diagram is rendered as an inline figure embedded in the assistant's
// response (not a tool card). Two payload shapes:
// - `html` (the desktop's HTML diagram tool): the markup goes into a static
//   sandboxed iframe — scripts/forms/popups stay blocked, only HTML/CSS/SVG
//   render.
// - legacy node-edge cards (SDK pi-plus-diagram, replayed transcripts): the
//   recomputed SVG is the body, with the tool's own ASCII filling the frame
//   when no renderer was wired — same layout engine, so the two never
//   disagree.
// A small caption (title + Open-HTML link) sits underneath either body.

import type { DiagramCardDTO } from "../../shared/ipc-types.js";

/** Iframe height bounds: starts compact, fits the content once it loads. */
const HTML_FRAME_DEFAULT_HEIGHT = 320;
const HTML_FRAME_MAX_HEIGHT = 720;

function el(tag: string, className: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

/**
 * Static sandbox: no scripts, forms or popups. `allow-same-origin` (without
 * `allow-scripts`) only lets the parent measure the content height once the
 * frame loads — script execution stays blocked by the sandbox.
 */
function renderHtmlFrame(html: string): HTMLIFrameElement {
	const frame = el("iframe", "diagram-embed-frame diagram-embed-html") as HTMLIFrameElement;
	frame.setAttribute("sandbox", "allow-same-origin");
	frame.style.height = `${HTML_FRAME_DEFAULT_HEIGHT}px`;
	frame.addEventListener("load", () => {
		const doc = frame.contentDocument;
		if (!doc) return;
		const height = Math.max(
			doc.documentElement?.scrollHeight ?? 0,
			doc.body?.scrollHeight ?? 0,
		);
		if (height > 0) {
			frame.style.height = `${Math.min(height + 2, HTML_FRAME_MAX_HEIGHT)}px`;
		}
	});
	frame.srcdoc = html;
	return frame;
}

export function renderDiagramEmbed(diagram: DiagramCardDTO): HTMLElement {
	const figure = el("figure", "diagram-embed");
	if (diagram.html) {
		figure.append(renderHtmlFrame(diagram.html));
	} else if (diagram.svg) {
		const frame = el("div", "diagram-embed-frame");
		frame.innerHTML = diagram.svg;
		figure.append(frame);
	} else {
		const pre = el("pre", "diagram-ascii diagram-embed-frame");
		pre.textContent = diagram.ascii ?? "";
		figure.append(pre);
	}
	if (diagram.title || diagram.htmlPath) {
		const cap = el("figcaption", "diagram-embed-cap");
		if (diagram.title) cap.append(el("span", "diagram-embed-title", `⛁ ${diagram.title}`));
		if (diagram.htmlPath) {
			const open = el("button", "diagram-open", "Open HTML ↗") as HTMLButtonElement;
			open.type = "button";
			open.title = diagram.htmlPath;
			open.addEventListener("click", async () => {
				try {
					const err = await window.pi.openPath(diagram.htmlPath!);
					if (err) window.dispatchEvent(new CustomEvent("pi:notify", { detail: err }));
				} catch (e) {
					window.dispatchEvent(new CustomEvent("pi:notify", { detail: String(e) }));
				}
			});
			cap.append(open);
		}
		figure.append(cap);
	}
	return figure;
}
