/**
 * Custom hover tooltips. Native `title` bubbles are unreliable here: macOS
 * wants ~2s of perfectly still hover, and the tab/composer/sidebar chrome
 * re-renders well inside that window (focus refresh, session:meta pushes,
 * tab switches) — each replacement cancels the pending bubble, so it shows
 * only sometimes. Instead, a single document-level fixed bubble is shown
 * immediately on hover.
 *
 * Call sites keep declaring `title` (incl. dynamic updates like Send/Stop);
 * the manager lazily moves it to `data-tip` + `aria-label` on first hover,
 * so the native tooltip never fires and nothing else needs to change.
 */

let bubble: HTMLDivElement | null = null;
let current: Element | null = null;

function tipText(el: Element): string {
	// A freshly set title attribute (dynamic title updates) wins over the
	// cached data-tip.
	const title = el.getAttribute("title");
	if (title) {
		el.setAttribute("data-tip", title);
		el.setAttribute("aria-label", title);
		el.removeAttribute("title");
	}
	return el.getAttribute("data-tip") ?? "";
}

function show(el: Element, text: string): void {
	if (!bubble) {
		bubble = document.createElement("div");
		bubble.className = "pi-tooltip";
		document.body.append(bubble);
	}
	bubble.textContent = text;
	// Un-hide before measuring: a display:none node reports 0×0, which made
	// the edge clamps below no-ops and dropped the bubble on top of the
	// button. Positioning happens in this same task, so there is no visible
	// frame at the stale spot.
	bubble.hidden = false;
	const rect = el.getBoundingClientRect();
	const { offsetWidth: width, offsetHeight: height } = bubble;
	const GAP = 10;
	const EDGE = 8;
	const left = Math.max(EDGE, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - EDGE));
	// Prefer above the element; flip below when it would clip the top edge,
	// then clamp so the bubble never crosses a window boundary.
	let top = rect.top - height - GAP;
	if (top < EDGE) top = rect.bottom + GAP;
	if (top + height > window.innerHeight - EDGE) top = window.innerHeight - height - EDGE;
	bubble.style.left = `${left}px`;
	bubble.style.top = `${Math.max(EDGE, top)}px`;
	current = el;
}

function hide(): void {
	if (bubble) bubble.hidden = true;
	current = null;
}

export function installTooltip(): void {
	document.addEventListener("mouseover", (e) => {
		const target = e.target instanceof Element ? e.target : e.target instanceof Node ? e.target.parentElement : null;
		const el = target?.closest("[data-tip], [title]");
		if (!el) {
			if (current) hide();
			return;
		}
		const text = tipText(el);
		if (text && el !== current) show(el, text);
	});
	document.addEventListener("mouseout", (e) => {
		if (current && !current.contains(e.relatedTarget as Node | null)) hide();
	});
	// Any gesture or scroll that moves things away from the hovered element.
	window.addEventListener("mousedown", hide);
	window.addEventListener("wheel", hide, { passive: true });
	window.addEventListener("keydown", hide);
	// Re-rendered chrome replaces the hovered node: drop a stale bubble.
	new MutationObserver(() => {
		if (current && !current.isConnected) hide();
	}).observe(document.body, { subtree: true, childList: true });
}
