import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { CacheRepositories, LlmSession } from '@pulls.review/core/cache'
import type { DiffsPayload, GroupedResult } from '@pulls.review/core/types'
import type { Ref } from 'vue'
import type { LlmAnalyzeRun, LlmRunner, LlmRunOptions } from '../analyze/llm-runner'
import type { DiffsStoreLlm, LlmProgress } from './types'
import { computed, reactive, ref, shallowRef } from 'vue'
import { DETACHED } from '../analyze/llm-runner'
import { useLlmChat } from '../composables/useLlmChat'
import { describeProgress, localizeError } from '../i18n/core-messages'

export interface LlmStoreOptions {
  cache: CacheRepositories
  /** Where the model runs (the browser, or the `pulls.review` server's local agent). */
  runner: LlmRunner
  diff: Ref<DiffsPayload | undefined>
  /** The analysis transcript the chat continues from; `createDiffsStore` owns it because it is loaded from and reset with the PR cache entry. */
  session: Ref<LlmSession | undefined>
  /** PR cache key of the loaded diff; unset until the diff loads. */
  getCacheKey: () => string | undefined
  /** Publishes a fresh AI result as `analyzedBy.llm`. */
  setResult: (result: GroupedResult) => void
  /** Switches the view onto the `llm` grouping once a run has finished. */
  showLlmResult: () => Promise<void>
}

/**
 * The LLM sub-store behind `DiffsStore.llm` - analysis runs, their progress/error, and
 * follow-up chat. Only ever loaded by `createDiffsStore` via `import()` behind
 * `import.meta.env.PR_LLM`, so a build with the flag off ships none of it.
 */
export function createLlmStore(opts: LlmStoreOptions): DiffsStoreLlm {
  const isAnalyzing = ref(false)
  const progress = ref<LlmProgress>()
  const transcript = shallowRef<AgentMessage[]>([])
  const error = ref<Error>()
  const isSetup = computed(() => opts.runner.isSetup())
  let abortController: AbortController | undefined

  async function setSession(session: LlmSession) {
    opts.session.value = session
    const key = opts.getCacheKey()
    if (key)
      await opts.cache.diffs.setLlmSession(key, session)
  }

  async function setResult(result: GroupedResult) {
    opts.setResult(result)
    const key = opts.getCacheKey()
    if (key)
      await opts.cache.diffs.setAnalyzedResult(key, 'llm', result)
  }

  const chat = useLlmChat({
    runner: opts.runner,
    diff: opts.diff,
    session: opts.session,
    onSessionChange: setSession,
    onGroupingUpdate: setResult,
  })

  async function track(run: (options: LlmRunOptions) => Promise<LlmAnalyzeRun>) {
    error.value = undefined
    transcript.value = []
    isAnalyzing.value = true
    const controller = new AbortController()
    abortController = controller
    try {
      const { result, transcript: messages, agent } = await run({
        onProgress: next => progress.value = { step: next.step, message: describeProgress(next) },
        onTranscript: next => transcript.value = next,
        signal: controller.signal,
        key: opts.getCacheKey(),
      })
      if (controller.signal.aborted)
        return
      await setResult(result)
      await setSession({ messages, chatStartIndex: messages.length, agent })
    }
    catch (err) {
      if (!controller.signal.aborted)
        error.value = localizeError(err)
    }
    finally {
      if (abortController === controller)
        abortController = undefined
      progress.value = undefined
      isAnalyzing.value = false
    }
    await opts.showLlmResult()
  }

  async function reanalyze() {
    const currentDiff = opts.diff.value
    if (!currentDiff)
      return
    chat.stop()
    await track(options => opts.runner.analyze(currentDiff, options))
  }

  async function resume() {
    const key = opts.getCacheKey()
    const follow = key && !isAnalyzing.value ? await opts.runner.attach?.(key) : undefined
    if (follow)
      await track(follow)
  }

  function abort() {
    chat.stop()
    abortController?.abort()
  }

  function detach() {
    chat.stop()
    abortController?.abort(DETACHED)
  }

  return reactive({
    isSetup,
    isAnalyzing,
    progress,
    transcript,
    error,
    reanalyze,
    resume,
    chat: reactive(chat),
    abort,
    detach,
  }) as DiffsStoreLlm
}
