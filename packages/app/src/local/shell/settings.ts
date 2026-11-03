import { watch } from 'vue'
import { settings } from '../../state/settings'

/** What the daemon keeps for every page (plans/fork/03): the settings without the API keys, which stay in this browser. */
function shared() {
  const { gatewayToken: _gateway, anthropicApiKey: _anthropic, openaiApiKey: _openai, ...llm } = settings.value.llm
  return { locale: settings.value.locale, llm }
}

/** Merges the daemon's settings into this browser's, which keep their API keys. */
async function pull(): Promise<void> {
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
}

/** Takes the daemon's settings before any tab loads, then hands it every change a tab's settings dialog makes. */
export async function syncSettings(): Promise<void> {
  await pull()
  // The Herdr pane writes the agent and model too: take the daemon's copy again when this window comes back,
  // so a change made here doesn't send back what the pane replaced.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible')
      void pull()
  })
  // Immediate: the first run seeds the daemon from this browser.
  watch(shared, value => void fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }).catch(() => {}), { deep: true, immediate: true })
}
