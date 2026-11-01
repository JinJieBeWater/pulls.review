# Fork plan 02: a review workbench for agent worktrees

Status: **built** (2026-10-31); checked end to end in headless Chrome (see Experiments). Fork-only, like [plan 01](./01-multi-repo-entry.md);
builds on its daemon. Facts are pinned to `multi-repo` at `5be0810`.

## Problem

Coding agents work in many worktrees at once. Reviewing them has two slow steps:

- **Finding** what to review: nothing says which worktree has a new commit.
- **Feedback**: a problem seen in the diff is retyped in a terminal, with the file
  and line, before the agent can act on it.

Plan 01 listed notes and cross-repo lists as out of scope; this plan takes them on.
Picked because upstream does not plan them: Plan 09 rules out commenting on local
diffs for now, and a cross-repo view needs the daemon, which only the fork has.
If upstream later builds one of them, the fork's version is deleted for upstream's.

## Scope

1. **Local notes**: notes on diff lines of a local review, copied to an agent as
   Markdown.
2. **Persistent session and PWA**: the daemon's sign-in survives restarts; the shell
   installs as an app; a styled page says when the daemon is not running.
3. **Shell with in-page tabs**: one page with a tab per review, any change of any
   registered worktree.
4. **Commit notifications**: a dot on tabs and a system notification when an agent
   commits in any registered worktree.

Built in this order; each part is usable alone.

### Not in scope

- Start on login (launchd or a shell hook), Web Push, offline caching of the app.
- Notes on GitHub pull requests: those keep upstream's review comments.
- Replies, resolve, verdicts, review history, re-sending a sent note.
- Notifications for uncommitted changes, rebases, merges, pulls or cherry-picks;
  telling an agent's commit from the user's.
- A GitHub "review requested" inbox; saved tab groups beyond restoring the last set;
  closing tabs with Cmd+W.
- One daemon process for several worktrees (plan 01, Open).

## Upstream files touched

Every other change is a new file under `packages/app/src/local/` or
`packages/cli/src/daemon/`.

| File                                              | Change                                                        |
| ------------------------------------------------- | ------------------------------------------------------------- |
| `packages/app/src/local/rpc-backends.ts`          | `createRpcSource` gets `reviews` from the fork's notes store  |
| `packages/app/src/components/diff/FileDiff.vue`   | local notes render the fork's card and composer (2 places)    |
| `packages/app/src/components/diff/DiffPrMeta.vue` | local notes show the copy button instead of the review button |
| `packages/app/vite.config.local.ts`               | one more entry: the shell page                                |
| `packages/app/src/components/NavControls.vue`     | in a shell tab, hides language, settings and dark mode        |
| `packages/app/src/pages-local/index.vue`          | in a shell tab, hides its header                              |
| `packages/cli/package.json`                       | `chokidar` 6 as a direct dependency                           |

## 1. Local notes

The model is a list of change requests for an agent, not a conversation. A note is
**unsent** or **sent**; nothing else.

- **Write**: select one or more lines with pierre's gutter `+` or drag selection,
  exactly as on a GitHub pull request, and type the note. It shows under those lines.
- **Edit, delete**: any time. Editing does not change the state.
- **Copy**: one header button, `Copy N notes`, hidden when nothing is unsent. A click
  copies every unsent note of the worktree as Markdown, shows `Copied` briefly and
  marks them sent. No dialog.
- **Sent** notes stay under their lines faded (`op-fade`), to check against the next
  round's diff.
- **Outdated**: each note stores the text of its anchor lines. Where the lines no
  longer match, the note is hidden, as upstream hides outdated threads: the agent
  touched those lines and the diff shows the result.

Copied format, one block per note: `path:line` (or `path:start-end`), the diff
excerpt built with `buildChatQuote` (`components/chat/chat-quotes.ts`, the format
upstream already sends to models), then the note. The excerpt is stored with the note
when it is written, so a copy never needs the diff the note came from.

Wording (all 12 locales, x18n):

| Place                | English                       | 中文                   |
| -------------------- | ----------------------------- | ---------------------- |
| Composer button      | Add note                      | 添加批注               |
| Composer placeholder | Change request for the agent… | 写给 agent 的修改意见… |
| Header button        | Copy {n} notes                | 复制 {n} 条批注        |
| Sent badge, toast    | Copied                        | 已复制                 |

### Implementation

- **Storage**: one key per worktree root in the repo cache (`createRpcDriver`,
  `<git-common-dir>/pulls-review`), so notes are shared by every page of a worktree
  (`/branch/…`, `/worktree`, `/commit/…`) and survive browser changes. The
  `notes-update` RPC serializes changes on the worktree's server against the latest
  list, so simultaneous writes from its pages preserve each other's notes.
