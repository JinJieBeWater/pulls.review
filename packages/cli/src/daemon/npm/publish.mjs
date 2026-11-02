// Builds the fork's CLI into a temporary folder and packs it as `jin.review`, leaving
// upstream's package.json and dist alone (dist may be serving).
// Usage: node packages/cli/src/daemon/npm/publish.mjs <n> [--publish]   (version <upstream>-fork.<n>)
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { build } from 'tsdown'

const [n, flag] = process.argv.slice(2)
if (!/^\d+$/.test(n ?? '') || (flag && flag !== '--publish'))
  throw new Error('Usage: node packages/cli/src/daemon/npm/publish.mjs <n> [--publish]')

const cli = fileURLToPath(new URL('../../../', import.meta.url))
const core = join(cli, '../core')
const read = file => JSON.parse(readFileSync(file, 'utf8'))
const pkg = read(join(cli, 'package.json'))
const out = mkdtempSync(join(tmpdir(), 'jin-review-'))
const run = (command, args, cwd = cli) => execFileSync(command, args, { cwd, stdio: 'inherit' })

// Bundle core from its source (tsconfig paths): the fork changes it, and upstream's build imports the published one.
await build({ cwd: cli, outDir: join(out, 'dist'), deps: { alwaysBundle: [/^@pulls\.review\/core(\/|$)/] } })
run('pnpm', ['-F', '@pulls.review/app', 'exec', 'vite', 'build', '--config', 'vite.config.local.ts', '--outDir', join(out, 'dist/client'), '--emptyOutDir'])
cpSync(join(cli, 'bin.mjs'), join(out, 'bin.mjs'))
cpSync(join(cli, '../../LICENSE'), join(out, 'LICENSE'))
cpSync(join(cli, 'src/daemon/npm/README.md'), join(out, 'README.md'))

// Every package the bundle imports is a dependency, pinned to the version installed here:
// catalog: and workspace: ranges mean nothing outside the monorepo.
const builtins = new Set(builtinModules)
const dependencies = {}
for (const file of readdirSync(join(out, 'dist')).filter(file => file.endsWith('.mjs'))) {
  for (const [, spec] of readFileSync(join(out, 'dist', file), 'utf8').matchAll(/(?:from|import)\s*(?:\(\s*)?["']([\w@][\w@/.-]*)["']/g)) {
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
    if (spec.startsWith('node:') || builtins.has(name) || dependencies[name])
      continue
    const installed = [cli, core].map(dir => join(dir, 'node_modules', name, 'package.json')).find(existsSync)
    if (!installed || name === '@pulls.review/core')
      throw new Error(`dist/${file} imports ${spec}, which is not a dependency of the CLI or core`)
    dependencies[name] = `^${read(installed).version}`
  }
}

const repo = 'https://github.com/JinJieBeWater/pulls.review'
writeFileSync(join(out, 'package.json'), `${JSON.stringify({
  name: 'jin.review',
  type: 'module',
  version: `${pkg.version}-fork.${n}`,
  description: `Unofficial fork of pulls.review with a multi-repo daemon. ${pkg.description}`,
  author: pkg.author,
  license: pkg.license,
  funding: pkg.funding,
  homepage: `${repo}/tree/multi-repo#readme`,
  repository: { type: 'git', url: `git+${repo}.git`, directory: 'packages/cli' },
  bugs: `${repo}/issues`,
  keywords: pkg.keywords,
  exports: pkg.exports,
  bin: { 'jin.review': './bin.mjs' },
  files: ['bin.mjs', 'dist'],
  engines: pkg.engines,
  dependencies: Object.fromEntries(Object.entries(dependencies).sort()),
}, null, 2)}\n`)

// A -fork.<n> version is a prerelease, which npm publishes only under an explicit tag.
run('npm', flag ? ['publish', '--access', 'public', '--tag', 'latest'] : ['pack', '--pack-destination', process.cwd()], out)
rmSync(out, { recursive: true })
