// The Review bar: the focused worktree's uncommitted files and its commits ahead of and behind
// its upstream, each opening that diff.
// Its logo lists what else there is to pick: a commit, or another branch.
// The counts read the remote-tracking refs as they are; fetching is left to you.

import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, HoverCard } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, window, openOverlay, closeOverlay, props, setShared, shared, theme, settings } from "herdr";

const MOD = "pulls-review";

// The hovered button, as state: its hover label reads it.
const glow = (view, id) => (on, cx) => {
  if (on) view.hot = id;
  else if (view.hot === id) view.hot = null;
  cx.notify();
};
// A hover label as Herdr T3's: `.tooltip()` takes only a string, in the shell's own style. Only while hovered: a menu
// opened from the button hides the pointer's leaving, and the card would stay up over it.
const tip = (hot, t, id, label, trigger) => HoverCard.new(`tip-${id}`).anchor("top_center").open_delay(150).close_delay(0).trigger(trigger)
  .content(hot !== id ? div() : div().mt(4).px(8).py(4).rounded(6).border(1).border_color(t.border).bg(t.chrome).shadow_md().text_size(12).text_color(t.foreground).child(label));
// A menu hangs from the bar (40px, as Herdr T3's tab bar) under the click, not on the pointer, where it would cover the
// bar; the app keeps it in the window. With no press to read (assistive tech clicks without one), the app's default: the pointer.
const underBar = (press) => press && { x: press.x - 8, y: 40 * settings().zoom };

// The shipped `changes` mod's lookup, except for a mod pane (below).
export function reviewLocation() {
  const space = spaces().find((s) => s.active), f = focused();
  const ps = panes(), pane = f?.pane ? ps.find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  // A mod pane has no folder. The review pane says which repository it shows; for another, its tab's terminals stand in.
  const reviewed = pane?.mod === "review" ? shared("review.shown")?.[pane.tab]?.root : null;
  const beside = pane && !pane.cwd ? ps.find(p => p.tab === pane.tab && p.cwd)?.cwd : null;
  return { cwd: reviewed || pane?.cwd || beside || f?.cwd || space?.folder, on };
}

// Reads write nothing under .git, so the folder watch doesn't wake on them.
export const git = (cwd, args) => exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], { cwd });

export const browserPath = page => encodeURI(page).replaceAll("#", "%23");

// Each location keeps its last read, so switching back shows it at once and switching away never shows the old one.
// Focus is checked every 250 ms (memory reads only); git is read on a new location, a change in the worktree, else every 10 s.
export function watchReview(view, cx) {
  view.reviews = new Map();
  view.reviewAt = new Map();
  view.reviewBusy = new Set();
  view.reviewWatching = new Set();
  cx.timer.every(250, (cx) => {
    const where = reviewLocation(), key = JSON.stringify(where);
    if (key !== view.reviewKey) { view.reviewKey = key; cx.notify(); }
    if (!window()?.active || view.reviewBusy.has(key) || Date.now() - (view.reviewAt.get(key) ?? 0) < 10000) return;
    view.reviewBusy.add(key);
    view.reviewAt.set(key, Date.now());
    cx.spawn(async (cx) => {
      try {
        const review = where.cwd && !where.on ? await readReview(where.cwd) : null;
        view.reviews.set(key, review);
        // One watch per repo: focus moving A → B → A before A changes keeps A's first watch.
        const root = review?.root;
        if (root && !view.reviewWatching.has(root)) {
          view.reviewWatching.add(root);
          cx.spawn(async () => {
            try { while (view.reviews.get(view.reviewKey)?.root === root) { await watchFolder(root); view.reviewAt.clear(); } }
            catch {} // The next read watches it again.
            finally { view.reviewWatching.delete(root); }
          });
        }
      } catch { view.reviews.set(key, null); }
      finally { view.reviewBusy.delete(key); cx.notify(); }
    });
  });
}

