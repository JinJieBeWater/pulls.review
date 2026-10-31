// Fork-only (plans/fork/02): a page running as a tab of the daemon's shell, whose header has the logo and the page-wide controls.
import { openSettings } from '../../state/settingsModal'

export const inShell = import.meta.env.PR_LOCAL && window.top !== window

/** Sent by the shell's gear to the active tab: the dialog needs the app's context, which only the tab has. */
export const OPEN_SETTINGS_EVENT = 'pulls.review:open-settings'

/** Sent by a tab to the shell, with a `/r/<id>/` URL in `detail`: shows that worktree's tab, or opens one. */
export const OPEN_WORKTREE_EVENT = 'pulls.review:open-worktree'

if (inShell)
  window.addEventListener(OPEN_SETTINGS_EVENT, () => openSettings())