- **Data path**: the fork implements upstream's `ReviewsApi` for local sources, so
  `FileDiff.vue` keeps doing the gutter, selection, draft target and annotation slots.
  Mapping: a note is a one-comment thread; unsent is `pending`; copying calls
  `submitReview`; `reply`, `resolveThread` and verdicts are never offered. Viewer and
  author are both the user.
- **UI**: fork components, not upstream's `ReviewThreadCard`, `ReviewCommentCard`,
  `CommentComposer`, `DiffReviewButton` and `ReviewSubmitModal`, whose GitHub wording
  and actions (author, `Pending`, single comment vs. review, reply, resolve) do not
  fit. They copy upstream's structure and look: the card frame classes
  (`my-1 max-w-200 border border-base rounded-lg bg-base`), `@antfu/design`
  components (`ActionButton`, `ActionIconButton`, `FormTextarea`, `DisplayBadge`,
  `DisplayNumberBadge`) and `@comark/vue` Markdown. A note card holds the body, the
  `Copied` badge when sent, and edit/delete; no avatar, author, date or reply area.

## 2. Persistent session and PWA

- **Session**: the daemon keeps its session secret in `~/.pulls.review/` (0600) and
  reuses it after a restart; the cookie gets a long `Max-Age`. `HttpOnly`,
  `SameSite=Strict`, the Origin and Host checks and loopback-only stay. Without
  this, an installed app opened from the Dock after any restart shows
  `Run pulls.review -d to sign in`.
- **PWA**: a manifest and icons, `start_url` `/` (the shell), `display: standalone`.
  `127.0.0.1` is a secure origin, so Chrome installs it. The manifest declares
  `launch_handler.client_mode: focus-existing` and a `web+pullsreview` protocol
  handler at `/login?token=%s`. `pulls.review -d --pwa` opens
  `web+pullsreview:<one-time-token>` through the system URL handler. The browser
  brings the app to the front and reuses its window. Its `launchQueue` consumer
  exchanges the token for a session cookie and review path as JSON, then shows
  the page without reloading the shell. A cold launch uses the ordinary sign-in
  redirect; a repeated token delivered by the queue leaves that page in place.
  Launches are handled in order, so slow sign-in cannot overwrite a later target.