async function readReview(cwd) {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return null;
  // File by file, as the page it opens lists them: plain status folds a new folder into one line.
  const root = top.stdout.trim(), status = await git(root, ["status", "--porcelain=v2", "--branch", "--untracked-files=all"]);
  if (status.code !== 0) return null;
  const review = { root, branch: null, upstream: null, base: null, baseRef: null, changed: 0, ahead: 0, behind: 0, unmerged: 0, newer: 0, gone: false };
  let ab = false;
  for (const line of status.stdout.split("\n")) {
    if (line.startsWith("# branch.head ")) review.branch = line.slice(14);
    else if (line.startsWith("# branch.upstream ")) review.upstream = line.slice(18);
    else if (line.startsWith("# branch.ab ")) { ab = true; [review.ahead, review.behind] = line.slice(12).split(" ").map(n => Math.abs(parseInt(n, 10)) || 0); }
    else if (line && !line.startsWith("#")) review.changed++; // One line per file, staged or not, renames included.
  }
  // git leaves out branch.ab when the upstream is set but gone, as after a merged PR's branch is deleted.
  review.gone = Boolean(review.upstream) && !ab;
  // The default branch as the CLI resolves it (resolveDefaultBranch): origin/HEAD, else main or master.
  const originHead = (await git(root, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"])).stdout.trim();
  const names = originHead ? [originHead.replace(/^origin\//, "")] : ["main", "master"];
  for (const ref of names.flatMap(name => [`origin/${name}`, name])) {
    const count = await git(root, ["rev-list", "--left-right", "--count", `${ref}...HEAD`]);
    if (count.code !== 0) continue; // No such ref.
    // `base` is the branch name; `baseRef` is what was compared, named in the label so a fork's stale origin/main reads as itself.
    review.base = ref.replace(/^origin\//, "");
    review.baseRef = ref;
    // On the default branch or a detached HEAD the CLI opens its ref picker instead: nothing to show.
    if (review.branch !== review.base && review.branch !== "(detached)") {
      [review.newer, review.unmerged] = count.stdout.trim().split(/\s+/).map(n => parseInt(n, 10) || 0);
      // A branch tracking the default branch: its ↑ is the same commits as N ahead of base.
      if (review.upstream === `origin/${review.base}`) review.ahead = 0;
    }
    break;
  }
  return review;
}

// Read on click, so the bar's 10 s poll stays as cheap as it was.
// shortcut: the menu holds the newest 200 commits and 20 branches, so search can't reach past them; read more if a repo needs it.
async function readPicks(r) {
  const log = await git(r.root, ["log", "-200", "--format=%H%x1f%s%x1f%cr", r.unmerged ? `${r.baseRef}..HEAD` : "HEAD"]);
  const commits = log.stdout.split("\n").filter(Boolean).map(line => { const [sha, subject, when] = line.split("\x1f"); return { sha, subject, when }; });
  if (!r.baseRef) return { commits, branches: [] };
  const refs = await git(r.root, ["for-each-ref", "--sort=-committerdate", "--count=21", `--no-merged=${r.baseRef}`, "--format=%(refname:short)", "refs/heads"]);
  const names = refs.stdout.split("\n").filter(name => name && name !== r.branch).slice(0, 20);
  const branches = await Promise.all(names.map(async name =>
    ({ name, count: parseInt((await git(r.root, ["rev-list", "--count", `${r.baseRef}..${name}`])).stdout, 10) || 0 })));
  return { commits, branches };
}

// This mod opened unseen, as its mod.json opens it; a size here would show an empty box while it works.
const openDiff = (cwd, args, analyze) => openOverlay({ mod: MOD, kind: "popup", width: 1, height: 1, frame: "none", props: { cwd, args, analyze } });

const branchArgs = (b) => [`${props().baseRef}...${b.name}`];
// No analysis here: browsing the menu's commits mustn't start and bill one per click.
const openPick = (args) => { closeOverlay(props().overlay); openDiff(props().root, args); };

// Another page of the diff the review pane shows: a request as open.js's, with the base that keeps that diff's commits.
const showPage = ({ tab, root, base }, page) => setShared("review", { tab, root, page, base, n: Date.now() });
const showWithin = (page) => { closeOverlay(props().overlay); showPage(props().within, page); };
const pickCommit = (c) => (props().within ? showWithin(`/commit/${c.sha}`) : openPick([c.sha]));

function reviewMatches(view) {
  const query = view.search.value().trim().toLowerCase(), { commits, branches } = props();
  return {
    commits: commits.filter(c => c.sha.startsWith(query) || c.subject.toLowerCase().includes(query)),
    branches: branches.filter(b => b.name.toLowerCase().includes(query)),
  };
}

export function initReviewMenu(view) {
  view.search = InputState.new({ placeholder: "Search commits and branches" });
  view.search.on("change", (_e, cx) => cx.notify());
  view.search.on("submit", () => {
    const { commits, branches } = reviewMatches(view);
    if (commits[0]) pickCommit(commits[0]);
    else if (branches[0]) openPick(branchArgs(branches[0]));
  });
  view.search.focus();
}

// The logo's menu, this mod opened as an overlay with props.menu (main.js).
export function reviewMenu(view) {
  const t = theme(), { base, height, within } = props(), { commits, branches } = reviewMatches(view);
  const title = (text) => div().h(24).px(8).flex_none().flex().items_center().text_size(11).text_color(t.dim).child(text);
  const row = (id, name, action, ...cells) => h_flex().id(id).h(32).px(8).gap(8).flex_none().items_center().rounded(6).text_color(t.foreground)
    .hover(s => s.bg(t.hover)).role("button").accessibility_label(name).on_click(action).children(cells);
  // A popup's height is only a maximum: this one sets its own, for the list to scroll inside and to hold still while searching.
  return v_flex().id("review-menu").w_full().h(height).p(5).bg(t.popover).text_size(13)
    .child(h_flex().h(32).mb(4).px(8).gap(8).flex_none().items_center()
      .child(svg("mods/workspace-chrome/search.svg").size(13).flex_none().text_color(t.dim))
      .child(Input.new(view.search).flex_1().h_full().text_size(13).text_color(t.foreground)))
    .child(v_flex().id("review-list").flex_1().min_h(0).overflow_y_scroll()
      .when(Boolean(within), el => el.child(row("review-all", "Review all changes", () => showWithin(within.base), div().flex_1().child("All changes")).when(!within?.sha, s => s.bg(t.hover))))
      .when(commits.length > 0, el => el.child(title("Commits")).children(commits.map(c =>
        row(`review-commit-${c.sha}`, `Review commit ${c.subject}`, () => pickCommit(c),
          div().w(58).flex_none().text_color(t.dim).child(c.sha.slice(0, 7)), div().flex_1().min_w(0).truncate().child(c.subject), div().flex_none().text_size(12).text_color(t.dim).child(c.when.replace(/ ago$/, ""))).when(c.sha === within?.sha, s => s.bg(t.hover)))))
      .when(commits.length > 0 && branches.length > 0, el => el.child(div().h(1).mx(6).my(4).flex_none().bg(t.border)))
      .when(branches.length > 0, el => el.child(title(`Branches vs ${base}`)).children(branches.map(b =>
        row(`review-branch-${b.name}`, `Review branch ${b.name}, ${b.count} ahead of ${base}`, () => openPick(branchArgs(b)),
          div().flex_1().min_w(0).truncate().child(b.name), div().flex_none().text_size(12).text_color(t.dim).child(String(b.count))))))
      .when(!commits.length && !branches.length, el => el.child(div().p(8).text_color(t.dim).child("No matches"))));
}

export function reviewBar(view, t, stop) {
  // Looked up on each render, so the frame that shows another space already shows its own counts.
  const r = view.reviews?.get(JSON.stringify(reviewLocation()));
  if (!r) return null;
  const n = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  // A narrow bar's layout sets it (Herdr T3's bar-measure): the counts alone, their colors telling them apart. Unset, the words too.
  const compact = shared("bar.compact");
  // What the focused tab's review pane shows, when it's this repository's; `sha`, when that's one commit of its diff.
  const tab = focused()?.tab, reviewed = shared("review.shown")?.[tab], here = reviewed?.root === r.root ? reviewed : null;
  const sha = here?.page?.startsWith("/commit/") && here.page !== here.base ? here.page.slice("/commit/".length) : null;
  const list = here?.commits ?? [], index = sha ? list.findIndex(c => c.sha === sha) : -1;
  const within = here && (sha || list.length > 1) ? { tab, root: r.root, base: here.base, sha } : null;
  // The page a count opens (open.js's pageFor, which it needn't ask git for here).
  const isShown = (args) => here?.base === (args[0] === "--worktree" ? "/worktree" : browserPath(args[0] ? `/compare/${args[0]}` : `/branch/${r.branch}`));
  // The accessibility label says what each count compares, which the short label can't.
  // The count carries the color; what it counts stays quiet beside it.
  // 24, the outline's inside: a hover card's wrapper has no height for h_full to fill. Its label is the name's first part.
  // Compact, the label gives back the words the count lost, `· merged?` included.
  const item = ([id, count, noun, ansi, name, args], last) => tip(view.reviewHover, t, id, compact && noun ? `${count} ${noun}` : name.split(": ")[0], h_flex().id(id).h(24).px(8).gap(6).flex_none().items_center()
    .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground)).role("button").accessibility_label(isShown(args) ? `${name}, shown` : name).when(isShown(args), el => el.bg(t.hover).text_color(t.foreground))
    // Herdr has no group hover. Entering the next segment can report before leaving this one.
    .on_hover((on, cx) => { if (on) view.reviewHover = id; else if (view.reviewHover === id) view.reviewHover = null; cx.notify(); })
    .on_click(() => openDiff(r.root, args, true))
    // Hovered, the label turns foreground: the count takes its bright twin (ansi + 8) to stay the lead, same hue.
    .child(div().font_medium().text_color(t[`ansi${view.reviewHover === id ? ansi + 8 : ansi}`]).child(count))
    .when(Boolean(noun) && !compact, el => el.child(noun))
    .when(last, el => el.rounded_r(6)));
  const segments = [
    // A squash merge leaves the count standing, so a deleted upstream is the visible hint it may be done.
    r.unmerged > 0 && ["review-open", String(r.unmerged), `ahead of ${r.base}${r.gone ? " · merged?" : ""}`, 4, `Review the branch: ${n(r.unmerged, "commit")} on ${r.branch}, not on ${r.baseRef}`
      + (r.newer ? ` · ${r.baseRef} has ${n(r.newer, "newer commit")}` : "") + (r.gone ? ` · ${r.upstream} is gone, likely merged` : ""), []],
    r.changed > 0 && ["review-changes", String(r.changed), "uncommitted", 3, `Review ${n(r.changed, "uncommitted file")}: staged, unstaged and new`, ["--worktree"]],
    r.ahead > 0 && ["review-ahead", `↑${r.ahead}`, null, 2, `Review ${n(r.ahead, "commit")} to push: on ${r.branch}, not on ${r.upstream}`, [`${r.upstream}...${r.branch}`]],
    r.behind > 0 && ["review-behind", `↓${r.behind}`, null, 1, `Review ${n(r.behind, "commit")} to pull: on ${r.upstream} as of your last fetch, not on ${r.branch}`, [`${r.branch}...${r.upstream}`]],
  ].filter(Boolean);
  const pressed = (e, cx) => { view.reviewPress = e.position; stop(e, cx); };
  const openMenu = (_e, cx) => { view.hot = null; cx.notify(); cx.spawn(async () => {
    const picks = await readPicks(r), { branches } = picks;
    // Within a review, its own commits, newest first as the log's.
    const commits = within ? [...list].reverse() : picks.commits;
    if (!commits.length && !branches.length) return;
    const height = Math.min(480, 10 + 36 + (within ? 32 : 0) + (commits.length ? 24 + commits.length * 32 : 0) + (commits.length && branches.length ? 9 : 0) + (branches.length ? 24 + branches.length * 32 : 0));
    openOverlay({ mod: MOD, kind: "popup", at: underBar(view.reviewPress), width: 480, height, props: { menu: "review", root: r.root, base: r.base, baseRef: r.baseRef, commits, branches, height, within } });
  }); };
  // One commit shown: its place, opening the menu, between steps to the older and newer ones.
  const step = (id, glyph, label, commit, last) => h_flex().id(id).h(24).px(6).flex_none().items_center().text_size(12).text_color(commit ? t.dim : t.border).role("button").accessibility_label(label)
    .when(Boolean(commit), el => el.hover(s => s.bg(t.hover).text_color(t.foreground)).on_click(() => showPage(within, `/commit/${commit.sha}`)))
    .when(Boolean(last), el => el.rounded_r(6)).child(glyph);
  const place = !sha ? [] : [div().w(1).h(14).flex_none().bg(t.border),
    step("commit-older", "‹", "Older commit", index > 0 && list[index - 1]),
    h_flex().id("review-commits").h(24).px(2).flex_none().items_center().text_size(12).text_color(t.foreground).hover(s => s.bg(t.hover)).role("button").accessibility_label("Pick another commit of this review")
      .on_mouse_down("left", pressed).on_click(openMenu)
      .child(index === -1 ? sha.slice(0, 7) : compact ? `${index + 1}/${list.length}` : `Commit ${index + 1} of ${list.length}`),
    step("commit-newer", "›", "Newer commit", index >= 0 && list[index + 1], true)];
  // Outlined, not filled: a fill would read as an active tab. Each part's fill runs to the outline and the rules.
  return h_flex().id("pulls-review").h(26).flex_none().items_center().rounded(6).border(1).border_color(t.border).on_mouse_down("left", stop)
    // Stays with no counts: on a clean default branch it's the only way in.
    .child(tip(view.hot, t, "review-pick", "Pick a commit or branch to review", h_flex().id("review-pick").h(24).px(5).flex_none().items_center().rounded_l(6).when(!segments.length && !sha, el => el.rounded_r(6))
      .hover(s => s.bg(t.hover)).on_hover(glow(view, "review-pick")).role("button").accessibility_label("Pick a commit or branch to review")
      .on_mouse_down("left", pressed).on_click(openMenu)
      // image, not svg: svg would draw the logo in one tint.
      .child(image(`mods/${MOD}/logo.svg`).w(14).h(14).flex_none())))
    .children(segments.flatMap((s, i) => [div().w(1).h(14).flex_none().bg(t.border), item(s, !sha && i === segments.length - 1)]))
    .children(place);
}
