import process from 'node:process'
import { parseArgs } from 'node:util'
import { createDevServer } from 'devframe/adapters/dev'
import devframe from './devframe'
import { browserPath, pageFor, sharedAnalysisQuery } from './page'
import { createAppWithRefRoutes } from './spa'

const HELP = `Usage: pulls.review [target] [options]

Reviews local git changes - or any GitHub pull request - in the browser, grouped
and summarized. Run it inside a git repository. The target only picks the page
that opens; any other can be picked from the browser.

Target (git revision syntax):
  (none)     the current branch against the default branch, or the ref picker
             when the default branch itself is checked out
  <branch>   what a branch adds since it forked from the default branch
  <rev>      one commit against its parent
  A...B      what B adds since it forked from A
  A..B       the tree diff between two revisions

Target (GitHub):
  owner/repo#123, or a github.com pull request, compare, commit or repo URL.
  Uses the GitHub token from GITHUB_TOKEN, else from \`gh auth token\`.

AI analysis uses a key from Settings, or a coding agent installed here (Claude
Code, OpenCode, Pi) when "Local agent" is the provider in Settings.

Options:
  --worktree      open the uncommitted changes against HEAD
  --from <login>  with a GitHub pull request, load the AI analysis <login> shared
                  on it (the site's ?from=<login>), its latest version every time
  --port <port>   port to listen on
  --no-open       do not open the browser
  -h, --help

To analyze a GitHub pull request from CI, use @pulls.review/actions.
`

async function main() {
  const { values: flags, positionals } = parseArgs({
    options: {
      'worktree': { type: 'boolean' },
      'from': { type: 'string' },
      'port': { type: 'string' },
      'no-open': { type: 'boolean' },
      'help': { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  })
  if (flags.help) {
    process.stdout.write(HELP)
    return
  }
  const page = browserPath(await pageFor(process.cwd(), positionals[0], !!flags.worktree)) + sharedAnalysisQuery(positionals[0], flags.from)
  await createDevServer(devframe, {
    app: createAppWithRefRoutes(),
    port: flags.port ? Number(flags.port) : undefined,
    openBrowser: flags['no-open'] ? false : page,
    onReady: ({ origin }) => {
      process.stdout.write(`pulls.review is serving ${origin}${page}\n`)
    },
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
