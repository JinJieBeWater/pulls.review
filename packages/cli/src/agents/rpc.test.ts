import type { AgentStreamEvent } from '@pulls.review/core/local-rpc'
import type { DiffsPayload } from '@pulls.review/core/types'
import type { AgentChannel } from './rpc'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCacheRepositories } from '@pulls.review/core/cache'
import { LOCAL_RPC } from '@pulls.review/core/local-rpc'
import { createStorage } from 'unstorage'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installFakeAgents } from '../../test/fake-agents'
import { agentRpcFunctions } from './rpc'

/** A channel whose streams collect into memory, resolving when closed. */
function memoryChannel() {
  const streams = new Map<string, { events: AgentStreamEvent[], done: Promise<void> }>()
  let next = 0
  const channel: AgentChannel = {
    start() {
      const id = `stream-${++next}`
      const events: AgentStreamEvent[] = []
      let close!: () => void
      const done = new Promise<void>(resolve => close = resolve)
      streams.set(id, { events, done })
      return { id, write: event => events.push(event), close }
    },
  }
  return { channel, stream: (id: string) => streams.get(id)! }
}

const diff: DiffsPayload = {
  ref: { kind: 'github-pr', owner: 'o', repo: 'r', number: '1' },
  title: 'Add the thing',
  files: [
    { path: 'a.ts', sha: 'a1', status: 'added', additions: 1, deletions: 0, isBinary: false, hunks: [] },
    { path: 'b.test.ts', sha: 'b1', status: 'added', additions: 1, deletions: 0, isBinary: false, hunks: [] },
  ],
}

let fake: ReturnType<typeof installFakeAgents>
let dir: string
let cache: ReturnType<typeof createCacheRepositories>

function call(functions: ReturnType<typeof agentRpcFunctions>, name: string, ...args: unknown[]) {
  const fn = functions.find(candidate => candidate.name === name)
  // The handlers take the validated argument shapes; the test passes them as the browser would.
  return (fn!.handler as (...input: unknown[]) => unknown)(...args)
}

beforeEach(() => {
  fake = installFakeAgents()
  dir = mkdtempSync(join(tmpdir(), 'pulls-review-agent-rpc-'))
  cache = createCacheRepositories(createStorage())
})

afterEach(() => {
  fake.restore()
  rmSync(dir, { recursive: true, force: true })
})

