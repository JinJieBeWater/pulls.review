import type { LocalAgentName } from '@pulls.review/core/analyze'
import type { Locale } from '@pulls.review/core/locales'
import { readFile } from 'node:fs/promises'
import { LLM_PROVIDERS, LOCAL_AGENT_NAMES } from '@pulls.review/core/analyze'
import * as v from 'valibot'
import { atomicWrite } from './registry'
import { LocaleSchema } from './schema'

const text = v.optional(v.pipe(v.string(), v.maxLength(512)))

/** The settings every page of the daemon shares (plans/fork/03): the app's, without the API keys, which stay in the browser. */
export const SharedSettingsSchema = v.object({
  locale: v.optional(LocaleSchema),
  llm: v.optional(v.object({
    provider: v.optional(v.picklist(LLM_PROVIDERS)),
    gatewayModel: text,
    anthropicModel: text,
    openaiBaseUrl: text,
    openaiModel: text,
    agent: v.optional(v.picklist(['', ...LOCAL_AGENT_NAMES])),
    agentModel: text,
  })),
})
export type SharedSettings = v.InferOutput<typeof SharedSettingsSchema>

export interface SettingsStore {
  read: () => Promise<SharedSettings>
  write: (settings: SharedSettings) => Promise<void>
}

export function createSettingsStore(file: string): SettingsStore {
  return {
    async read() {
      try {
        return v.parse(SharedSettingsSchema, JSON.parse(await readFile(file, 'utf8')))
      }
      catch (error) {
        // Missing, or written by another version: the shell seeds it again from the browser.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError || error instanceof v.ValiError)
          return {}
        throw error
      }
    },
    write: settings => atomicWrite(file, settings),
  }
}

/** The local agent a daemon-started analysis runs, when the settings pick one. */
export function agentChoice(settings: SharedSettings): { agent: LocalAgentName, model: string, locale: Locale } | undefined {
  const { provider, agent, agentModel = '' } = settings.llm ?? {}
  return provider === 'local-agent' && agent ? { agent, model: agentModel, locale: settings.locale ?? 'en' } : undefined
}
