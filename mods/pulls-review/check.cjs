// node mods/pulls-review/check.cjs: bar.js, open.js and main.js run on inert elements, as Herdr would load them, without a window.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function element(kind = "div", source) {
  const node = { kind, source, items: [], handlers: {}, style: {}, hoverStyle: {} };
  const proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      if (key === "when") { if (args[0]) args[1](proxy); }
      else if (key === "child" || key === "trigger") node.items.push(args[0]);
      else if (key === "children") node.items.push(...args[0]);
      else if (key === "on_mouse_down") node.handlers[`${key}:${args[0]}`] = args[1];
      else if (key.startsWith("on_")) node.handlers[key] = args[0];
      else if (key === "id") node.key = args[0];
      else if (key === "hover") { const hovered = element(); args[0](hovered); node.hoverStyle = hovered.style; }
      else node.style[key] = args.length === 1 ? args[0] : args;
      return proxy;
    };
  } });
  return proxy;
}
const find = (node, id) => !node || typeof node !== "object" ? null : node.key === id ? node : node.items.map(c => find(c, id)).find(Boolean) ?? null;
const strings = (node) => typeof node === "string" ? [node] : node && typeof node === "object" ? node.items.flatMap(strings) : [];
const walk = (node) => node && typeof node === "object" ? [node, ...node.items.flatMap(walk)] : [];
const keys = (node) => node.items.map(n => typeof n.key === "string" ? n.key : n.kind);
function fire(node, event, ...args) {
  assert.ok(node, `missing event target: ${event}`);
  assert.equal(typeof node.handlers[event], "function", event);
  return node.handlers[event](...args);
}
const plain = (value) => JSON.parse(JSON.stringify(value));

const zoom = 1.1, calls = [], overlays = [], closed = [], notes = [], state = {}, shown = { pane: "p1", tab: "b" };
const theme = new Proxy({ foreground: "#f4f4f6", dim: "#77777f", border: "#2a2a30", hover: "#202024", ansi1: "#e06c75", ansi2: "#98c379", ansi3: "#c8a84b", ansi4: "#5f8fe0", ansi9: "#f08c95", ansi10: "#b5e09a", ansi11: "#e8cf7a", ansi12: "#8fb4f2" }, { get: (t, k) => t[k] ?? "#a9a9b4" });
const env = {
  View: class {}, div: () => element(), h_flex: () => element("h"), v_flex: () => element("v"),
  svg: (source) => element("svg", source), image: (source) => element("image", source), Input: { new: () => element("input") }, HoverCard: { new: (id) => element("hovercard").id(id) },
  InputState: { new: () => ({ on() {}, value: () => "", focus() {} }) },
  theme: () => theme, settings: () => ({ zoom }), window: () => ({ platform: "macos", active: true }),
  spaces: () => [{ id: "s", active: true, folder: "/space", tabs: [{ id: "b" }] }], panes: () => [{ pane: "p1", tab: "b", cwd: "/repo/src" }],
  focused: () => shown, exec: async () => ({ code: 1, stdout: "" }), hc: async () => ({ code: 1 }), watchFolder: () => new Promise(() => {}),
  shared: (key) => state[key], setShared: (key, value) => { state[key] = value; },
  run: (name, args) => calls.push([name, plain(args)]), notify: (n) => notes.push(n),
  openOverlay: (spec) => overlays.push(spec), closeOverlay: (id) => closed.push(id),
  appHome: () => "/app", readTextFile: async () => '{ "open": "herdr" }',
};
const source = ["bar.js", "open.js", "main.js"].map(file => fs.readFileSync(path.join(__dirname, file), "utf8")).join("\n")
  .replace(/^import [^;]*;\r?\n/gm, "").replace("export default class", "globalThis.Mod = class").replace(/^export /gm, "");
const cx = { notify() {}, stop_propagation() {}, spawn: (f) => f(cx), timer: { every() {} } };
// `setup` gets the module's scope before init, to stand in for git.
const load = (props = {}, setup) => {
  const scope = vm.createContext({ ...env, props: () => props });
  vm.runInContext(source, scope, { filename: "pulls-review" });
  setup?.(scope);
  const mod = new scope.Mod();
  mod.init?.(props, cx);
  return { mod, scope };
};

