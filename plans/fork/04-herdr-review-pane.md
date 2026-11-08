# Fork plan 04: reviewing inside Herdr

Status: **built** (2026-11-03); checked end to end against the installed daemon and
Herdr 0.1.12: a branch page and a worktree page drawn in the pane, unified and split; a
second open in the same tab reusing the pane; an edit redrawing it; a reviewed mark
flagged "changed since reviewed" after an edit; a real `pi` analysis of a commit page
going `none`, `running`, `current`. Not checked: analyses with children groups, a run that
fails in the pane. Fork-only, like [plan 01](./01-multi-repo-entry.md) to
[plan 03](./03-daemon-settings.md); builds on their daemon, settings and daemon-started
analyses. The pane and the Review bar that opens it are Herdr mods in this repo's `mods/`
([mods/README.md](../../mods/README.md)); this plan pins the daemon side and the contract the
pane draws from.

## Problem

herdr-t3's Review bar opens a worktree's review with `jin.review -d --pwa`: every review
leaves the Herdr window for the PWA or a browser, away from the agent that wrote the
change. Herdr mods cannot embed a web page (no web view, no WebAssembly), so the review
has to be drawn natively, from data the daemon already owns.

## Scope

1. **Review API**: the daemon serves one review page's diff, its groups (rule-based or
   the saved AI analysis), the reviewed marks and the analysis state, as JSON, with
   every diff line already highlighted in colors the caller picks.
2. **Writes the pane needs**: reviewed marks, starting an analysis, a file's full text.
3. **The analysis's agent and model**: the pane picks them as the app's Local agent
   settings do, in the shared settings (plan 03), from the agents the daemon finds.

The upstream review features the pane draws: group navigation, file diffs (unified or
split, collapse, the full file), the AI analysis (start, progress, notes, outdated),
one commit at a time, and reviewed marks. The pane and the Review bar are a pair: the bar picks the
diff and the commit, the pane does what's done to the diff shown. The pane publishes what it shows
in `shared("review.shown")`, by tab (`root`, `page`, `base`, `commits`); the bar's picks arrive through
`shared("review")`, a `base` keeping that diff's commits.

### Not in scope

- Chat, settings other than the local agent and its model, the ref picker, GitHub pull
  requests, and the fork's own features (local notes, the shell's tabs, commit
  notifications) in the pane.
- Remote machines: the daemon listens on this machine's loopback only.
- Analyses that need an API key: those keys stay in the browser (plan 03). The pane
  runs only the local agent the shared settings pick.

## Review API

Every route is a `POST` with a JSON body, behind the daemon's session cookie like the
rest of `/api/*`. The body names a worktree by `path` (registered on first use, as
`/api/launch` does) and a review by `page`, the same page `--analyze` takes:
`/worktree`, `/branch/<name>`, `/compare/<A...B>` or `/commit/<sha>`.

- `POST /api/review` `{ path, page, colors, rows?, firstRows? }` returns the review. `rows` names the files
  whose highlighted rows come with it (all of them when left out): a large diff's rows run
  to megabytes, past the 8 MB a pane reads at once, so the pane asks for the files in view and
  the next few, up to 3000 changed lines a read. `firstRows: true` adds the rows of the first
  group's files (its own and its children's) while they fit in 3000 changed lines, the first one
  always, so a pane that knows no group yet reads once, with `rows: []`. Every line is cut at
  1000 columns, where the pane stops drawing. The daemon fetches the
  page's diff with core's local source and, when it differs from the cached one,
  stores it with `putDiff`, so `changedSinceReviewed` and the saved AI result follow
  the same rules as a page load. `colors` maps syntax kinds (`keyword`, `string`,
  `comment`, `function`, `type`, `number`, `constant`, `foreground`) to hex colors; the
  daemon builds a Zed theme from them and highlights with `@pierre/highlights`, so the
  colors are the caller's theme, not a syntax theme of its own.
- `POST /api/review/analyze` `{ path, page }` starts the analysis through the worktree
  server, as `-d --analyze` does (plan 03); a run already going is followed, not doubled.
- `POST /api/review/status` `{ path, page }` returns `{ running, progress?, error? }` for the
  page's analysis, from the page's key and the worktree server, without reading the diff; with no
  worktree server started yet, `{ running: false }`. The pane polls it while a run goes and reads
  the review once the run stops.
- `POST /api/review/reviewed` `{ path, page, shas, reviewed }` sets reviewed marks and
  clears `changedSinceReviewed` for those files, as `DiffsStore.setReviewed` does.
- `POST /api/review/file` `{ path, page, file, colors }` returns one file's full new
  side, highlighted, for showing the whole file around its hunks.
- `GET /api/agents` lists the agent CLIs on `PATH` with their versions and model catalogs,
  as the worktree server's `agent-list` does; the pane writes its pick, and the language the analysis
  writes in, with the shell's `PUT /api/settings`. Whether the pane starts an analysis by itself is the pane's own
  setting: the app never starts a paid run unasked, so the shared settings don't carry it.

`firstRows` and `/api/review/status` came with [plan 05](./05-review-dataflow.md), and the pane
works against a daemon without them: an older one drops the unknown key, so the pane reads the
first group's rows in a second read, and answers the unknown route with an error, so the pane
polls `/api/review` with `rows: []` instead.

The review's shape:

- `files`: each file's path, status, counts, `sha`, `reviewed`, `changed` (reviewed, but
  changed since), `noisy` (collapsed at first, `GENERATED_PATTERNS`), `test`
  (`TEST_PATTERNS`), and, when asked for, its hunks as rows: `kind` (` `, `+`, `-`), old and new line
  numbers, and `tokens` (`[text, color]` pairs).
- `groups`: the saved AI analysis when there is one, else the rule-based groups, each
  resolved against the diff as the app's `resolveGroups` does: file paths still in the
  diff, `missing` paths, an `Uncategorized` group for the rest, notes per file with a
  line `anchor` only where a hunk shows that line, and `critical`. Unlike the app's, a
  group with none of its files left is dropped. A page's key names a range or the
  worktree, not its commits, so a push can leave it empty or holding other files: an
  analysis with no group left is of other files, and the page shows the rule-based
  groups with `analysis` `none`. The saved analysis stays for when its files come back.
- `analysis`: `none`, `current` (made for this head), `outdated` (made for an older
  head) or `running` with the latest progress; whether a local agent is set up.
- `commits`: the diff's commits, oldest first. A commit opens as `/commit/<sha>`.

Rule-based group text is English: the pane has no locale of its own.

## Analysis state

The worktree server (`daemon/child.ts`) owns the runs. The daemon asks it over IPC which
run is going for a cache key; `agent-running` also returns the run's latest progress
event and, once the last run for the key failed, its error, so the pane can say why.

## Open

- The pane polls while a run is going; a stream would push progress instead.
