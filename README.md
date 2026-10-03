# pi-plus-desktop

Desktop app for [pi-plus](https://github.com/earendil-works/pi) built on Electron. It embeds `pi-plus-sdk` directly in the main process — no CLI subprocess — and provides:

- **Multiple tabs**, one agent session per tab
- **Session history sidebar** managed through SDK APIs (`SessionManager.listAll` / `search` / `deleteSession`): flat list ordered by last activity (newest first), a search box matching titles and full transcript content via the SDK, streaming indicator per open session, the active tab's session highlighted, click activates an already-open tab (or resumes into a new one); transcripts are not deletable from the UI; drag the panel's right edge to resize it (double-click restores the default; the width is persisted), reload the list with the header ⟳ button or ⌘R/Ctrl+R, and hide or show it with the header « button or ⌘B/Ctrl+B (hidden, only a » button remains at the window's edge)
- **Profile management** delegated to `pi-plus-sdk`'s pi-hub profile API (profiles in `~/.pi/profiles.json`), via the native app menu and a per-tab profile badge
- Full streaming chat UI: markdown rendering, collapsible thinking blocks, tool execution rows, compaction and retry notices
- **Session capabilities** per tab, driven by SDK APIs — a "⋯" menu right of the paperclip in the composer: rename, clone (in-place branch with full history), change folder (`/cd`), fork from message, rewind, create/improve `AGENTS.md` (`/init`)
- **Chat box**: a fixed 3-line rounded input (long drafts scroll inside) whose bottom strip carries the paperclip, the "⋯" session menu and the ✎ external-editor button on the left and a round Send (↑, Esc = Stop while streaming) on the right; the chatbox and its status line are per-tab — drafts and pending attachments park and restore as you switch tabs
- **Composer status strip** (above the chat box): model & thinking-level pickers (the model list is scoped to the tab's profile models), skills popover (click to insert `/skill:name`), manual compact with abort-while-compacting, the send-mode/queue chip, the last exchange's usage & cost, and a right-aligned context-usage gauge
- **Slash-command menu**: typing `/` at the start of a line pops the session-executable commands (extension commands, prompt templates, skills) with arrow-key selection, like the TUI
- **Steering queue**: sending while the agent streams queues the message as steer or follow-up — the "⇢ next: …" chip in the status strip toggles the mode and ✕ clears the queue
- **Compaction settings** under Settings (⌘,) → Compaction: auto-compact on/off (default profile's agent dir, shared with pipi), compact-at threshold, context floor and context-window cap — same controls as the TUI `/settings`
- **External editor** for the chat draft: the ✎ button in the chat box's bottom strip (also ⌘⌥E / Ctrl+Alt+E) round-trips the draft through an external editor; Settings (⌘,) → Editors is a picker of installed blocking-GUI editors (VS Code, Sublime, Zed, …, probed on PATH plus `/usr/local/bin` and `/opt/homebrew/bin`, since Finder/Dock launches get a minimal PATH), stored as absolute commands and re-resolved at spawn — terminal editors have no TTY here
- **Pinned chrome**: tab bar, composer status strip and input row never move — only the message area and the history list scroll, each independently
- **Tab & panel shortcuts** (⌘ on macOS, Ctrl elsewhere): ⌘N (or the ⌘T alias, or the + button — sits right after the last tab, pinned to the bar's right edge when the tabs overflow) for a new chat/tab, ⌘W close tab (on other windows, e.g. Settings, ⌘W closes the window; ⌘⇧W always closes the main window), ⌘⇧[ / ⌘⇧] cycle tabs, ⌘B toggle the history panel, ⌘R reload the history list, ⌘⌥E edit the draft in the external editor, ⌘, settings — buttons that have a shortcut show it in their hover tooltip
- Light & dark themes, following the system appearance by default, with a manual override under View → Theme (persisted across launches)

## Requirements

- Node.js ≥ 22.19 (Electron 39 ships Node 22.20)
- A working pi agent setup in `~/.pi/agent` (auth + models), same as the pi CLI

## Setup

`pi-plus-sdk` is consumed from the local [pi](https://github.com/earendil-works/pi)
monorepo as a `file:` dependency (`../pi/packages/plus-api/dist/npm`, installed as a
symlink) — so a checkout of pi next to this repo is required, and the npm registry is
never consulted for pi-plus artifacts. Build the staging tree first:

```sh
.claude/scripts/sync-pi-local.sh --no-test   # ../pi: build + SDK sync
npm install
```

If the Electron binary download times out on your network:

```sh
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
```

## Local SDK development

```sh
.claude/scripts/sync-pi-local.sh             # full loop: build + sync + tests
.claude/scripts/sync-pi-local.sh --fast      # skip monorepo build:offline (reuse dist/)
.claude/scripts/sync-pi-local.sh --sdk-only  # skip the plus-cli artifact build + tests
.claude/scripts/sync-pi-local.sh --no-test   # build + sync only
```

The script builds `pi-plus-sdk` from `../pi`, and the app picks it up live through the
symlink (rebuild only when `pi-plus-sdk`'s own dependencies change → re-run `npm install`).
It also builds the `pi-plus` CLI staging tree; refreshing the global `pipi` is manual:
`npm install -g ../pi/packages/plus-cli/dist/npm`. See `CLAUDE.md` for details.

To go back to the published SDK (e.g. to pack a distributable DMG), the inverse script
detaches the local link and installs from the registry — `sync-pi-local.sh` re-links afterwards:

```sh
.claude/scripts/unlink-pi-local.sh        # latest registry version; or: unlink-pi-local.sh 0.1.3
```

## Run

```sh
npm run dev     # esbuild watch + electron with reload on rebuild
npm run build   # production bundles in dist/
npm start       # run the built app
npm run typecheck
```

## Smoke test

Verifies the SDK embedding without Electron (creates a runtime in a temp dir, sends a prompt, asserts a reply, then round-trips clone-in-place and `/cd` relocation):

```sh
node scripts/smoke.mjs [provider]
```

Defaults to the `kimi-coding` provider. Exits with `SKIP` when no model/auth is configured.

## App icon

The icon is authored as `assets/icon.svg` (π + amber plus on a dark rounded square).
Rasterize and rebuild the `.icns` after editing it:

```sh
npm run icon   # renders assets/icon.svg → assets/icon.png via headless Electron
```

Then regenerate `assets/icon.icns` with `sips`/`iconutil` (see the loop in git history or `devops/scripts/pack-macos.sh`, which consumes the `.icns`).

## Packaging (macOS)

`devops/scripts/pack-macos.sh` builds a distributable with the project's own Electron binary — no extra tooling:

```sh
devops/scripts/pack-macos.sh        # → release/Pi+-<version>.dmg
```

It production-builds the bundles, assembles `Pi+.app` (Electron framework, app payload with production-only `node_modules` from `npm ci --omit=dev`, `Info.plist`, `icon.icns`), ad-hoc re-signs the bundle (required — the upstream Electron signature is invalidated by the modifications), and wraps it in a drag-to-install UDZO DMG. The `.app` exists only as transient staging (`dist/pack/`, removed afterwards); `release/*.dmg` is the sole artifact. Gatekeeper: an ad-hoc signed app opens locally but is not notarized; for distribution, re-sign with a Developer ID and notarize.

To install into `/Applications`, `.claude/scripts/deploy-pack.sh` builds the package itself and picks the mechanism automatically — no flags needed:

```sh
.claude/scripts/deploy-pack.sh          # auto: dev symlink install while the tree has
                                        # file:/symlinked deps, else DMG build + deploy
.claude/scripts/deploy-pack.sh --dev    # force the symlink mechanism
.claude/scripts/deploy-pack.sh --regular # force DMG: runs pack-macos.sh, then deploys it
.claude/scripts/deploy-pack.sh --keep   # DMG path: leave release/*.dmg in place
```

The dev install assembles `Pi+.app` from this working tree with `Resources/app/{dist,node_modules}` symlinked back into the repo — relaunching always runs the freshest `dist/` and `../pi` SDK builds, but the checkout (and `../pi`) must stay in place. The DMG path builds a fresh pack via `devops/scripts/pack-macos.sh` (which refuses while `file:` dependencies are present), mounts it read-only, quits a running instance, `ditto`s `Pi+.app` into `/Applications`, verifies the code signature, and deletes the DMG afterwards (unless `--keep`). For a distributable DMG, run `.claude/scripts/unlink-pi-local.sh` first (registry spec restored), pack, then `sync-pi-local.sh` to switch back.

## Notes

- **Default model**: the app uses whatever model the SDK selects from `~/.pi/agent/settings.json` (`defaultProvider`/`defaultModel`). If that model's provider isn't authenticated, session creation still succeeds but prompts fail — set a working default in `settings.json` or via a profile.
- **Profiles** live in `~/.pi/profiles.json` and are materialized to isolated agent dirs under `~/.pi/pi-hub/profiles/<name>/` (auth, settings, models, with shared extensions/skills/sessions symlinked) by the SDK's bundled pi-hub implementation — identical to what the `pipi` CLI does.
- Sessions are persisted by the SDK as JSONL under `~/.pi/agent/sessions/<cwd>/`, so desktop sessions also appear in the pi CLI and vice versa.
- **Auto-compaction** is a global setting in the profile's agent-dir `settings.json` — toggling it in a tab also affects `pipi` CLI sessions sharing that dir.
- **Change folder (/cd)** re-parents the session: the transcript is relocated to the new cwd's default session dir and the old file is removed (the session itself continues with full history).
- Run only one instance at a time: all instances share the Electron user-data dir.
