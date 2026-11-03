# Fork plan 03: settings and `--analyze` runs owned by the daemon

Status: **built** (2026-11-03); checked end to end with the fake Pi agent
(`cli/test/fake-agent.mjs`) and headless Chrome: a launch with no page analyzes and
saves; the same head again keeps the result; an edit analyzes again; the page shows
the saved result without another run; a fresh browser profile takes the daemon's
settings; a tab's change reaches the file without the API key. Not run with a real
agent or the installed PWA. Fork-only, like [plan 01](./01-multi-repo-entry.md)
and [plan 02](./02-review-workbench.md); builds on their daemon, shell and `--analyze`.

## Problem

- The settings live in the browser's `localStorage`, so the daemon and its worktree
  servers cannot see them: an analysis can only start from a page, with the page's
  settings.
- `-d --analyze` therefore depends on the page opening and loading. When the page
  is slow, fails or never opens (a launch from Herdr), no analysis runs.

## Scope

1. **Settings in the daemon**: the daemon keeps the non-secret settings, and every
   page it serves reads and writes them.
2. **`--analyze` started by the daemon**: the worktree server starts the analysis
   itself; the page follows it or shows the result.

### Not in scope

- API keys in the daemon. `gatewayToken`, `anthropicApiKey` and `openaiApiKey` stay in
  the browser only (plan 01, Security). A browser-run (keyed) analysis still starts
  from the page.
- UI preferences (layout, widths, wrap, theme): they stay per browser.
- Analyzing automatically on a new commit. The daemon's commit events could call the
  same entry later.
- The foreground `pulls.review` without the daemon: unchanged.

## 1. Settings in the daemon

- `~/.pulls.review/shared-settings.json` (written atomically, 0600) holds `locale` and the
  `llm` settings without the three keys. `GET /api/settings` returns it (`{}` when
  missing) with `defaultLocale`, the language an unset `locale` means: the system's, as
  the app's `detectLocale` picks the browser's; `PUT /api/settings` validates it against the providers, agent names and
  locales the build knows, and replaces it.
- The shell reads it before mounting and merges it into upstream's `diffs:settings`;
  then it writes the shared fields back on every change, once at start too, so the
  first run seeds the file from the browser. Every review under the daemon runs in a
  shell tab, the settings dialog writes the same origin's `localStorage`, and the
  shell sees it through `storage` events. `state/settings.ts` is unchanged.

## 2. `--analyze` started by the daemon

- `POST /api/launch` with a page carrying `?analyze` asks the worktree's server to
  analyze that page, when the settings pick a local agent (`provider: local-agent`
  and an `agent`); otherwise the page starts it as before. The launch answers at once.
- The daemon sends the worktree server `{ type: 'analyze', page, agent, model, locale }`
  over the IPC channel it already has.
- The worktree server maps the page to its target as the app does (`/worktree`,
  `/compare/<range>`, `/branch/<b>` against the default branch, `/commit/<sha>`; other
  pages are ignored) and, through its own registered RPC functions:
  - does nothing if a run for the diff's cache key is already going;
  - fetches the diff; keeps a cached `llm` result whose `headSha` is the diff's head;
  - stores the fetched diff when the cached one is missing or older;
  - starts `agent-analyze` with the key, so the run is shared, saved and followed
    exactly like one a page started.
- The page keeps `?analyze`: whichever side asks first starts the run, the other
  finds it by key. The worktree server reports nothing itself (its output is
  discarded): the page shows a failed run's error when it follows it, and starts the
  analysis itself when the server never did.
