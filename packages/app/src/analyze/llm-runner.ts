import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { LlmSession } from '@pulls.review/core/cache'
import type { LlmAnalyzeOptions } from '@pulls.review/core/llm'
import type { AgentSessionRef, DiffsPayload, GroupedResult } from '@pulls.review/core/types'

export interface LlmAnalyzeRun {
  result: GroupedResult
  transcript: AgentMessage[]
  /** Set when a local agent CLI ran the analysis, so the chat can continue its session. */
  agent?: AgentSessionRef
}

export interface LlmRunOptions extends LlmAnalyzeOptions {
  /** The diff's cache key: a server run is found again by it, and saves its result under it. */
  key?: string
}

/** `signal.reason` when the page stops following a run without meaning to stop it. */
export const DETACHED = 'detached'

export interface LlmChatInput {
  diff: DiffsPayload
  /** The transcript to continue; its last message is the user's turn, or the failed reply `text` absent retries from. */
  session: LlmSession
  /** The user's new message; absent means continue the transcript as it is (the chat's retry). */
  text?: string
  signal: AbortSignal
  /** The live transcript so far, replaced each time. */
  onMessages: (messages: AgentMessage[]) => void
  onGroupingUpdate: (result: GroupedResult) => void | Promise<void>
}

/**
 * Where a model runs: in this browser with a key from Settings (the site), or on the
 * `pulls.review` server through a local agent CLI (`plans/11-local-agents.md`). One per
 * app context; `createLlmStore` and `useLlmChat` only talk to this.
 */
export interface LlmRunner {
  /** Reactive: reads Settings (and, for the server, what it found). */
  isSetup: () => boolean
  /** Whether a run started now goes on when the page goes (a server run); absent means it doesn't. */
  outlivesPage?: () => boolean
  analyze: (diff: DiffsPayload, options: LlmRunOptions) => Promise<LlmAnalyzeRun>
  /** The run the server is still doing for `key`, to follow; `undefined` when there is none. A browser run ends with its page. */
  attach?: (key: string) => Promise<((options: LlmRunOptions) => Promise<LlmAnalyzeRun>) | undefined>
  /** Resolves to the whole transcript after the reply; an error reply is a message with `stopReason: 'error'`, not a rejection. */
  chat: (input: LlmChatInput) => Promise<AgentMessage[]>
}
