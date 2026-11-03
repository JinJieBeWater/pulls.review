import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { DiffCache, LlmSession } from '@pulls.review/core/cache'
import type { AgentStreamEvent } from '@pulls.review/core/local-rpc'
import type { AgentSessionRef, GroupedResult } from '@pulls.review/core/types'
import type { AgentChatOptions } from './chat'
import type { AgentRunOptions } from './run'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { LOCAL_AGENT_NAMES } from '@pulls.review/core/analyze'
import { AGENT_SESSION_LOST, LOCAL_RPC, LocalAgentInfoSchema } from '@pulls.review/core/local-rpc'
import { LOCALES } from '@pulls.review/core/locales'
import { AgentSessionRefSchema, DiffsPayloadSchema } from '@pulls.review/core/types'
import { defineRpcFunction } from 'devframe'
import * as v from 'valibot'
import { runAgentAnalysis } from './analyze'
import { runAgentChat } from './chat'
import { agents, detectAgents } from './index'
import { AgentRunError } from './run'

/** The part of devframe's `RpcStreamingChannel` the agent functions use. */
export interface AgentChannel {
  start: () => {
    id: string
    write: (event: AgentStreamEvent) => void
    close: () => void
  }
}

export interface AgentRpcOptions {
  /** The repository under review: where a local diff's agent runs. */
  cwd: string
  /** Where patches are written for the agent (under the repo's cache dir). */
  patchDir: string
  channel: AgentChannel
  /** Where an analysis saves its result, for the page that started it and may have left. */
  diffs: DiffCache
}

const agentName = v.picklist(LOCAL_AGENT_NAMES)
const locale = v.picklist(LOCALES.map(entry => entry.code))
const AnalyzeArgs = v.object({ agent: agentName, model: v.optional(v.string()), diff: DiffsPayloadSchema, locale })
const AnalyzeRunArgs = v.object({ ...AnalyzeArgs.entries, key: v.optional(v.string()) })
const ChatArgs = v.object({
  ...AnalyzeArgs.entries,
  session: v.object({ messages: v.array(v.looseObject({ role: v.string() })), chatStartIndex: v.number(), agent: v.optional(AgentSessionRefSchema) }),
  text: v.optional(v.string()),
})

/** What an analysis reported, to save once it ends. */
interface Outcome {
  messages: AgentMessage[]
  result?: GroupedResult
  agent?: AgentSessionRef
}

function record(outcome: Outcome, event: AgentStreamEvent): void {
  if (event.kind === 'messages')
    outcome.messages = event.messages
  else if (event.kind === 'result')
    outcome.result = event.result
  else if (event.kind === 'end')
    outcome.agent = event.agent
}

/** `agent.*`: analysis and chat through a local agent CLI, streamed on `channel` (`plans/11-local-agents.md`). */
export function agentRpcFunctions({ cwd, patchDir, channel, diffs }: AgentRpcOptions) {
  const running = new Map<string, AbortController>()
  /** Analyses by the cache key of their diff, so a reloaded page or another tab follows the same run. */
  const analyses = new Map<string, string>()
  let detected: Promise<v.InferOutput<typeof LocalAgentInfoSchema>[]> | undefined

  /** Saves a finished analysis as the page would, for when no page is left to. */
  async function save(key: string, { messages, result, agent }: Outcome) {
    if (!result)
      return
    // shortcut: the browser's cache writes take their own lock, so one of its writes landing in between can be lost; a server-owned write path would fix it.
    try {
      await diffs.setAnalyzedResult(key, 'llm', result)
      await diffs.setLlmSession(key, { messages, chatStartIndex: messages.length, agent } satisfies LlmSession)
    }
    catch (error) {
      console.warn(`pulls.review: could not save the analysis: ${error instanceof Error ? error.message : error}`)
    }
  }

  /**
   * Starts `run` on a fresh stream and returns its id at once; the stream carries the outcome.
   * Only `agent-abort` stops it - a page leaving doesn't, so it can come back and follow it again.
   * With a `key`, the result is saved to the cache too, in case no page is left to save it.
   */
  function start(args: v.InferOutput<typeof AnalyzeArgs>, run: (options: AgentRunOptions) => Promise<void>, key?: string): { streamId: string } {
    const sink = channel.start()
    const controller = new AbortController()
    running.set(sink.id, controller)
    if (key)
      analyses.set(key, sink.id)
    const outcome: Outcome = { messages: [] }

    void (async () => {
      // A GitHub diff is analyzed from its patch alone, not in whatever is checked out here.
      // The workspace stays stable so CLIs that scope sessions by cwd can resume chat.
      const local = args.diff.ref.kind === 'local'
      const scratch = local ? undefined : join(patchDir, 'workspace')
      if (scratch)
        await mkdir(scratch, { recursive: true })
      try {
        await run({
          cli: agents[args.agent],
          model: args.model || undefined,
          diff: args.diff,
          locale: args.locale,
          cwd: scratch ?? cwd,
          patchDir,
          emit: (event) => {
            record(outcome, event)
            sink.write(event)
          },
          signal: controller.signal,
        })
      }
      catch (error) {
        if (controller.signal.aborted)
          sink.write({ kind: 'end', stopReason: 'aborted' })
        else if (error instanceof AgentRunError)
          sink.write({ kind: 'end', stopReason: 'error', error: error.message, code: error.code === AGENT_SESSION_LOST ? error.code : undefined })
        else
          sink.write({ kind: 'end', stopReason: 'error', error: error instanceof Error ? error.message : String(error) })
      }
      finally {
        // Saved before the run is forgotten, so a page that finds no run finds its result.
        if (key) {
          await save(key, outcome)
          analyses.delete(key)
        }
        running.delete(sink.id)
        sink.close()
      }
    })()
    return { streamId: sink.id }
  }

  return [
    defineRpcFunction({
      name: LOCAL_RPC.agentList,
      type: 'query',
      args: [],
      returns: v.array(LocalAgentInfoSchema),
      handler: () => detected ??= detectAgents(),
    }),
    defineRpcFunction({
      name: LOCAL_RPC.agentAnalyze,
      type: 'query',
      args: [AnalyzeRunArgs],
      returns: v.object({ streamId: v.string() }),
      handler: ({ key, ...args }) => {
        const streamId = key && analyses.get(key)
        return streamId ? { streamId } : start(args, runAgentAnalysis, key)
      },
    }),
    defineRpcFunction({
      name: LOCAL_RPC.agentRunning,
      type: 'query',
      args: [v.object({ key: v.string() })],
      returns: v.object({ streamId: v.optional(v.string()) }),
      handler: ({ key }) => ({ streamId: analyses.get(key) }),
    }),
    defineRpcFunction({
      name: LOCAL_RPC.agentChat,
      type: 'query',
      args: [ChatArgs],
      returns: v.object({ streamId: v.string() }),
      // The wire validates messages loosely (`local-rpc.ts`); they are the pi messages the browser stored.
      handler: ({ session, text, ...args }) => start(args, options => runAgentChat({ ...options, session: session as LlmSession, text } satisfies AgentChatOptions)),
    }),
    defineRpcFunction({
      name: LOCAL_RPC.agentAbort,
      type: 'action',
      args: [v.object({ streamId: v.string() })],
      returns: v.void(),
      handler: ({ streamId }) => {
        running.get(streamId)?.abort()
      },
    }),
  ]
}