describe('agent RPC', () => {
  it('lists agents with their models', async () => {
    const functions = agentRpcFunctions({ cwd: dir, patchDir: join(dir, 'patches'), channel: memoryChannel().channel, diffs: cache.diffs })
    expect(await call(functions, LOCAL_RPC.agentList)).toEqual([
      expect.objectContaining({ name: 'claude', models: expect.arrayContaining([{ id: 'sonnet', name: 'Sonnet (latest)' }]) }),
      expect.objectContaining({ name: 'opencode' }),
      expect.objectContaining({ name: 'pi' }),
      expect.objectContaining({ name: 'codex', models: [] }),
    ])
  })

  it('accepts Codex over RPC and returns a resumable analysis', async () => {
    fake.replay('codex-analysis.jsonl')
    const { channel, stream } = memoryChannel()
    const functions = agentRpcFunctions({ cwd: dir, patchDir: join(dir, 'patches'), channel, diffs: cache.diffs })
    const { streamId } = await call(functions, LOCAL_RPC.agentAnalyze, { agent: 'codex', diff, locale: 'en' }) as { streamId: string }
    await stream(streamId).done
    const events = stream(streamId).events
    expect(events.find(event => event.kind === 'result')?.result.groups[0]?.filePaths).toEqual(['a.ts', 'b.test.ts'])
    expect(events.at(-1)).toMatchObject({ kind: 'end', stopReason: 'done', agent: { agent: 'codex', id: 'sess-codex-1' } })
    expect(realpathSync(fake.calls()[0]!.cwd)).not.toBe(realpathSync(dir))
  })

  it('streams an analysis, ending with the result, and a GitHub diff runs outside the repository', async () => {
    fake.replay('claude-analysis.jsonl')
    const { channel, stream } = memoryChannel()
    const functions = agentRpcFunctions({ cwd: dir, patchDir: join(dir, 'patches'), channel, diffs: cache.diffs })

    const { streamId } = await call(functions, LOCAL_RPC.agentAnalyze, { agent: 'claude', diff, locale: 'en' }) as { streamId: string }
    await stream(streamId).done

    const events = stream(streamId).events
    expect(events.at(-1)).toMatchObject({ kind: 'end', stopReason: 'done' })
    expect(events.find(event => event.kind === 'result')?.result.groups).toHaveLength(1)
    expect(fake.calls()[0]!.cwd).not.toBe(dir)
  })

  it('keeps an analysis findable by its cache key while it runs, and saves its result there', async () => {
    fake.replay('claude-analysis.jsonl')
    process.env.FAKE_AGENT_SLEEP = '300'
    await cache.diffs.putDiff('pr:o/r#1', diff, '')
    const { channel, stream } = memoryChannel()
    const functions = agentRpcFunctions({ cwd: dir, patchDir: join(dir, 'patches'), channel, diffs: cache.diffs })

    const started = await call(functions, LOCAL_RPC.agentAnalyze, { agent: 'claude', diff, locale: 'en', key: 'pr:o/r#1' }) as { streamId: string }
    expect(await call(functions, LOCAL_RPC.agentRunning, { key: 'pr:o/r#1' })).toEqual(started)
    // Another tab asking for the same diff follows the same run.
    expect(await call(functions, LOCAL_RPC.agentAnalyze, { agent: 'claude', diff, locale: 'en', key: 'pr:o/r#1' })).toEqual(started)
    await stream(started.streamId).done
    delete process.env.FAKE_AGENT_SLEEP

    expect(fake.calls()).toHaveLength(1)
    expect(await call(functions, LOCAL_RPC.agentRunning, { key: 'pr:o/r#1' })).toEqual({ streamId: undefined })
    const entry = await cache.diffs.get('pr:o/r#1')
    expect(entry?.analyzedBy.llm).toEqual(stream(started.streamId).events.find(event => event.kind === 'result')?.result)
    expect(entry?.llmSession).toMatchObject({ chatStartIndex: entry!.llmSession!.messages.length, agent: { agent: 'claude' } })
  })

  it('keeps the same GitHub workspace when pi resumes analysis for chat', async () => {
    fake.replay('pi-analysis.jsonl', 'pi-chat-answer.jsonl')
    const { channel, stream } = memoryChannel()
    const functions = agentRpcFunctions({ cwd: dir, patchDir: join(dir, 'patches'), channel, diffs: cache.diffs })

    const analysis = await call(functions, LOCAL_RPC.agentAnalyze, { agent: 'pi', diff, locale: 'en' }) as { streamId: string }
    await stream(analysis.streamId).done
    const analyzed = stream(analysis.streamId).events
    const session = {
      messages: analyzed.findLast(event => event.kind === 'messages')!.messages,
      chatStartIndex: 0,
      agent: analyzed.findLast(event => event.kind === 'end')!.agent,
    }
    const chat = await call(functions, LOCAL_RPC.agentChat, { agent: 'pi', diff, locale: 'en', session, text: 'why?' }) as { streamId: string }
    await stream(chat.streamId).done

    expect(fake.calls().map(call => realpathSync(call.cwd))).toEqual([realpathSync(join(dir, 'patches', 'workspace')), realpathSync(join(dir, 'patches', 'workspace'))])
    expect(stream(chat.streamId).events.at(-1)).toMatchObject({ kind: 'end', stopReason: 'done' })
  })

  it('ends a failed run with its error, and an aborted one as aborted', async () => {
    fake.replay()
    fake.exitWith(1, 'boom')
    const { channel, stream } = memoryChannel()
    const functions = agentRpcFunctions({ cwd: dir, patchDir: join(dir, 'patches'), channel, diffs: cache.diffs })

    const failed = await call(functions, LOCAL_RPC.agentAnalyze, { agent: 'claude', diff, locale: 'en' }) as { streamId: string }
    await stream(failed.streamId).done
    expect(stream(failed.streamId).events.at(-1)).toMatchObject({ kind: 'end', stopReason: 'error', error: expect.stringContaining('boom') })

    fake.replay('claude-analysis.jsonl')
    process.env.FAKE_AGENT_SLEEP = '5000'
    const aborted = await call(functions, LOCAL_RPC.agentAnalyze, { agent: 'claude', diff, locale: 'en' }) as { streamId: string }
    await new Promise(resolve => setTimeout(resolve, 200))
    await call(functions, LOCAL_RPC.agentAbort, { streamId: aborted.streamId })
    await stream(aborted.streamId).done
    delete process.env.FAKE_AGENT_SLEEP
    expect(stream(aborted.streamId).events.at(-1)).toEqual({ kind: 'end', stopReason: 'aborted' })
  })

  it('forgets a keyed run that finished, and remembers why one failed', async () => {
    fake.replay('claude-analysis.jsonl')
    const { channel, stream } = memoryChannel()
    const functions = agentRpcFunctions({ cwd: dir, patchDir: join(dir, 'patches'), channel, diffs: cache.diffs })
    const running = await call(functions, LOCAL_RPC.agentAnalyze, { agent: 'claude', diff, locale: 'en', key: 'k' }) as { streamId: string }
    await stream(running.streamId).done
    // Its progress went out while it ran; none of it is left behind.
    expect(stream(running.streamId).events.some(event => event.kind === 'progress')).toBe(true)
    expect(await call(functions, LOCAL_RPC.agentRunning, { key: 'k' })).toEqual({ streamId: undefined })

    fake.replay()
    fake.exitWith(1, 'boom')
    const failed = await call(functions, LOCAL_RPC.agentAnalyze, { agent: 'claude', diff, locale: 'en', key: 'k' }) as { streamId: string }
    await stream(failed.streamId).done
    expect(await call(functions, LOCAL_RPC.agentRunning, { key: 'k' })).toEqual({ streamId: undefined, error: expect.stringContaining('boom') })
  })

  it('carries the lost-session code so the browser can offer re-analysis', async () => {
    fake.replay()
    fake.exitWith(1, 'Error: Session not found')
    const { channel, stream } = memoryChannel()
    const functions = agentRpcFunctions({ cwd: dir, patchDir: join(dir, 'patches'), channel, diffs: cache.diffs })
    const session = { messages: [{ role: 'user', content: 'analyze', timestamp: 0 }], chatStartIndex: 1, agent: { agent: 'opencode', id: 'gone' } }

    const { streamId } = await call(functions, LOCAL_RPC.agentChat, { agent: 'opencode', diff, locale: 'en', session, text: 'why?' }) as { streamId: string }
    await stream(streamId).done

    expect(stream(streamId).events.at(-1)).toMatchObject({ kind: 'end', stopReason: 'error', code: 'agent-session-lost' })
  })
})
