/**
 * Image preview loader: fetches data URLs for attachment paths via IPC
 * (the renderer is sandboxed and CSP blocks file: subresources). Results are
 * cached per path so composer chips and chat bubbles share one read.
 */

const cache = new Map<string, Promise<string | undefined>>();

export function thumbSrc(path: string): Promise<string | undefined> {
	let entry = cache.get(path);
	if (!entry) {
		entry = window.pi.readImage(path);
		cache.set(path, entry);
	}
	return entry;
}