(async () => {
  // The counts: a line per file (renamed and untracked too), the arrows from the branch headers, and the commits the
  // branch adds to the default branch, resolved as the CLI does.
  const { mod: bar, scope } = load({ block: "review" });
  assert.equal(find(bar.render(), "pulls-review"), null, "no bar before git is read");
  let status = ["# branch.oid 1a2b", "# branch.head feat", "# branch.upstream origin/feat", "# branch.ab +2 -1",
    "1 .M N... 100644 100644 100644 1a2b 1a2b src/a.js", "2 R. N... 100644 100644 100644 1a2b 1a2b R100 new.js\told.js", "? notes.md", ""].join("\n");
  const refs = { "main...HEAD": "0\t4\n" }; // No origin/HEAD, no origin/main: the local main.
  scope.exec = async (_command, args) => args.includes("--show-toplevel") ? { code: 0, stdout: "/repo\n" }
    : args.includes("symbolic-ref") ? { code: 1, stdout: "" }
    : args.includes("rev-list") ? (refs[args.at(-1)] ? { code: 0, stdout: refs[args.at(-1)] } : { code: 128, stdout: "" })
    : (assert.ok(args.includes("--untracked-files=all"), "a new folder counts its files, as the page it opens"), { code: 0, stdout: status });
  const review = await scope.readReview("/repo/src");
  const show = r => bar.reviews.set(JSON.stringify(scope.reviewLocation()), r);
  assert.deepEqual(plain(review), { root: "/repo", branch: "feat", upstream: "origin/feat", base: "main", baseRef: "main", changed: 3, ahead: 2, behind: 1, unmerged: 4, newer: 0, gone: false });
  show(review);
  const drawn = bar.render();
  assert.deepEqual(strings(find(drawn, "review-open")), ["4", "ahead of main"], "the branch's count says what it is against");
  assert.deepEqual(strings(find(drawn, "review-changes")), ["3", "uncommitted"]);
  // One outline, its parts ruled apart: a control group on its own in any bar.
  assert.ok(find(drawn, "pulls-review").style.border);
  assert.deepEqual(keys(find(drawn, "pulls-review")), ["tip-review-pick", "div", "tip-review-open", "div", "tip-review-changes", "div", "tip-review-ahead", "div", "tip-review-behind"]);
  assert.equal(strings(find(drawn, "tip-review-ahead").style.content).length, 0, "its card waits for the hover");
  assert.ok("rounded_r" in find(drawn, "review-behind").style, "the last part's fill follows the outline's corner");
  assert.equal(find(drawn, "review-open").style.accessibility_label, "Review the branch: 4 commits on feat, not on main");
  for (const n of walk(drawn)) if (n.hoverStyle.text_color) assert.ok(!walk(n).some(c => c.kind === "svg"), `${n.key}: a hover style can't brighten its icon`);
  // The logo, in its own colors and on disk: a missing file draws nothing, and the button shows blank.
  const logo = walk(find(drawn, "review-pick")).find(n => n.kind === "image");
  assert.equal(logo.source, "mods/pulls-review/logo.svg");
  assert.ok(fs.existsSync(path.join(__dirname, "logo.svg")));
  fire(find(drawn, "review-pick"), "on_hover", true, cx);
  assert.deepEqual(strings(find(bar.render(), "tip-review-pick").style.content), ["Pick a commit or branch to review"], "its card shows on hover");
  fire(find(drawn, "review-pick"), "on_hover", false, cx);
  // Each count in its own color, so what there is to review reads at a glance; hovered, its bright twin.
  const countColor = id => find(bar.render(), id).items[0].style.text_color;
  assert.deepEqual(["review-open", "review-changes", "review-ahead", "review-behind"].map(countColor), [theme.ansi4, theme.ansi3, theme.ansi2, theme.ansi1]);
  fire(find(drawn, "review-open"), "on_hover", true, cx);
  assert.equal(countColor("review-open"), theme.ansi12, "hovered, the count takes its bright twin");
  fire(find(drawn, "review-changes"), "on_hover", true, cx);
  fire(find(drawn, "review-open"), "on_hover", false, cx);
  assert.equal(countColor("review-changes"), theme.ansi11, "the old segment's late leave doesn't clear the new one");
  assert.equal(countColor("review-open"), theme.ansi4);
  fire(find(drawn, "review-changes"), "on_hover", false, cx);
  assert.equal(countColor("review-changes"), theme.ansi3);
  assert.equal(find(drawn, "review-ahead").style.accessibility_label, "Review 2 commits to push: on feat, not on origin/feat", "the label says what a count compares");
  assert.equal(find(drawn, "review-behind").style.accessibility_label, "Review 1 commit to pull: on origin/feat as of your last fetch, not on feat");
  assert.equal(walk(drawn).filter(n => "tooltip" in n.style).length, 0, "the shell's tooltip isn't Herdr T3's");
  fire(find(drawn, "review-ahead"), "on_hover", true, cx);
  assert.deepEqual(strings(find(bar.render(), "tip-review-ahead").style.content), ["Review 2 commits to push"], "the label names what it does; what it compares stays in the accessibility label");
  fire(find(drawn, "review-ahead"), "on_hover", false, cx);
  Object.assign(shown, { pane: "p9", cwd: "/other" });
  assert.equal(find(bar.render(), "pulls-review"), null, "another location never shows this one's counts, even before its own read");
  Object.assign(shown, { pane: "p1", cwd: undefined });
  assert.ok(find(bar.render(), "review-open"), "coming back shows the last read at once");
  // The review pane focused, in a tab of its own: the repository it shows, not the space's folder.
  const allPanes = scope.panes;
  scope.panes = () => [{ pane: "p7", mod: "review", tab: "r", cwd: null }];
  state["review.shown"] = { r: { root: "/repo" } };
  Object.assign(shown, { pane: "p7", tab: "r" });
  assert.deepEqual(plain(scope.reviewLocation()), { cwd: "/repo", on: null });
  scope.panes = allPanes; delete state["review.shown"];
  Object.assign(shown, { pane: "p1", tab: "b" });
  show({ ...review, unmerged: 0, changed: 0, ahead: 0, behind: 0 });
  assert.deepEqual(keys(find(bar.render(), "pulls-review")), ["tip-review-pick"], "no counts: the icon stays, the way in on a clean default branch");
  assert.ok("rounded_r" in find(bar.render(), "review-pick").style);
  show({ ...review, newer: 1, gone: true });
  assert.deepEqual(strings(find(bar.render(), "review-open")), ["4", "ahead of main · merged?"], "a deleted upstream shows, not only in the label");
  // In a narrow bar the counts stand alone; the hover label gives back the words, and the accessibility label stays whole.
  state["bar.compact"] = true;
  assert.deepEqual(strings(find(bar.render(), "review-open")), ["4"]);
  fire(find(bar.render(), "review-open"), "on_hover", true, cx);
  assert.deepEqual(strings(find(bar.render(), "tip-review-open").style.content), ["4 ahead of main · merged?"]);
  fire(find(bar.render(), "review-open"), "on_hover", false, cx);
  assert.match(find(bar.render(), "review-open").style.accessibility_label, /^Review the branch: 4 commits on feat/);
  delete state["bar.compact"];
  assert.equal(find(bar.render(), "review-open").style.accessibility_label,
    "Review the branch: 4 commits on feat, not on main · main has 1 newer commit · origin/feat is gone, likely merged");
  const full = status;
  status = full.replace(/^# branch\.ab .*\n/m, "");
  const lost = await scope.readReview("/repo");
  assert.deepEqual([lost.gone, lost.ahead, lost.behind], [true, 0, 0], "an upstream without branch.ab is gone");
  status = full.replace("origin/feat", "origin/main");
  const tracking = await scope.readReview("/repo");
  assert.deepEqual([tracking.ahead, tracking.behind], [0, 1], "tracking main: ↑ repeats N ahead of main, so it goes; ↓ stays");
  // With origin/main the label names the remote ref: a fork's origin/main can lag the upstream it mirrors.
  refs["origin/main...HEAD"] = "0\t43\n";
  show(await scope.readReview("/repo"));
  assert.equal(find(bar.render(), "review-open").style.accessibility_label, "Review the branch: 43 commits on feat, not on origin/main");
  assert.deepEqual(strings(find(bar.render(), "review-open")), ["43", "ahead of main"], "the bar stays short: the remote ref is left to the label");
  delete refs["origin/main...HEAD"];
  refs["main...HEAD"] = "0\t0\n";
  assert.equal((await scope.readReview("/repo")).unmerged, 0, "nothing past main: no Review");
  refs["main...HEAD"] = "0\t4\n";
  for (const head of ["(detached)", "main"]) {
    status = full.replace("# branch.head feat", `# branch.head ${head}`);
    assert.equal((await scope.readReview("/repo")).unmerged, 0, `on ${head} the CLI opens its ref picker: no Review`);
  }

  // It sizes its block to the bar, its gap to what follows included, in logical pixels, once per change; with no bar, to nothing.
  show(review);
  const fit = () => find(bar.render(), "review-fit");
  assert.equal(fit().style.pr, 8);
  fire(fit(), "on_size_change", { width: 220 });
  fire(fit(), "on_size_change", { width: 220 });
  assert.deepEqual(calls.splice(0), [["layout.resize", { id: "review", px: 200 }]]);
  Object.assign(shown, { pane: "p9", cwd: "/other" });
  assert.equal(fit().style.pr, undefined, "no bar, no gap");
  fire(fit(), "on_size_change", { width: 0 });
  assert.deepEqual(calls.splice(0), [["layout.resize", { id: "review", px: 0 }]]);
  Object.assign(shown, { pane: "p1", cwd: undefined });
  const { mod: loose } = load();
  fire(find(loose.render(), "review-fit"), "on_size_change", { width: 220 });
  assert.equal(calls.length, 0, "without a block it leaves the layout alone");

  // The logo reads on click, then its menu's rows open one commit, or one branch against the base.
  const ranges = [];
  scope.exec = async (_command, args) => {
    if (args.includes("log")) { ranges.push(args.at(-1)); return { code: 0, stdout: "abcdef123456\x1ffix: a\x1f2 hours ago\n" }; }
    if (args.includes("for-each-ref")) return { code: 0, stdout: "feat\nOther\n" };
    return { code: 0, stdout: "3\n" };
  };
  const r = { root: "/repo", branch: "feat", base: "main", baseRef: "origin/main", unmerged: 4 };
  let reading;
  const run = { ...cx, spawn: fn => { reading = fn(run); } };
  const click = async (picked) => {
    show(picked);
    fire(find(bar.render(), "review-pick"), "on_mouse_down:left", { position: { x: 900, y: 20 } }, cx);
    fire(find(bar.render(), "review-pick"), "on_click", {}, run);
    await reading;
    return overlays.at(-1);
  };
  const spec = await click(r);
  assert.equal(ranges.at(-1), "origin/main..HEAD", "the branch's own commits");
  assert.deepEqual(plain(spec.props.branches), [{ name: "Other", count: 3 }], "the current branch isn't offered against itself");
  assert.equal(spec.height, 10 + 36 + 24 + 32 + 9 + 24 + 32, "the popup fits its rows");
  assert.equal(spec.props.height, spec.height, "and the menu sets that height itself: a popup's is only a maximum");
  assert.deepEqual([spec.mod, spec.props.menu], ["pulls-review", "review"]);
  assert.deepEqual(plain(spec.at), { x: 892, y: 40 * zoom }, "it hangs from the bar under the press, not over the bar");
  fire(find(bar.render(), "review-open"), "on_click", {}, cx);
  assert.deepEqual([overlays.at(-1).mod, overlays.at(-1).props.analyze], ["pulls-review", true], "a count's click starts the analysis");
  const { mod: menu } = load(spec.props);
  fire(find(menu.render(), "review-commit-abcdef123456"), "on_click", {}, cx);
  assert.deepEqual(plain(overlays.at(-1).props.args), ["abcdef123456"]);
  assert.ok(!overlays.at(-1).props.analyze, "a menu pick doesn't");
  fire(find(menu.render(), "review-branch-Other"), "on_click", {}, cx);
  assert.deepEqual(plain(overlays.at(-1).props.args), ["origin/main...Other"]);
  // With the review pane showing this repository's diff: its count lit, one commit's place and steps, the menu on its commits.
  const list = ["c1", "c2", "c3"].map(sha => ({ sha, subject: sha, when: "1 hour ago" }));
  const pane = (page, base = "/branch/feat", commits = list) => { state["review.shown"] = { b: { root: "/repo", page, base, commits } }; };
  pane("/branch/feat"); show(r);
  let lit = bar.render();
  assert.equal(find(lit, "review-open").style.bg, theme.hover);
  assert.equal(find(lit, "review-open").style.accessibility_label, "Review the branch: 4 commits on feat, not on origin/main, shown");
  assert.equal(find(lit, "review-commits"), null, "the whole diff has no place to show");
  pane("/commit/c2"); lit = bar.render();
  assert.deepEqual(strings(find(lit, "review-commits")), ["Commit 2 of 3"]);
  assert.ok("rounded_r" in find(lit, "commit-newer").style && !("rounded_r" in find(lit, "review-open").style), "the last part's fill follows the outline's corner");
  fire(find(lit, "commit-older"), "on_click", {}, cx);
  assert.deepEqual([state.review.tab, state.review.root, state.review.page, state.review.base], ["b", "/repo", "/commit/c1", "/branch/feat"]);
  fire(find(lit, "commit-newer"), "on_click", {}, cx);
  assert.equal(state.review.page, "/commit/c3");
  pane("/commit/c3");
  assert.equal(find(bar.render(), "commit-newer").handlers.on_click, undefined, "no newer commit");
  pane("/commit/c2");
  const within = await click(r);
  assert.deepEqual(plain(within.props.commits.map(c => c.sha)), ["c3", "c2", "c1"], "newest first, as the log's");
  assert.deepEqual(plain(within.props.within), { tab: "b", root: "/repo", base: "/branch/feat", sha: "c2" });
  assert.equal(within.height, Math.min(480, 10 + 36 + 32 + 24 + 3 * 32 + 9 + 24 + 32), "the popup fits All changes too");
  const inMenu = load(within.props).mod;
  assert.equal(find(inMenu.render(), "review-commit-c2").style.bg, theme.hover, "the commit shown is marked");
  fire(find(inMenu.render(), "review-commit-c1"), "on_click", {}, cx);
  assert.deepEqual([state.review.page, state.review.base], ["/commit/c1", "/branch/feat"], "a pick stays in this diff");
  fire(find(inMenu.render(), "review-all"), "on_click", {}, cx);
  assert.equal(state.review.page, "/branch/feat");
  fire(find(inMenu.render(), "review-branch-Other"), "on_click", {}, cx);
  assert.deepEqual(plain(overlays.at(-1).props.args), ["origin/main...Other"], "a branch is a new diff");
  // A single commit opened from the log has no commits of its own to step through: the menu stays on the log.
  pane("/commit/abc", "/commit/abc", [list[0]]);
  assert.equal((await click(r)).props.within, null);
  // Another repository's diff beside this terminal: nothing lit.
  state["review.shown"].b.root = "/other";
  assert.ok(!("bg" in find(bar.render(), "review-open").style));
  delete state["review.shown"]; delete state.review;
  // Search narrows both lists; Enter opens the first left.
  const searching = load(spec.props);
  let typed = "", submit;
  searching.scope.InputState = { new: () => ({ on: (event, fn) => { if (event === "submit") submit = fn; }, value: () => typed, focus() {} }) };
  searching.scope.initReviewMenu(searching.mod);
  typed = "oTHER";
  assert.equal(find(searching.mod.render(), "review-commit-abcdef123456"), null, "a commit that doesn't match goes");
  assert.ok(find(searching.mod.render(), "review-branch-Other"), "matching ignores case");
  submit();
  assert.deepEqual(plain(overlays.at(-1).props.args), ["origin/main...Other"], "Enter opens the only match left");
  typed = "abcdef";
  assert.ok(find(searching.mod.render(), "review-commit-abcdef123456"), "a sha's start matches");
  submit();
  assert.deepEqual(plain(overlays.at(-1).props.args), ["abcdef123456"]);
  typed = "nope";
  const opened = overlays.length;
  submit();
  assert.equal(overlays.length, opened, "no match: Enter opens nothing");
  await click({ ...r, branch: "main", unmerged: 0 });
  assert.equal(ranges.at(-1), "HEAD", "on the default branch: its recent commits");
  delete bar.reviewPress;
  fire(find(bar.render(), "review-pick"), "on_click", {}, run);
  await reading;
  assert.equal(overlays.at(-1).at, undefined, "a click with no press opens at the pointer");
  const before = overlays.length;
  scope.exec = async () => ({ code: 128, stdout: "" });
  await click(r);
  assert.equal(overlays.length, before, "nothing to pick, no menu");

  // Opened as an overlay it opens the review and closes itself: in "herdr" mode, a review pane split off the focused one.
  calls.length = 0;
  const { mod: launcher } = load({ overlay: "o1", cwd: "/repo/src", args: ["--worktree"] }, (scope) => {
    scope.exec = async (_command, args) => args.includes("--show-toplevel") ? { code: 0, stdout: "/repo\n" } : { code: 0, stdout: "" };
  });
  await new Promise(setImmediate);
  assert.deepEqual(calls.map(([name, args]) => [name, args.mod, args.pane, args.props?.page]), [["pane.split", "review", "p1", "/worktree"]]);
  assert.deepEqual(closed.at(-1), "o1");
  assert.equal(find(launcher.render(), "review-fit"), null, "nothing to see while it works");
  assert.deepEqual(plain(notes), []);

  console.log("ok: the Review bar's counts outlined and ruled, its block sized to fit, the branch menu and its search, opening a review");
})().catch(e => { console.error(e); process.exit(1); });
