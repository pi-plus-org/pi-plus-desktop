/**
 * Diagram card: renders a draw_diagram tool result as a visual card — the
 * SDK-computed inline SVG (falling back to the tool's own box-drawing ASCII),
 * a counts header, the ASCII behind a fold, and an "Open HTML" button when the
 * tool wrote a standalone page. Fed by DiagramCardDTO, which main lifts from
 * the tool result's `details` (session-sanitize), so both the live tool row
 * and a resumed transcript render identically.
 */

import type { DiagramCardDTO } from "../../shared/ipc-types.ts";
import { notify } from "./dialogs.ts";

function el(tag: string, className?: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

export function renderDiagramCard(diagram: DiagramCardDTO): HTMLElement {
	const card = el("div", "diagram-card");

	const counts = `${String(diagram.nodeCount)} nodes, ${String(diagram.edgeCount)} edges`;
	const head = el("div", "diagram-head");
	head.append(el("span", "diagram-title", `⛁ ${diagram.title || "Diagram"}`));
	head.append(el("span", "diagram-counts", counts));
	if (diagram.htmlPath) {
		const btn = el("button", "diagram-open", "Open HTML ↗");
		btn.title = diagram.htmlPath;
		btn.addEventListener("click", () => {
			void window.pi.openPath(diagram.htmlPath!).then((error) => {
				if (error) notify(`Open failed: ${error}`, "error");
			});
		});
		head.append(btn);
	}
	card.append(head);

	// Visual body: the SDK layout's SVG when available (it shares geometry with
	// the ASCII, so the two views never disagree), otherwise the ASCII itself.
	if (diagram.svg) {
		const figure = el("div", "diagram-svg");
		// The SVG is SDK-generated markup with every spec label html-escaped at
		// the source (diagram/html.ts esc()); it carries no scripts.
		figure.innerHTML = diagram.svg;
		card.append(figure);
	} else {
		card.append(el("pre", "diagram-ascii diagram-svg", diagram.ascii));
	}

	// The ASCII stays reachable — it is exactly what the model saw.
	const fold = el("details", "diagram-ascii-fold");
	fold.append(el("summary", undefined, "ASCII"));
	fold.append(el("pre", "diagram-ascii", diagram.ascii));
	card.append(fold);

	return card;
}
