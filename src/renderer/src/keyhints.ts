/**
 * Keyboard-hint notation.
 *
 * Hints are authored once in the macOS glyph form ("⌘⌥B"), because that is
 * what a Mac keyboard — and the native menu bar — shows. On Windows/Linux
 * those glyphs either name a key the machine does not have (⌘) or one it
 * labels differently (⌥), so the hint is re-rendered here into the notation
 * the OS itself uses: "Ctrl+Alt+B". Electron already formats its own menu
 * accelerators per platform; this covers everything the renderer writes.
 *
 * `tooltip.ts` runs every hover text through formatKeyHints(), which is why
 * call sites keep declaring a single `title` in glyph form and never branch
 * on the platform. Visible text (toasts, labels) calls formatKeyHints()
 * directly.
 */

export type KeyStyle = "mac" | "pc";

/** macOS modifier glyphs → the label the same key carries on a PC keyboard. */
const PC_LABEL: Record<string, string> = { "⌘": "Ctrl", "⌥": "Alt", "⌃": "Ctrl", "⇧": "Shift" };
/** Order the OS lists modifiers in (Ctrl+Alt+Shift+key), whatever order the
 *  hint happened to spell the glyphs in ("⌥⌘C" and "⌘⌥C" both read the same). */
const PC_ORDER = ["Ctrl", "Alt", "Shift"];

/** A chord: one or more modifier glyphs *immediately* followed by the base
 *  key (a single character — a letter, digit, or punctuation like "," or
 *  "["). Requiring that adjacency is what keeps a decorative glyph ("⌘
 *  Skills", where the glyph is an icon) from being read as a chord. */
const CHORD = /([⌘⌥⌃⇧]+)([A-Za-z0-9,.;:=\[\]/'+\\-])/g;

/**
 * Pure host → notation mapping (exported for the test; no DOM needed).
 * The bridge value is authoritative; the user agent is the fallback, and only
 * a Chromium-shaped one is trusted — a headless host that reports nothing
 * about an OS must not be guessed at. Unknown stays "mac", i.e. whatever the
 * hint spells itself.
 */
export function detectKeyStyle(platform: string, userAgent: string): KeyStyle {
	switch ((platform ?? "").toLowerCase()) {
		case "darwin":
		case "mas":
		case "ios":
			return "mac";
		case "win32":
		case "android":
			return "pc";
		default:
			break;
	}
	if (/^(linux|freebsd|openbsd|sunos)/.test(platform ?? "")) return "pc";
	// "Mozilla/5.0 (<system details>) …" — the parenthesised part is the OS.
	const ua = /^mozilla\/5\.0 \(([^)]*)\)/i.exec(userAgent ?? "")?.[1]?.toLowerCase() ?? "";
	if (ua.includes("macintosh") || ua.includes("iphone") || ua.includes("ipad")) return "mac";
	if (ua.includes("windows") || ua.includes("linux") || ua.includes("x11") || ua.includes("cros")) return "pc";
	return "mac";
}

/** Rewrite one glyph chord as "Ctrl+Alt+key" (deduped, canonical order). */
function pcChord(glyphs: string, key: string): string {
	const names: string[] = [];
	for (const glyph of glyphs) {
		const name = PC_LABEL[glyph];
		if (name && !names.includes(name)) names.push(name);
	}
	names.sort((a, b) => PC_ORDER.indexOf(a) - PC_ORDER.indexOf(b));
	return [...names, key].join("+");
}

/** Translate every chord in `text` into `style`'s notation (idempotent —
 *  formatted text carries no glyphs left to match). */
export function formatKeyHints(text: string, style: KeyStyle = currentKeyStyle()): string {
	if (style === "mac" || !/[⌘⌥⌃⇧]/.test(text)) return text;
	return text.replace(CHORD, (_match, glyphs: string, key: string) => pcChord(glyphs, key));
}

let forced: KeyStyle | null = null;
let cached: KeyStyle | null = null;

/** The running OS's notation, detected once. The preload exposes
 *  `window.pi.platform` synchronously (before any renderer module runs), so
 *  hints built in a component constructor already know the answer; the
 *  user-agent is only the fallback for a stubbed/absent bridge. */
export function currentKeyStyle(): KeyStyle {
	if (forced) return forced;
	if (!cached) {
		const host = globalThis as {
			window?: { pi?: { platform?: string } };
			navigator?: { userAgent?: string };
		};
		cached = detectKeyStyle(host.window?.pi?.platform ?? "", host.navigator?.userAgent ?? "");
	}
	return cached;
}

/** Pin the notation (tests); null restores detection. */
export function setKeyStyle(style: KeyStyle | null): void {
	forced = style;
	cached = null;
}