- **Updating an existing installation**: Chrome throttles manifest checks and can
  defer registration until the app closes. Restart Chrome, open the PWA once, then
  close it to apply the updated manifest. Allow protocol handling at Chrome's first
  prompt. These are browser permissions; the CLI does not change them. See
  [Chrome's manifest update rules](https://web.dev/articles/manifest-updates).
- **Daemon not running**: a minimal service worker (`/sw.js`) keeps the shell's own
  files, network first: fresh while the daemon runs, the last copy when it is down.
  Reviews (`/r/`), the API and sign-in always go to the network. The shell then shows
  its own empty state (pulls.review is not running, run `pulls.review -d`), checks
  every few seconds and reloads when the daemon answers. Being the shell, it has the
  app's UnoCSS, colors, dark mode and locale.
- The daemon is started by the user, never automatically.

## 3. Shell with in-page tabs

- `/` serves a shell page from a new entry in the `PR_LOCAL` build, written with
  `@antfu/design` and the app's UnoCSS so it reads as the same product. The shell
  MUST NOT load the devframe client: devframe publishes its connection on `window`
  for same-origin frames to inherit (`devframe/dist/client/index.mjs`,
  `readFromWindows`), and every tab would talk to the shell's worktree.
- A tab is one iframe at any `/r/<id>/…` URL: a branch, the working tree, a commit or
  a range. Switching only shows and hides frames, so scroll position, expanded files
  and half-written notes stay. Links inside a tab navigate that tab; the repository
  menu on the local home selects the picked worktree's tab, or opens one.
- One header row: the shell has the logo, the tabs and the page-wide controls (GitHub,
  language, settings, dark mode). Inside a tab the local home drops its header and a
  review's header keeps only its own toggles. The gear opens settings in the active
  tab, which has the app's context.
- A `+` at the end of the tab bar lists every worktree (the list and search of
  `RepositorySwitcher.vue`); picking one opens a tab. Each tab has a close button.
- The open tab URLs and the active tab are kept in `localStorage` and restored.
- The address bar names the active tab's page (`/r/<id>/…`). Opening such a URL in
  the address bar (`Sec-Fetch-Dest: document`) serves the shell, which shows that
  page in its worktree's tab; frames get the review itself. A page can be reloaded,
  bookmarked or shared.
- Shortcuts: Cmd/Ctrl+1–9 select a tab. The shell adds a `keydown` listener to each
  frame's `contentWindow` after it loads (same origin), so no code runs in the app.
- Frames need `allow="clipboard-write"` for note copying.
- `pulls.review -d` shows its page in the worktree's tab, taking the tab there, or
  opens a tab. `--pwa` delegates window reuse and activation to the installed app's
  protocol handler. Plain HTTP opening follows the default browser's behavior and
  may open another browser tab. Commit events remain on the daemon's event stream;
  launches do not use it. No browser scripting or per-platform focus code.

## 4. Commit notifications

- The daemon watches `<git-dir>/logs/HEAD` (the per-worktree reflog) of every
  registered worktree with chokidar 6, which survives git replacing the file. It
  rescans worktrees when the registry changes and when
  `<git-common-dir>/worktrees/` changes, since agents add worktrees often.
- On a change it reads the new reflog lines. Only messages starting with `commit`
  notify: `commit`, `commit (amend)`, `commit (initial)`, `commit (merge)`.
- Events reach the shell over a same-origin server-sent event stream on the daemon.
  Events while no shell is open are not kept.
- A worktree with a new commit gets a dot on its tabs and in the `+` list. Opening one
  of its tabs clears it.
- While the shell is open, a system notification (`Notification` API) is shown for
  every registered worktree: `repository / worktree: commit subject`. A click focuses
  the window and selects the worktree's tab, opening one if needed. No notification
  when that tab is active and the window focused; the dot only.
- A bell in the tab bar asks for permission on first click and then switches
  notifications on and off (kept in `localStorage`).

## Experiments (2026-10-30)

A throwaway shell on a test daemon (temporary `HOME`, port 7899), headless Chrome,
five tabs on real commits of four repositories:

| Check                         | Result                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Isolation                     | Pass once the shell had no devframe client; with it, every tab showed one repo.                              |
| JS heap per tab               | ~10–12 MB for a small diff, ~30 MB for a 30-file diff; 78 MB for five tabs.                                  |
| Switching                     | ~33 ms (two frames).                                                                                         |
| Shortcut with a frame focused | The shell's own listener misses it; a listener on the frame's window catches it and can prevent the default. |

Built (2026-10-31), test daemon and throwaway repositories, headless Chrome:

| Check                | Result                                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Notes                | Gutter `+` opens the composer; `Copy 1 note` copies the labelled excerpt and the note; the card turns faded with `Copied`; it survives a reload.                                                                         |
| Shell                | `-d` lands on the shell with its worktree; `+` opens another; a frame's own navigation updates its tab and the saved URL; Cmd+2 with a frame focused switches; tabs restore after a reload; closing selects a neighbour. |
| PWA                  | No installability errors; the service worker controls the shell.                                                                                                                                                         |
| Daemon down and back | The cached shell says pulls.review is not running, reconnects by itself and is still signed in.                                                                                                                          |
| Notifications        | A commit in a background worktree dots its tab and shows `repository · branch` with the subject; a checkout does not; selecting the tab clears the dot; a worktree without a tab still notifies.                         |

Concurrent note additions from two page APIs are covered by a regression test
against the server's shared updater.

Not verified: DOM and GPU memory, very large diffs, shortcuts and notifications inside
an installed app window (headless Chrome has none), the no-notification rule for the
focused active tab.

Tab labels are `repository · branch`; the page's own title goes in the tooltip and
the window title.

PWA launch (2026-11-01): an isolated Chrome 156 profile installed the built app and
registered its protocol in the native macOS app bundle. Launching the protocol's
callback URL through Chrome's PWA launcher reused the same window and document,
kept one tab per worktree, selected the requested review, and worked from a closed
app. The first OS/browser protocol permission prompt was not exercised in headless
Chrome. Windows and Linux were not run. The 42 daemon/shell checks (including the
built-worker smoke test), both packages' type checks, and changed-file lint passed.

Native macOS follow-up (2026-11-01): restarting Chrome with session restore and
opening the existing PWA updated its protocol registration without reinstalling.
The system handler resolved to that app. Two actual `-d --pwa --worktree` launches
reached the current repository: the cold launch redirected to its review and the
warm launch exchanged its credential as JSON. The PWA process and Chrome's native
window IDs stayed unchanged on the second launch. This checked the CLI path used
by the Herdr button; no desktop input automation was needed.
