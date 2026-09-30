import { useCallback, useEffect, useState } from 'react'
import {
  Download,
  Share,
  Bell,
  BellOff,
  BellRing,
  Info,
  Stethoscope,
  X,
} from 'lucide-react'
import {
  onInstallAvailabilityChange,
  promptInstall,
  canShowIOSInstallHint,
} from '../lib/pwa.js'
import { pushState, requestPushPermission, disablePush } from '../lib/push.js'
import { useToast } from '../context/ToastContext.jsx'

const IOS_HINT_KEY = 'wpchat.iosInstallHintDismissed'

/**
 * The PWA + notification items inside the account menu. Kept separate from
 * Shell so the menu markup stays readable.
 */
export default function AccountMenuExtras({ onAction, onOpenDiagnostics }) {
  const toast = useToast()
  const [canInstall, setCanInstall] = useState(false)
  const [permission, setPermission] = useState(() => pushState())
  const [busy, setBusy] = useState(false)
  // localStorage, so dismissing it sticks across sessions — the hint is
  // genuinely one-time rather than once per visit.
  const [iosHintDismissed, setIosHintDismissed] = useState(() => {
    try {
      return localStorage.getItem(IOS_HINT_KEY) === '1'
    } catch {
      return false
    }
  })

  useEffect(() => onInstallAvailabilityChange(setCanInstall), [])

  const dismissIosHint = useCallback(() => {
    setIosHintDismissed(true)
    try {
      localStorage.setItem(IOS_HINT_KEY, '1')
    } catch {
      /* private mode — the hint simply reappears next time */
    }
  }, [])

  const install = async () => {
    const accepted = await promptInstall()
    setCanInstall(false)
    if (accepted) toast.success('Installed', 'Inbox has been added to your device.')
    onAction?.()
  }

  const toggleNotifications = async () => {
    setBusy(true)
    try {
      if (permission === 'granted') {
        await disablePush()
        setPermission(pushState())
        toast.success('Notifications off', 'You will no longer be alerted on this device.')
        return
      }

      const result = await requestPushPermission()
      setPermission(pushState())

      if (result.ok) {
        toast.success('Notifications on', 'You will be alerted about new messages.')
      } else if (result.reason === 'denied') {
        toast.error(
          'Notifications blocked',
          'Enable them in Settings → Notifications → Inbox.'
        )
      } else if (result.reason === 'needs-install') {
        toast.error('Add to Home Screen first', 'Push only works from the installed app.')
      } else if (result.reason === 'not-configured') {
        toast.error('Not available', 'Push is not configured on the server yet.')
      } else {
        // Verbatim reason — the generic message used to hide the cause, and
        // 'default' produced no toast at all.
        toast.error(
          `Could not enable notifications (${result.reason})`,
          result.error || 'No further detail was reported.'
        )
      }
    } finally {
      setBusy(false)
      onAction?.()
    }
  }

  const showIosHint = canShowIOSInstallHint() && !iosHintDismissed

  return (
    <>
      {canInstall ? (
        <button type="button" className="menu-item" role="menuitem" onClick={install}>
          <Download size={15} />
          Install app
        </button>
      ) : null}

      {/* Push is unavailable in a Safari tab, so offer installation instead of
          a toggle that could not possibly work. */}
      {permission !== 'unsupported' && permission !== 'needs-install' ? (
        <button
          type="button"
          className="menu-item"
          role="menuitem"
          disabled={busy}
          onClick={toggleNotifications}
        >
          {permission === 'granted' ? (
            <BellRing size={15} />
          ) : permission === 'denied' ? (
            <BellOff size={15} />
          ) : (
            <Bell size={15} />
          )}
          <span style={{ flex: 1 }}>Notifications</span>
          <span className="menu-item-state">
            {permission === 'granted' ? 'On' : permission === 'denied' ? 'Blocked' : 'Off'}
          </span>
        </button>
      ) : null}

      {/* TEMPORARY — remove with the push diagnostics panel. */}
      <button
        type="button"
        className="menu-item"
        role="menuitem"
        onClick={() => {
          onAction?.()
          onOpenDiagnostics?.()
        }}
      >
        <Stethoscope size={15} />
        Push diagnostics
      </button>

      {showIosHint ? (
        <div className="menu-hint">
          <Share size={14} />
          <span>
            Tap <strong>Share</strong> → <strong>Add to Home Screen</strong> to install
            Inbox and enable notifications.
          </span>
          <button
            type="button"
            className="menu-hint-close"
            aria-label="Dismiss"
            onClick={dismissIosHint}
          >
            <X size={13} />
          </button>
        </div>
      ) : null}

      {permission === 'denied' ? (
        <div className="menu-hint">
          <Info size={14} />
          <span>
            Notifications are blocked. Re-enable them in Settings → Notifications →
            Inbox.
          </span>
        </div>
      ) : null}
    </>
  )
}
