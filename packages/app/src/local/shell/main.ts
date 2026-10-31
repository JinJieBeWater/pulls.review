import { createApp } from 'vue'
import { i18n } from '../../i18n'
import Shell from './Shell.vue'
// Follows the scheme a tab switches to, like every other page of the origin.
import '../../state/dark'
import '../../styles'

createApp(Shell).use(i18n).mount('#app')
// Keeps the shell openable while the daemon is down, to say so (see the daemon's `/sw.js`).
void navigator.serviceWorker?.register('/sw.js')
