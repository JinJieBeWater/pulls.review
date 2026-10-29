import type { DevframeNodeContext } from 'devframe/types'
import process from 'node:process'
import { createDevServer } from 'devframe/adapters/dev'
import { createInteractiveAuth } from 'devframe/recipes/interactive-auth'
import * as v from 'valibot'
import devframe from '../devframe'
import { createAppWithRefRoutes } from '../spa'
import { WorktreeStartSchema } from './schema'

process.umask(0o077)
process.once('disconnect', () => process.kill(-process.pid, 'SIGKILL'))
process.once('message', async (message: unknown) => {
  try {
    const { token, basePath } = v.parse(WorktreeStartSchema, message)
    const server = await createDevServer(devframe, {
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
