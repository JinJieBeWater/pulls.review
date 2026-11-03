import type { DevframeNodeContext } from 'devframe/types'
import type { LocalCall } from './analysis'
import process from 'node:process'
import { createCacheRepositories } from '@pulls.review/core/cache'
import { LOCAL_DEVFRAME_ID, LOCAL_RPC } from '@pulls.review/core/local-rpc'
import { createDevServer } from 'devframe/adapters/dev'
import { createInteractiveAuth } from 'devframe/recipes/interactive-auth'
import { createStorage } from 'unstorage'
import * as v from 'valibot'
import devframe from '../devframe'
import { createAppWithRefRoutes } from '../spa'
import { createRepoCacheDriver } from '../storage'
import { analyzePage } from './analysis'
import { WorktreeAnalyzeSchema, WorktreeRunningSchema, WorktreeStartSchema } from './schema'

process.umask(0o077)
process.once('disconnect', () => process.kill(-process.pid, 'SIGKILL'))

let call: LocalCall | undefined
const diffs = createRepoCacheDriver(process.cwd()).then(driver => createCacheRepositories(createStorage({ driver })).diffs)
process.on('message', (message: unknown) => {
  const request = v.safeParse(WorktreeAnalyzeSchema, message)
  // Nobody reads this process's output: a failure surfaces as the page starting the run itself.
  if (request.success && call)
    void diffs.then(cache => analyzePage(call!, cache, process.cwd(), request.output)).catch(() => {})
  const running = v.safeParse(WorktreeRunningSchema, message)
  if (running.success) {
    const { id, key } = running.output
    void (call ? call(LOCAL_RPC.agentRunning, { key }) : Promise.resolve({}))
      .catch(error => ({ error: error instanceof Error ? error.message : String(error) }))
      .then(state => process.send?.({ type: 'running', id, state }))
  }
})

process.once('message', async (message: unknown) => {
  try {
    const { token, basePath } = v.parse(WorktreeStartSchema, message)
    const server = await createDevServer({
      ...devframe,
      async setup(ctx, info) {
        await devframe.setup(ctx, info)
        const { rpc } = ctx.scope(LOCAL_DEVFRAME_ID)
        call = (name, args) => rpc.call(name, args)
      },
    }, {
      app: createAppWithRefRoutes(basePath),
      basePath,
      host: '127.0.0.1',
      port: 0,
      openBrowser: false,
      // @ts-expect-error devframe 1.2.6 supports factories at runtime but omits them in this adapter's types.
      auth: (ctx: DevframeNodeContext) => createInteractiveAuth(ctx, { clientAuthTokens: [token] }),
    })
    process.send?.({ type: 'ready', port: server.port })
  }
  catch (error) {
    process.send?.({ type: 'error', message: error instanceof Error ? error.message : String(error) }, () => process.exit(1))
  }
})
