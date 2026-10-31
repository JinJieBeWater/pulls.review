import type { DaemonState } from './schema'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as v from 'valibot'
import { atomicWrite } from './registry'
import { DaemonStateSchema, SecretSchema } from './schema'
import { secret } from './security'

export const stateDir = () => join(homedir(), '.pulls.review')
export const pidFile = () => join(stateDir(), 'daemon.pid')
const sessionFile = () => join(stateDir(), 'session.json')
export const daemonOrigin = (port: number) => `http://127.0.0.1:${port}`

export async function readState(): Promise<DaemonState | undefined> {
  try {
    return v.parse(DaemonStateSchema, JSON.parse(await readFile(pidFile(), 'utf8')))
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return undefined
    throw error
  }
}

/** The sign-in secret, kept across restarts so an installed app stays signed in. */
export async function loadSession(): Promise<string> {
  try {
    const parsed = v.safeParse(v.object({ session: SecretSchema }), JSON.parse(await readFile(sessionFile(), 'utf8')))
    if (parsed.success)
      return parsed.output.session
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError))
      throw error
  }
  const session = secret()
  await atomicWrite(sessionFile(), { session })
  return session
}
