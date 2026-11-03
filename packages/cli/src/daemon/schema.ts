import { LOCAL_AGENT_NAMES } from '@pulls.review/core/analyze'
import { LOCALES } from '@pulls.review/core/locales'
import { AnalyzeProgressSchema } from '@pulls.review/core/types'
import * as v from 'valibot'

/** The fork's command on npm (`npm/publish.mjs`), apart from upstream's `pulls.review` so both can be installed. */
export const COMMAND = 'jin.review'
export const PWA_PROTOCOL = 'web+pullsreview'

export const PortSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535))
export const SecretSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/))

export const RepoSchema = v.object({ path: v.string() })
export type Repo = v.InferOutput<typeof RepoSchema>

export const WorktreeSchema = v.object({
  id: v.pipe(v.string(), v.regex(/^[\w-]+$/)),
  path: v.string(),
  branch: v.optional(v.string()),
})
export type Worktree = v.InferOutput<typeof WorktreeSchema>

export const StatusSchema = v.object({ pid: v.pipe(v.number(), v.integer(), v.minValue(1)) })
export const LaunchSchema = v.object({ url: v.pipe(v.string(), v.url()), path: v.pipe(v.string(), v.regex(/^\/r\/[\w-]+\//)) })
export const DaemonStateSchema = v.object({ ...StatusSchema.entries, port: PortSchema, session: SecretSchema })
export type DaemonState = v.InferOutput<typeof DaemonStateSchema>

export const DaemonStartSchema = v.object({ port: PortSchema })
export const WorktreeStartSchema = v.object({
  token: SecretSchema,
  basePath: v.pipe(v.string(), v.regex(/^\/r\/[\w-]+\/$/)),
})
export const LocaleSchema = v.picklist(LOCALES.map(entry => entry.code))

/** The daemon asks a worktree server to analyze a review page (plans/fork/03). */
export const WorktreeAnalyzeSchema = v.object({
  type: v.literal('analyze'),
  page: v.pipe(v.string(), v.startsWith('/')),
  agent: v.picklist(LOCAL_AGENT_NAMES),
  model: v.string(),
  locale: LocaleSchema,
  /** Analyze again even when the cached result is for the current head (the Herdr pane's re-analyze, plans/fork/04). */
  force: v.optional(v.boolean()),
})
export type WorktreeAnalyze = v.InferOutput<typeof WorktreeAnalyzeSchema>

/** The daemon asks a worktree server which analysis runs for a cache key (plans/fork/04). */
export const WorktreeRunningSchema = v.object({ type: v.literal('running'), id: v.number(), key: v.string() })
export const RunningStateSchema = v.object({ streamId: v.optional(v.string()), progress: v.optional(AnalyzeProgressSchema), error: v.optional(v.string()) })
export type RunningState = v.InferOutput<typeof RunningStateSchema>
export const WorktreeRunningReplySchema = v.object({ type: v.literal('running'), id: v.number(), state: RunningStateSchema })
const StartupFailureSchema = v.object({ type: v.literal('error'), message: v.string() })

export const DaemonMessageSchema = v.variant('type', [
  v.object({ type: v.literal('ready'), ...DaemonStateSchema.entries }),
  StartupFailureSchema,
])
export const WorktreeMessageSchema = v.variant('type', [
  v.object({ type: v.literal('ready'), port: PortSchema }),
  StartupFailureSchema,
])
