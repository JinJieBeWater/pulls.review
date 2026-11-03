import type { DiffsPayload } from '@pulls.review/core/types'
import type { LocalCall } from './analysis'
import type { WorktreeAnalyze } from './schema'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { createCacheRepositories } from '@pulls.review/core/cache'
import { LOCAL_RPC } from '@pulls.review/core/local-rpc'
import { createStorage } from 'unstorage'
import memoryDriver from 'unstorage/drivers/memory'
import { afterEach, expect, it, vi } from 'vitest'
import { analyzePage, targetForPage } from './analysis'

const exec = promisify(execFile)
let root: string | undefined
afterEach(async () => {
  if (root)
    await rm(root, { recursive: true, force: true })
})

it('maps each review page to the target the app gives it', async () => {
  root = await mkdtemp(join(tmpdir(), 'pulls-analysis-'))
  const env = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: '1' }
  await exec('git', ['init', '-b', 'main', root], { env })
  await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial'], { cwd: root, env })

  expect(await targetForPage(root, '/worktree')).toBe('')
  expect(await targetForPage(root, '/compare/main...feat%23x')).toBe('main...feat#x')
  expect(await targetForPage(root, '/commit/abc123')).toBe('abc123')
  expect(await targetForPage(root, '/branch/fix/a')).toBe('main...fix/a')
  expect(await targetForPage(root, '/')).toBeUndefined()
  expect(await targetForPage(root, '/gh/o/r/1')).toBeUndefined()
})

it('starts a keyed run for a page, unless one is running or the cached result is for the current head', async () => {
  const diffs = createCacheRepositories(createStorage({ driver: memoryDriver() })).diffs
  const head = { sha: 'h1' }
  const running = { streamId: undefined as string | undefined }
  const diff = (): DiffsPayload => ({ ref: { kind: 'local', repo: '/repo', target: '' }, title: 't', head: { sha: head.sha, ref: 'working tree' }, files: [] })
  const call = vi.fn<LocalCall>(async (name) => {
    switch (name) {
      case LOCAL_RPC.sourceKey: return 'key'
      case LOCAL_RPC.agentRunning: return running
      case LOCAL_RPC.sourceFetch: return diff()
      case LOCAL_RPC.agentAnalyze: return { streamId: 's' }
    }
  })
  const request: WorktreeAnalyze = { type: 'analyze', page: '/worktree', agent: 'pi', model: '', locale: 'en' }
  const analyzed = () => call.mock.calls.filter(([name]) => name === LOCAL_RPC.agentAnalyze)

  await analyzePage(call, diffs, '/repo', request)
  expect(analyzed()).toEqual([[LOCAL_RPC.agentAnalyze, { agent: 'pi', model: '', diff: diff(), locale: 'en', key: 'key' }]])
  expect((await diffs.get('key'))?.headSha).toBe('h1')

  running.streamId = 's'
  await analyzePage(call, diffs, '/repo', request)
  running.streamId = undefined
  await diffs.setAnalyzedResult('key', 'llm', { source: 'llm', groups: [], schemaVersion: 1, generatedAt: '', headSha: 'h1' })
  await analyzePage(call, diffs, '/repo', request)
  expect(analyzed()).toHaveLength(1)

  head.sha = 'h2'
  await analyzePage(call, diffs, '/repo', request)
  expect(analyzed()).toHaveLength(2)
  expect((await diffs.get('key'))?.headSha).toBe('h2')
})
