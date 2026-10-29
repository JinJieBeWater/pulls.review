# maintainer guide

`.agents/` describes what the code does and why. It is a map, not a standard:
where the two disagree, the packages' `src/` and test suites win, and the docs get fixed.

## Rules that apply everywhere

- When making UI or using components, always check if components from
  `@antfu/design` can be reused, before making new components or creating
  inline DOM elements.

- **MUST**, **MUST NOT**, **SHOULD** and **MAY** use RFC 2119 meanings. They mark
  real invariants - layer boundaries, wire contracts, output shapes - not house style.
- Vue SFCs **MUST NOT** have a `<style>` block, scoped or not. Style elements with
  UnoCSS utilities in the template. For markup the template can't put classes on
  (rendered Markdown, `v-html`), add a shortcut in `packages/app/uno.config.ts`
  built from arbitrary descendant variants (`[&_pre]:p-3`).

## Find the contract

| Task                                                                                                                   | Read                                            |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Understand what this project is, why it exists, and its longer-term direction                                          | [00 Goal](./.agents/00-goal.md)                 |
| Understand the overall design: provider/analyze-adapter boundaries, canonical data structures, caching, deferred scope | [01 Architecture](./.agents/01-architecture.md) |
| Understand a specific implementation phase's task breakdown                                                            | [plans/](./plans/)                              |

## Fork maintenance

This checkout is the `JinJieBeWater/pulls.review` fork. Before fork work, read its
plans in [plans/fork/](./plans/fork/).

- `main` mirrors `upstream/main` (antfu/pulls.review) and only fast-forwards. Fork
  work lives on `multi-repo`, rebased onto `upstream/main` when it moves.
- Keep every commit able to stand alone in an upstream PR: one change per commit;
  docs (`plans/`, `AGENTS.md`, `.agents/`) in their own commits, apart from code;
  fork-only commits (`plans/fork/`, `packages/cli/src/daemon/`, this section) apart
  from upstream candidates.
- Edit upstream files only where the fork needs it, with the smallest meaningful
  change; fork-only code goes in new files under `packages/cli/src/daemon/`, so
  rebases stay cheap.
- For an upstream PR, branch from `upstream/main` and cherry-pick only the
  upstream-candidate commits.
