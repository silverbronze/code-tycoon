# Visualizer

Live isometric city of a project's code plus the Claude Code sessions working in it.
Server: `server/` (Node 22, built-in `node:sqlite`, `ws`). UI: `web/` (Vite + TS + Three.js).
Data: `~/.visualizer/visualizer.db`. Hook script: `~/.visualizer/hook.mjs` (copied by `npm run hooks:install`).

- `npm run dev` — API on :4400 + Vite on :5173 · `npm run build && npm start` — everything on :4400
- `PID=<tracked project id, e.g. c:/users/archi/downloads/visualizer> node scripts/probe.mjs probe-out` — screenshots + fps + console errors (uses installed Chrome; exits without `PID`)
- `node scripts/live-test.mjs <demo repo>` — two real sessions edit one file, expects a collision alert

## Known Pitfalls

- `node:sqlite` does not support repeated numbered params (`?1` used twice → "column index out of range") — use named params (`$pid`) and pass an object.
- SQLite `MIN(x, NULL)` is NULL, so `first_ts=MIN(first_ts, ?)` wiped values when a chunk had no timestamp — wrap with `COALESCE(..., first_ts)`.
- `claude -p ... --allowedTools A,B "<prompt>"`: `--allowedTools` is variadic and swallows the prompt ("Input must be provided") — send the prompt on stdin.
- The `claude` CLI is not on PATH here; it lives in `~/.vscode/extensions/anthropic.claude-code-<ver>-win32-x64/resources/native-binary/claude.exe` and the folder changes on every update — resolve it at runtime (`findClaudeCli()`).
- Summarizer calls must use `--no-session-persistence --setting-sources project` from `~/.visualizer/summarizer`, or they write transcripts and fire hooks and Visualizer draws its own summarizer.
- Parallel Claude sessions edit this repo at the same time (one rewrote `world.ts` minutes after another session edited it, silently dropping those edits). Before a build or restart, grep your own changes back out of the files and check mtimes. If another session is mid-refactor, stop and coordinate.
- Playwright's bundled headless shell is not downloaded on this machine — launch with `channel: 'chrome'`.
- `/hook` rejects posts without the `x-visualizer-token` header (token in `~/.visualizer/token`). After changing the hook or the server's checks, re-run `npm run hooks:install` together with the restart, or every hook event is dropped with a silent 403.
- Session cards are rebuilt on every `session` message, so a hovered card can be replaced under the cursor and its `mouseleave` never fires — anything tied to hover state belongs on the list container, not the card.
- `npm run build` (Vite) does not type-check and ships code with TS errors (e.g. a local `h` shadowing the `h()` helper) — run `npx tsc --noEmit -p .` from the repo root (no tsconfig in `web/`) before building.
- An element hidden by a CSS rule (`display: none`) stays hidden when its inline style is set to `''`; set an explicit value (`'block'`) to show it.
- A side Vite server (`npx vite --port 5191`, for testing without restarting :4400) listens on `localhost` (IPv6) only; `127.0.0.1:5191` is refused. Point probes at `http://localhost:5191`. Start it from the repo root (`vite.config.ts` lives there, `root: 'web'`); run from `web/` it has no `/api` proxy and the page never loads.
- Layer classes in `styles.css` are generic and global (`.schematic`, `.stage`); using one as a modifier (`ly-thumb schematic`) pulled in `position:absolute; inset:0`. Don't reuse them as modifier class names.
- `node --experimental-strip-types` rejects TS parameter properties (`constructor(public x)`); use `--experimental-transform-types` to run a `.ts` module directly.
- Districts are roles, not graph communities: `server/roles.mjs` + `assignRoles` in `summarize.mjs` (kv `roles:<pid>`); a folder split across roles yields several modules with the same `id` — use `m.key` when you need a unique module id.
- Block and district properties (Database: engine/tables/migrations, Payments: providers/currencies…) are regex detectors per role in `server/traits.mjs` (`KINDS`); a project-specific district borrows a kind by name via `kindOf()`. Add a property there, not in the UI; `propsSection()` in `cityview.ts` renders whatever comes back.
- District looks are a closed catalog: `STYLES` + `styleOf()` in `server/roles.mjs` (summarizer picks one per project district, keywords and a hash fall back), drawn by `city/themes.ts` (facades, roof pieces), `city/dressing.ts` (props, parks, river/rail/airfield) and `city/life.ts` (people, vehicles). Add a new look to all three, not just the server list.
- Roads are routed on a grid in `city/roads.ts` + `city/route.ts`; the schematic layer (`schematic.ts`) routes its own connectors with the same router. world.ts only holds hooks into them.
- `StreetGrid.corners()` + `port()` leave repeated/collinear points, which hide Z and L shapes from any shape test — run `collinear()` first (schematic rules 8-12 are the metro-map rules; keep new line drawing to them).
- Dragged places (areas, stores, towers) are kept per browser in localStorage `vz-layout:<pid>` and laid over the server layout by `applyLayout()` (`city/layout.ts`) right after `api.city()`. Any new code path that fetches the city must call it too, or the city and the schematic disagree with what the user arranged.
- The user views the app on :4400, which serves `dist/` — UI changes don't show until `npm run build` (static files are read per request, so no restart needed; server `.mjs` changes do need one).
- Git Bash's `/tmp` is not the `/tmp` node resolves (`require('/tmp/x')` → C:\tmp) — write scratch files to the session scratchpad and pass node a Windows path.
- Bash heredocs here collapse `\\` to `\` even with a quoted `'EOF'` (a patched `'\n'` became a real line break, a test regex broke) — write scripts and code with backslashes via the Write/Edit tools, then `node --check`.
- `python` is only the Windows `py` launcher stub here (prints usage, does nothing) — script file edits with `node` or the Edit tool.
- The `sessions` table only holds sessions of tracked projects (Visualizer itself is untracked); anything machine-wide (e.g. `server/idle.mjs` naming CLI processes) must also read `~/.claude/projects/*/*.jsonl` directly.
- A node process with no parent is often a daemon the user started on purpose (`~/.claude/mcp-gateway`, `sync-skills.js watch`, this server itself), not a leftover — idle detection only flags parentless helpers from `node_modules`/npx.
- `git add <file>` on a deletion already staged by `git rm` fails ("pathspec did not match") — chain every add/commit step with `&&` so a later `git add -A && commit` can't sweep everything into the wrong commit.
- `npm publish` here goes through npm's staged publishing: the registry shows a `0.0.0-stage` placeholder as `latest` until the real version is approved on npmjs.com (needs 2FA) — check `npm view <pkg> version` before telling anyone it's live.
- GitHub renders every `user-attachments/assets/...` URL in a README as a video player, even inside `<a href>` — put it only on its own bare line, never as a link target.
- `import('C:/...')` in a Windows node script fails (ERR_UNSUPPORTED_ESM_URL_SCHEME) — use `file:///C:/...`.
- The city opens at viewSize ≈ span×0.9 (≈250 for a mid-size repo), not the Stage default 60, and file buildings show up to viewSize 120. Pick zoom-gated effects' thresholds against those numbers and check them in a probe screenshot, or the effect never appears for the user.
- Prompts sent by `claude -p` are `turnOrigin: "sdk"` and the parser counts only human prompts, so scripted demo sessions give 0 tasks — for demo data, retag copies of the transcripts to `"human"` before indexing.
- Codex CLI sessions are a second source: `server/codex.mjs` parses `~/.codex/sessions/**/rollout-*.jsonl` (`event_msg` → `item_completed`) into the same items as `transcript.mjs`; `indexFile` branches on `isCodexFile`, slugs are `codex:<slug>`. A new source must emit the same item kinds, not new ones.
- `codex exec --full-auto` no longer exists, and `-s workspace-write` falls back to read-only on Windows (every command blocked) — to make a test rollout, use `--dangerously-bypass-approvals-and-sandbox` in a scratch repo.
- Another session's side Vite may already hold :5191; Vite then silently takes the next port — read its "Local:" line before pointing a probe at it.
- Coaching (`server/coach.mjs`) caches each session's analysis keyed on its usage rows; anything that changes compactions or `res_len` without new API calls (a backfill) must call `resetCoach()`, or the overview keeps stale numbers.
- An isolated demo server (`USERPROFILE`/`HOME` = a fake home, `VISUALIZER_PORT=4401`, `CLAUDE_CONFIG_DIR` = the real `~/.claude` so titling still authenticates) keeps private projects off screen. `discover()` skips junctions (Dirent isn't a directory), so copy transcripts in; start it from outside the repo or its PowerShell sampler drops a `Microsoft/` cache folder into the cwd.
- README media (`docs/media`) scripts live outside the repo in `~/Downloads/demo/capture/` (README.txt there has the steps). The demo sessions are hours old by re-shoot time, so start the :4401 server with its `shift-clock.mjs` preload or the overview shows 0 open sessions and the timeline is empty.
- The UI chrome is black and white (tokens in `styles.css` `:root`; `--cyan/--green/--amber` now resolve to black, red is the only signal color). The city defaults to a light day to match (`sky.ts` `enabled=false` = always day; ground, grid, lots, plates and asphalt follow `ENV.night` via `World.tone()`/road shader; `.cityview.day` restyles labels). Open ground is grass (`groundMaterial()` in world.ts) and the woods/meadows around the city come from `wild()` in dressing.ts; the two use the same noise formula, change both together. The schematic canvas is light too (`NODE`/`COL` in schematic.ts, legend swatches `.lg-node` in styles.css, thumbnails in cityview.ts must agree). Don't bring tinted rgba fills back into panels.
