# Fork plan 05: what a click on the Review bar sets going

Status: **built** (2026-11-05), checked with each mod's check, the daemon's tests and the installed
daemon's answers to the older-daemon cases; not yet clicked through in a window. Fork-only, following
[plan 04](./04-herdr-review-pane.md).

## Problem

A review of the data flow after a click found three bugs and needless work, measured on a
199-file diff against the installed daemon: every read runs the whole `git diff` (280-430 ms,
73 KB without rows; 149 ms even with nothing to show), an open takes two of them, and more
follow every 1.5 s during an analysis, every 15 s, on any file change and on any group switch.

| # | Finding | Owner |
| --- | --- | --- |
| 1 | A page seen before never gets its rows back (`asked` kept across pages). Fixed: `98fd756` | done |
| 2 | One request that doesn't answer freezes the pane: no timeout, and everything queues behind it | pane |
| 3 | Reopened on a commit's page, the bar's list is that one commit | pane |
| 4 | An open takes two full reads; polling a run reads the whole diff | daemon, pane |
| 5 | An unchanged read rebuilds the list | pane |
| 6 | A click detours through an unseen overlay and asks git what the bar already knows; two page functions | bar |
| 7 | Watches react to ignored paths (macOS reports them), the bar to every path | bar, pane |
| 8 | A hidden pane, or any pane with the window inactive, keeps reading | pane |
| 9 | The logo's menu runs up to 22 git processes, and throws the log away inside a review | bar |
| 10 | Switching page blanks the pane to a spinner | pane |
| 11 | `mods/README.md` says a click on a count analyzes in `"herdr"` mode; it doesn't | docs |
| 12 | A range's title is raw (`origin/fix...fix`), where the bar says `↑3` | pane |

## Contracts between the parts

Each part builds against these, not against the others' code.

**Daemon to pane.** The installed daemon comes from npm and publishing is the owner's call, so
both additions MUST be harmless to an older daemon, whose schemas drop unknown keys and which
answers an unknown route with an error.

- `POST /api/review` takes an optional `firstRows: boolean`. True: the rows of the first group's
  files (its own and its children's, as the pane's `groupFiles`) come as well as those named in
  `rows`. The pane sends `rows: []` with it. Rows stop at one read's budget (about 600 KB of JSON, 3000
  rows, 10,000 tokens; the first file always comes) as [plan 04](./04-herdr-review-pane.md) says.
- After the open, a batch's rows, and the next page of a file cut short, come from
  `POST /api/review/rows` (plan 04), and a whole file's next page from `/api/review/file` with
  `from`. An older daemon answers the rows route with an error, and the pane reads the batch
  with the whole page, as before; it answers `stale` the same way.
- `POST /api/review/status` `{ path, page }` answers
  `{ running: boolean, progress?, error? }` for that page's analysis, from the page's key and the
  worktree server's state, without reading the diff. No server started yet: `{ running: false }`.

**Pane to bar: unchanged.** `shared("review.shown")[tab] = { root, page, base, commits }`;
`shared("review") = { tab, root, page, base?, n }`, a `base` keeping that diff's commits.

## Design

**2. Only the latest read counts.** `this.loading` holds the `root` and `page` being read. A read
of the same page while one runs sets `again`, so a burst of changes can't restart it forever; a
read of another page starts at once and supersedes it (`loadId`), the old answer ignored. After
`LOAD_TIMEOUT` (30 s, with `cx.timer.after`: mods have no `setTimeout`) a read still current
clears `loading` and shows an error with Retry. Its late answer is still taken.

**3.** After applying a read with `page !== base` and no `baseCommits`, read the base once with
`rows: []`. A failure leaves the commit alone in the list.

**4, pane.** A read with no group yet sends `firstRows: true`. An older daemon ignores it and the
existing second read happens as now. The 1.5 s timer calls `/api/review/status`, one at a time:
running updates `review.analysis` in place (state, progress) and redraws; not running, after a
run or with an error, does a full read; not started yet does nothing. A failed call does the old
`load(cx, true)`, which is also what an older daemon gets.

**5.** `apply` returns early when the new read says what the current one does: compare
`JSON.stringify` of `key, title, base, head, commits, source, groups, analysis` and each file's
`path, sha, reviewed, changed` and whether it has rows. It keeps `this.review`, so the list's file
objects stay the ones marks mutate.

**6.** `argPage(args)` in `bar.js` is the one synchronous answer for a page from args; `pageFor`
uses it and adds only the default-branch lookup. The bar calls `launch` directly, in `cx.spawn`,
with `{ root, args, page, analyze }`: no overlay, no `rev-parse`. A menu pick passes its
`overlay`, and `launch` closes it when done, since closing first stops the overlay's task. The
`mod.json` overlay stays for `mod.open:pulls-review` (the key), which knows nothing yet.
The overlay began when the bar lived in `t3-tabs` and had to reach this mod.

**7.** Both mods get this function (a mod can't import from another's folder), checked against
`git check-ignore`'s exit codes: 0 some ignored and listed, 1 none, 128 can't judge. A path under
`.git` answers 1, so those are filtered first.

```js
// Worth a read? Of Git's own files only HEAD and refs, and nothing Git ignores: macOS reports those too.
async function touchesDiff(root, paths) {
  if (paths.some(p => /\/\.git\/(HEAD|refs\/)/.test(p))) return true;
  const files = paths.filter(p => !/\/\.git(\/|$)/.test(p));
  if (!files.length) return false;
  const r = await exec("git", ["--no-optional-locks", "check-ignore", "--", ...files], { cwd: root }).catch(() => null);
  return r?.code !== 0 || r.stdout.trim().split("\n").length < files.length;
}
```

At most one change read per second: the pane waits a second in its watch loop before the next
`watchFolder`; the bar, instead of clearing `reviewAt`, moves each entry back to at most
`now - 9000`, so its 10 s rule reads a second after the last read.

**8.** The 15 s timer and the watch read only with the window active and the pane's tab active;
otherwise they set `dirty`, and a 1 s timer reads once both hold again. Hidden panes keep their
timers (`~/.config/herdr-app/AGENTS.md`). The analysis poll is exempt: tabs show its state.

**9.** `readPicks` skips the log inside a review (the menu lists the review's commits). Branch
counts come in the one `for-each-ref`, with `%(ahead-behind:<base>)` (Git 2.41); a Git without it
fails that call, and the names are read again without counts, which the menu then leaves out.

**10.** `open` keeps the old `review` on screen with `switching` set, dimmed; `apply` replaces it
and only then resets what belonged to it (`groupKey`, `current`, `full`) and scrolls to the top.
Hunks of same-sha files carry over, which `apply` already does. While `switching`: a read asks for
`firstRows`, not the old group's files; `report` and the title don't read the old review;
`headerPress`, `setReviewed`, `toggleFull` and the keys do nothing. A failed read clears the old
review rather than show it under the new page's title. Another `root` clears it at once.

**12.** `pageLabel`: `<remote>/x...x` is `To push: x`, `x...<remote>/x` is `To pull: x`, and any
other `a...b` is `b vs a`, as `/branch/` reads.

## Not in scope

Publishing `jin.review` or installing it locally: until then 4 changes nothing for the owner, and
falls back as above.
