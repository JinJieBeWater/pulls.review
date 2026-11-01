import * as v from 'valibot'

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
export const LaunchSchema = v.object({ url: v.pipe(v.string(), v.url()), path: v.pipe(v.string(), v.regex(/^\/r\/[\w-]+\//)), shown: v.boolean() })
export const DaemonStateSchema = v.object({ ...StatusSchema.entries, port: PortSchema, session: SecretSchema })
export type DaemonState = v.InferOutput<typeof DaemonStateSchema>

export const DaemonStartSchema = v.object({ port: PortSchema })
export const WorktreeStartSchema = v.object({
  token: SecretSchema,
  basePath: v.pipe(v.string(), v.regex(/^\/r\/[\w-]+\/$/)),
})
const StartupFailureSchema = v.object({ type: v.literal('error'), message: v.string() })

export const DaemonMessageSchema = v.variant('type', [
  v.object({ type: v.literal('ready'), ...DaemonStateSchema.entries }),
  StartupFailureSchema,
])
export const WorktreeMessageSchema = v.variant('type', [
  v.object({ type: v.literal('ready'), port: PortSchema }),
  StartupFailureSchema,
])
