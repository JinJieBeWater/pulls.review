import { watch } from 'vue'
import { settings } from '../../state/settings'

/** What the daemon keeps for every page (plans/fork/03): the settings without the API keys, which stay in this browser. */
function shared() {
  const { gatewayToken: _gateway, anthropicApiKey: _anthropic, openaiApiKey: _openai, ...llm } = settings.value.llm
  return { locale: settings.value.locale, llm }
}

/** Takes the daemon's settings before any tab loads, then hands it every change a tab's settings dialog makes. */
export async function syncSettings(): Promise<void> {
  try {
    const response = await fetch('/api/settings')
    if (response.ok) {
      const stored: Partial<ReturnType<typeof shared>> = await response.json()
      settings.value = { ...settings.value, ...stored.locale && { locale: stored.locale }, llm: { ...settings.value.llm, ...stored.llm } }
    }
  }
  catch {
    // The daemon is down: the shell says so, and this browser's settings stand.
  }
  // Immediate: the first run seeds the daemon from this browser.
  watch(shared, value => void fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }).catch(() => {}), { deep: true, immediate: true })
}
