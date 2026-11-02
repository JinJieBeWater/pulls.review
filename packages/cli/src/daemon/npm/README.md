# jin.review

An unofficial fork of [pulls.review](https://github.com/antfu/pulls.review) by Anthony Fu, from its [`multi-repo` branch](https://github.com/JinJieBeWater/pulls.review/tree/multi-repo). Report problems with it [on the fork](https://github.com/JinJieBeWater/pulls.review/issues), not upstream.

It adds one background server on `http://127.0.0.1:7855` for every repository and worktree you open, with a tab shell Chrome can install as an app. The command is `jin.review`, so it installs next to the official `pulls.review` without replacing it:

```sh
bun add -g jin.review   # or npm i -g jin.review
jin.review -d           # open this repository in the background server
jin.review -d --pwa     # the same, in the installed app
jin.review --stop       # stop the server and its worktree servers
```

Without `-d` it works like upstream's `pulls.review`. Both keep their state in `~/.pulls.review`. Versions read `<upstream version>-fork.<n>`. See the [fork's README](https://github.com/JinJieBeWater/pulls.review/tree/multi-repo#fork-multi-repo-daemon) for the rest.
