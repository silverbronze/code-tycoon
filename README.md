# Code Tycoon

A live isometric city of a project and the Claude Code sessions working in it.

- **The city** is the architecture, not the folder tree: modules (folders, with look-alike siblings such as `logos/<site>` merged into one), data stores, outside systems (servers, sites, MCP services) and local areas are all places in one graph. Ties come from imports, files changed in the same task or commit, code that names a system, and tasks that used a system while working on a module. Connected places stand next to each other, groups of them form named districts, and roads join them; a road lights up when a session moves along it. Building height = size and commit churn.
- **Replay from the start** begins on empty ground: every file, module, store, system, road and label appears at its birth (first commit, first AI write, first use, or creation on disk).
- **Sessions are drones**, one colour each. A read is a scan beam, a write throws sparks and lights the building, a command puffs smoke, a remote call sends a packet to that system. Subagents are small drones tethered to their parent. A session waiting on a permission prompt gets a red light column.
- **Zoom** out for one building per module, in for one per file. Click a building for its imports, the tasks that touched it, and AI-written module descriptions.
- **Timeline**: activity histogram, one lane per session in view, git commits as landmarks (click one for the tasks behind it), nights shaded. Opens on the last 24 hours. Scrub, or play the whole history back at up to 7200×; quiet stretches are skipped.
- **Task log**: one entry per prompt you gave, with a short title written by Haiku through your own `claude` CLI, and everything that task changed, read, ran and called.
- **Alerts**: two open sessions editing the same file, two sessions working in the same module, a session that needs you. They are kept (bell in the top bar) until dismissed; "needs you" clears itself once the session moves on. Desktop notifications, switched on from the overview, fire while the tab is in the background.
- **Sessions panel**: grouped into needs you / working / your turn / idle, longest wait first, with the uncommitted files each session wrote. Hover a card to light up its footprint.
- **Uncommitted**: markers over files with uncommitted changes, in the colour of the session that wrote them (red: several sessions).
- **Colour modes**: buildings by district, recent edits, churn, or the last session that wrote them.
- **Digest tab**: one day at a time: tasks, sessions, commits, busiest modules, files edited by several sessions, new connections between parts (shown as arcs on the map), and an optional recap written by Haiku.
- **Cost**: API-equivalent cost per task, session and project, from the token usage in the transcripts at list prices (a subscription is not billed per token, so read it as relative spend). The timeline histogram switches between actions and cost.
- **Overview**: every open session in every project, waiting ones first; click one to open its project and follow it.

## Requirements

- Node 22.13 or newer (uses the built-in `node:sqlite`)
- Claude Code, with some sessions already run (transcripts in `~/.claude/projects`)
- `git` on PATH for commits, churn and uncommitted-file markers
- Optional: the `claude` CLI for AI task titles and recaps. It is found on PATH or inside the VS Code extension; set `VISUALIZER_CLAUDE` to point at it otherwise.
- Windows, macOS or Linux. Autostart at login is Windows only.

## Run

```
npx code-tycoon                  # http://127.0.0.1:4400, opens the browser
npx code-tycoon hooks install    # instant live updates; backs up ~/.claude/settings.json first
                                 # (an HTTP hook with a token header; VISUALIZER_HOOK=command for the old node hook)
npx code-tycoon hooks uninstall  # removes them again
```

Pick a project on the overview to track it; the first index of a large history takes a minute.
Without hooks the live view still works from transcript tailing, a second or two behind.
A second copy started while one is running exits quietly. `VISUALIZER_PORT` changes the port.

### From source

```
npm install
npm run build
npm start                # http://127.0.0.1:4400
npm run hooks:install
```

`npm run dev` runs the API and Vite with hot reload (http://127.0.0.1:5173).
`npm run autostart:install` starts the server hidden at every Windows login (logs to `~/.visualizer/server.log`); `npm run autostart:uninstall` removes it.

## How it works

The server only answers requests from this machine's own pages (Host and Origin are checked), and `/hook` needs the token in `~/.visualizer/token`, so another website open in the browser cannot read your prompts or post fake activity.

Everything is read locally from `~/.claude/projects/*/*.jsonl` (plus `subagents/`), parsed incrementally into `~/.visualizer/visualizer.db`. Nothing leaves the machine except the batched task-title requests, which go through your own `claude -p` (Haiku, no tools, no session saved, no hooks). Key-shaped strings in prompts are masked before they are stored or sent. Set `VISUALIZER_NO_LLM=1` to turn titling off.

The installer also sets `cleanupPeriodDays` to 3650 so Claude Code stops deleting transcripts after 30 days; the database keeps everything it has already indexed either way.

## Checks

- `npx tsc --noEmit -p .` — type check (Vite's build does not)
- `PID=<project path> node scripts/probe.mjs probe-out [--full-replay]` — screenshots at 1280 and 1920, fps, console errors, full-history replay (needs Chrome installed)
- `node scripts/live-test.mjs <git repo>` — two real sessions edit one file; expects the collision alert

## License

[AGPL-3.0](LICENSE). You can use, change and share it freely. If you run a modified version as a service for other people, you must publish your changes under the same license.

Code Tycoon is an independent project, not made or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.
