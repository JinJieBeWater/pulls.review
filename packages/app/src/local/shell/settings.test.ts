import { flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { settings } from '../../state/settings'
import { syncSettings } from './settings'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('takes the daemon\'s settings, keeps this browser\'s keys, and sends back every change without them', async () => {
  settings.value = { ...settings.value, locale: 'en', llm: { ...settings.value.llm, provider: 'gateway', gatewayToken: 'secret', agent: '' } }
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => Response.json(init ? {} : { locale: 'zh-CN', llm: { provider: 'local-agent', agent: 'pi' } }))
  vi.stubGlobal('fetch', fetch)

  await syncSettings()
  expect(settings.value.locale).toBe('zh-CN')
  expect(settings.value.llm).toMatchObject({ provider: 'local-agent', agent: 'pi', gatewayToken: 'secret' })

  settings.value.llm.agentModel = 'm'
  await flushPromises()
  const sent = fetch.mock.calls.filter(([, init]) => init?.method === 'PUT').map(([, init]) => JSON.parse(String(init!.body)))
  expect(sent).toHaveLength(2)
  expect(sent[1]).toMatchObject({ locale: 'zh-CN', llm: { provider: 'local-agent', agent: 'pi', agentModel: 'm' } })
  expect(JSON.stringify(sent)).not.toContain('secret')
})
