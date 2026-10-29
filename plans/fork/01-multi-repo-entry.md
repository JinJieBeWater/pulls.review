# Fork plan 01: one local entry for every repo (`pulls.review --daemon`)

Status: **built** on 2026-10-28; verified with stub agents only (see Experiments). Fork-only (`JinJieBeWater/pulls.review`, branch
`multi-repo`; `main` only mirrors upstream); kept under `plans/fork/` so it never collides with upstream's `plans/NN-*`
numbering. Changes that would also make sense upstream are marked _upstream
candidate_ and land as separate commits.

Builds on Plan 09 (the `pulls.review` devframe server and the `PR_LOCAL` build) and
Plan 11 (local agents). Facts below are pinned to upstream `main` at
`3b1402e5917edb018764f2feebaa6613d17308b3` (npm `0.3.4`).

## Problem

Every repo needs its own `pulls.review` run, and the web settings live in that
origin's `localStorage`, so they are set again whenever the origin changes (another
port, the hub mount). There is no single place to start, pick a repo and review.

This plan only adds an entry point around the existing review. What happens inside a
review (pages, grouping, AI analysis, chat, cache, reviewed marks) stays upstream's.

## Scope

Three additions, nothing else:

- one web entry that lists registered repos and their worktrees;
- a `pulls.review --daemon` mode that makes sure the server is running;
- settings set once, shared by every repo, kept across restarts: every worktree is
  served from the daemon's one origin, so upstream's `localStorage` already covers it.

### Acceptance criteria

1. Running `pulls.review -d` makes the entry available; no per-repo CLI run.
2. A repo is added once and remembered; repos are switched from the same entry.
3. Every existing web setting is set once, shared by all repos and survives restarts.
4. Worktrees of one repo are not separate repos, and a review reads the right
   working directory.
5. Inside a repo, the upstream UI, actions and capabilities are unchanged.

### Not in scope

- Immutable per-round snapshots, cross-round comparison, notes, accept/reject flows.
- Independent AI reviewers, multi-agent review, dispatching or managing agents.
- Multi-client sync, remote or multi-user access, cross-device or cloud sync.
- Desktop app, TUI, start on login, cross-repo pending-review lists.
- Per-repo settings overrides.

These limit new work only; nothing upstream already does is removed.

## Command and address

- Two new flags on the existing `pulls.review` / `pulls-review` bin: `--daemon` (`-d`)
  and `--stop`. Without them the command is unchanged: a foreground server for the
  current repo on 7390. Flags, not subcommands, because the positional `[target]` can
  be any git revision, and a branch could be named `stop`.
- The daemon's fixed address `http://127.0.0.1:7855` (PULL on a phone keypad; IANA
  7848-7868 is unassigned), with an exact Host check, so `localhost:7855` is refused.
  If the port is taken by something else, fail; never pick another port. The existing
  `--port` overrides it for tests.
- `pulls.review -d` in a repo: probe 7855; if nothing answers, start the daemon as a
  detached process (logs and pid in `~/.pulls.review/`); register the repo if new;
  open the current worktree; exit. Running it again only opens the repo. It runs
  alongside a foreground `pulls.review` on 7390. Outside a Git checkout, `-d` fails
  like the standalone command and opens nothing.
- `pulls.review --stop` stops the daemon and every worktree process, using the pid in
  `~/.pulls.review/`.
- `-d` takes no target in the first version (branch, `--worktree`, PR URL): upstream's
  own picker covers them.
- All daemon state shares upstream's `~/.pulls.review/` with `devframe/`.
- Not published. After building, `bun link` in `packages/cli` puts the fork's
  `pulls.review` on `PATH`.

## Flow

- There is no repository page. The local home shows the current repository above
  its compare form; under `/r/<id>/` that row is a dropdown listing every registered
  repo's worktrees and their checked-out branches. Picking one is a plain link, so it
  leaves the instance; standalone and hub pages show the row without the dropdown.
- A bare `/` redirects to the last worktree opened since the daemon started, else
  says to run `pulls.review -d` in a repo.
- Add a repo from the dropdown by pasting its path (validated server-side with
  `git rev-parse`) or by running `pulls.review -d` in it. Removing a repo only drops
  the registration; the open repo cannot be removed from its own page.
- The registry is `~/.pulls.review/repos.json`, `{ "repos": [{ "path": "..." }] }`, written
  atomically. It holds repos only: `path` is the realpath of the main checkout, so
  running `-d` in a linked worktree registers its main checkout and a repo is never
  listed twice. Worktrees are read live with `git worktree list --porcelain` when a
  repo expands, so nothing goes stale.
- `/r/<id>/` ids are not stored: each is derived from the worktree's realpath (name
  plus a short hash, e.g. `jin-music-3f9a`), so links survive restarts.
- Opening a worktree starts, on demand, a `pulls.review` instance bound to that
  directory, served under `/r/<id>/` with HTTP and WS proxied. It behaves like running
  `pulls.review` in that directory; other branches, commits, ranges and uncommitted
  changes are picked in upstream's own picker.

