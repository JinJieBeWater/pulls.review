import type { DaemonState } from './schema'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as v from 'valibot'
import { DaemonStateSchema } from './schema'

export const stateDir = () => join(homedir(), '.pulls.review')
export const pidFile = () => join(stateDir(), 'daemon.pid')
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