One instance per worktree, not per branch: pages are organized by comparison target;
diffs and full files come from Git objects, not the checkout; the cache key is the
worktree root plus target (`core/src/local/source.ts`), so an instance per worktree
keeps existing caches; local agents read the full patch and only read the instance's
checkout for extra context (`cli/src/agents/rpc.ts`, `run.ts`,
`core/src/analyze/adapters/llm/prompt.ts`).

Known trade-off: a branch picked in the picker but checked out in another worktree
still opens in the current instance, so agent context comes from the current
directory. Same as upstream; not handled.

## Architecture

- **Daemon** (port 7855, loopback only, on `h3`, already a CLI dependency):
  repository API, registry, process manager, HTTP/WS proxy.
- **One child process per opened worktree** calling the existing devframe definition:
  `createDevServer(def, { basePath: '/r/<id>/', host: '127.0.0.1', port: 0,
openBrowser: false, auth: ctx => createInteractiveAuth(ctx, { clientAuthTokens:
[token] }) })`. Keep `def.id` (`pulls.review`): devframe's auth store follows it
  (`~/.pulls.review/devframe/`), not the display name or version.
- Children stay until the daemon exits or `pulls.review --stop`. No idle reaping.
- Separate processes because the RPC binds the startup cwd and mounting several
  devframes in one server needs devframe internals. Revisit if a source change makes
  one process simpler.

## Source changes

Commit rules are in `AGENTS.md` (Fork maintenance).

1. **Server-decided base** (_upstream candidate_). `runtimeBase()` in
   `packages/app/vite.config.local.ts` decides `<base>` in the page and only knows `/`
   and `LOCAL_HUB_BASE_PATH`. Let the server write a static `<base href>` for its
   `basePath` when it serves `index.html`. A page-decided base also breaks deep links:
   the preload scanner fetches `./assets/` against the route before the script runs.
2. **Export the ref-route SPA fallback** (_upstream candidate_) from
   `packages/cli/src/index.ts`, so the server reuses it instead of copying it.
3. **`--daemon` / `--stop` and the daemon** (fork-only), in new modules under
   `packages/cli/src/daemon/`; `index.ts` only routes the two flags there.

## Security

- Listen on loopback only. Never `auth: false`.
- `pulls.review -d` opens the browser with a short-lived one-time URL token; the server swaps it
  for an `HttpOnly`, `SameSite=Strict` cookie and redirects to the URL without it.
  `/`, the server's own endpoints and `/r/<id>/*` (HTTP and WS) all require that
  cookie and an exact Host; requests carrying Origin, writes and WS must be
  same-origin.
- The devframe token is held by the server, handed to children over IPC, and injected
  by the proxy into the WS URL it forwards. The browser never holds it and never sees
  the OTP prompt. Native revoke does not remove `clientAuthTokens`; rotate by
  restarting children.
- Start children with umask 077: an existing `~/.pulls.review/devframe/auth.json` is
  still honoured, and devframe rewrites it 0644 by default. Never delete a user's
  existing auth file.
- Logs carry method, path and status only: no query (the WS URL carries the token),
  cookies or frames.
- Repo paths are validated and resolved with `realpath`; only registered ids are
  proxied; Git runs with argument arrays.
- Secrets live only in the browser's `localStorage`, never
  in queries, URLs, logs or reports.
- Reviews stay read-only. Never clear settings, credentials or caches as part of
  setup; deleting or resetting needs its own confirmation.

The invariant "nothing is proxied through a server we run" is about the site. The
daemon is the user's own process, like the CLI.

## Experiments (2026-10-28)

Run against npm `pulls.review@0.3.4` (same as upstream `main`), `devframe@1.2.6`,
headless Chromium, throwaway repos with a linked worktree, and a stub Pi agent. The
prototypes patched the built `index.html` and injected a boot script instead of
changing source, so the base row must be re-run on the fork build.

| Experiment         | Result                                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Auth store path    | Pass. Follows `def.id`, not name or version.                                                                                                                                               |
| Native shared auth | Fail. Each child reads `auth.json` once at start and then trusts only memory; children also overwrite each other's records. Replaced by the cookie plus injected token.                    |
| Unified auth       | Pass. One-time URL to cookie; two instances usable without OTP; no cookie gives 401 on pages, boot and WS; replayed launch URL rejected; old token rejected after rotation.                |
| `basePath`         | Fails with only `basePath` (hard-coded `<base>`, blank page). Passes with a static base and deferred assets: 10 routes loaded and reloaded, zero resource errors, ids kept, data isolated. |
| Streaming          | Pass with the stub agent: analysis started from the UI renders completely; 24 WS messages identical direct and proxied.                                                                    |

Not verified: real model calls; long streams, reconnects and cancel; Safari and
Firefox; SSE transport; a full
security review (CSRF, DNS rebinding, body limits).

## Open

- Whether one process can host several worktree instances once the cwd is a
  parameter.
