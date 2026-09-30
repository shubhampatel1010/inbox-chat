import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  Inbox as InboxIcon,
  Users,
  MessageSquare,
  Sun,
  Moon,
  Volume2,
  VolumeX,
  KeyRound,
  LogOut,
  AlertTriangle,
  Wifi,
  WifiOff,
  RefreshCw,
  Settings as SettingsIcon,
  Sparkles,
  ShieldCheck,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useTheme } from '../context/ThemeContext.jsx'
import { useInbox } from '../context/InboxContext.jsx'
import { useChannel, formatUptime } from '../context/ChannelContext.jsx'
import { initials } from '../lib/format.js'
import { armAudio } from '../lib/chime.js'
import ChangePasswordModal from './ChangePasswordModal.jsx'
import AccountMenuExtras from './AccountMenuExtras.jsx'
import AccountSwitcher, { AccountSwitcherMenuItems } from './AccountSwitcher.jsx'
import PushDiagnostics from './PushDiagnostics.jsx'
import ReconnectModal from './ReconnectModal.jsx'
import PortalAssistant from './PortalAssistant.jsx'
// Removable "new lead" feature — see functions/api/leads/mine.js to remove.
import LeadsBell from '../features/leads/LeadsBell.jsx'

export default function Shell() {
  const { user, isAdmin, logout } = useAuth()
  const { isDark, toggleTheme, soundOn, toggleSound } = useTheme()
  const { totalUnread, mobileView, openConversation } = useInbox()
  const channel = useChannel()
  const location = useLocation()
  const navigate = useNavigate()

  const [menuOpen, setMenuOpen] = useState(false)
  const [changingPassword, setChangingPassword] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  // The inbox-wide AI panel. Lives in the shell rather than on a page so it is
  // reachable from Inbox, Team, Sync and Settings alike.
  const [askingAi, setAskingAi] = useState(false)
  // TEMPORARY — remove with the push diagnostics panel.
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const menuRef = useRef(null)

  useEffect(() => {
    if (!menuOpen) return undefined
    const onDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const title = location.pathname.startsWith('/team')
    ? 'Team'
    : location.pathname.startsWith('/sync')
      ? 'Sync'
      : location.pathname.startsWith('/settings')
        ? 'Settings'
        : 'Inbox'

  return (
    <div className="shell" data-mobile-view={mobileView}>
      <nav className="rail" aria-label="Primary">
        <div className="rail-mark" aria-hidden="true">
          <MessageSquare size={17} />
        </div>

        <NavLink
          to="/inbox"
          className={({ isActive }) => `rail-link${isActive ? ' is-active' : ''}`}
          title="Inbox"
          aria-label={totalUnread > 0 ? `Inbox, ${totalUnread} unread` : 'Inbox'}
        >
          <InboxIcon size={19} />
          {totalUnread > 0 ? (
            <span className="rail-badge">{totalUnread > 99 ? '99+' : totalUnread}</span>
          ) : null}
        </NavLink>

        {isAdmin ? (
          <NavLink
            to="/team"
            className={({ isActive }) => `rail-link${isActive ? ' is-active' : ''}`}
            title="Team"
            aria-label="Team"
          >
            <Users size={19} />
          </NavLink>
        ) : null}

        {isAdmin ? (
          <NavLink
            to="/attention-log"
            className={({ isActive }) => `rail-link${isActive ? ' is-active' : ''}`}
            title="Attention audit log"
            aria-label="Attention audit log"
          >
            <ShieldCheck size={18} />
          </NavLink>
        ) : null}

        {isAdmin ? (
          <NavLink
            to="/sync"
            className={({ isActive }) => `rail-link${isActive ? ' is-active' : ''}`}
            title="Sync missed messages"
            aria-label="Sync missed messages"
          >
            <RefreshCw size={18} />
          </NavLink>
        ) : null}

        {isAdmin ? (
          <NavLink
            to="/settings"
            className={({ isActive }) => `rail-link${isActive ? ' is-active' : ''}`}
            title="Accounts & settings"
            aria-label="Accounts and settings"
          >
            <SettingsIcon size={18} />
          </NavLink>
        ) : null}

        {/* Below the destinations and above the spacer: the account is not a
            place you navigate to, it is the scope everything above is shown
            in, so it sits apart from the links rather than among them.
            Hidden with a single account, and absent on mobile with the rail —
            the user menu carries it there. */}
        <AccountSwitcher />

        <div className="rail-spacer" />
      </nav>

      <div className="main">
        {/* Shown to agents as well as admins: when the channel is down nothing
            arrives, and an agent staring at a silent inbox needs to know why. */}
        {/* An account that has never been connected is not "disconnected" —
            it is unconfigured, and the fix is in Settings, not the QR. */}
        {channel.unconfigured && isAdmin ? (
          <div className="channel-banner" role="status">
            <AlertTriangle size={15} />
            <span>
              {channel.accountName ? `"${channel.accountName}" has` : 'This account has'} no
              WhatsApp channel connected yet.
            </span>
            <button
              type="button"
              className="channel-banner-fix"
              onClick={() => navigate('/settings')}
            >
              Open settings
            </button>
          </div>
        ) : null}

        {channel.disconnected ? (
          <div className="channel-banner" role="status">
            <AlertTriangle size={15} />
            <span>
              {/* Naming the account matters once there are several — otherwise
                  the banner reads as "everything is down". */}
              {channel.accountName ? `"${channel.accountName}" is` : 'WhatsApp is'} disconnected —
              messages are not being sent or received.
            </span>
            {/* Open to every signed-in user now — whoever is on shift can scan
                the QR and reconnect, not just an admin. */}
            <button
              type="button"
              className="channel-banner-fix"
              onClick={() => setReconnecting(true)}
            >
              Reconnect
            </button>
          </div>
        ) : null}

        <header className="topbar">
          <span className="topbar-title">{title}</span>
          <div className="topbar-spacer" />

          {/* Removable "new lead" feature. Renders nothing when the caller has
              no new leads, so it is invisible to users who own none. */}
          <LeadsBell />

          {/* The inbox-wide assistant. Distinct from the per-row summary
              popover: this one reads every chat the user can reach, so it
              belongs in the chrome rather than on any one conversation. */}
          <button
            type="button"
            className="topbar-ai"
            onClick={() => setAskingAi(true)}
            title="Ask AI about all chats"
            aria-label="Ask AI about all chats"
          >
            <Sparkles size={15} />
            <span className="topbar-ai-label">Ask AI</span>
          </button>

          <div className="user-menu" ref={menuRef}>
            <button
              type="button"
              className="user-trigger"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <span className="avatar" aria-hidden="true">
                {initials(user?.name)}
              </span>
            </button>

            {menuOpen ? (
              <div className="menu" role="menu">
                <div className="menu-head">
                  <div className="menu-head-name">{user?.name}</div>
                  <div className="menu-head-email">{user?.email}</div>
                </div>

                {/* Mobile only, and only with several accounts. The rail holds
                    this on desktop, but the rail is gone below 720px and the
                    channel row right underneath is account-scoped — so the
                    switcher has to come first for that status to be readable. */}
                <AccountSwitcherMenuItems onAction={() => setMenuOpen(false)} />

                {/* Channel status + reconnect for every signed-in user, so any
                    agent can see the state and reconnect from the menu too. */}
                <div className={`menu-channel${channel.disconnected ? ' is-down' : ''}`}>
                  {channel.disconnected ? <WifiOff size={14} /> : <Wifi size={14} />}
                  <span style={{ flex: 1 }}>
                    {channel.disconnected ? 'Disconnected' : 'Connected'}
                    {channel.status ? ` · ${channel.status}` : ''}
                  </span>
                  {channel.disconnected ? (
                    <button
                      type="button"
                      className="menu-channel-fix"
                      onClick={() => {
                        setMenuOpen(false)
                        setReconnecting(true)
                      }}
                    >
                      Reconnect
                    </button>
                  ) : formatUptime(channel.uptime) ? (
                    <span className="menu-item-state">{formatUptime(channel.uptime)}</span>
                  ) : null}
                </div>

                {/* Admin-only, and the only route to team management now that
                    the mobile bottom nav is gone. */}
                {isAdmin ? (
                  <button
                    type="button"
                    className="menu-item"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false)
                      navigate('/team')
                    }}
                  >
                    <Users size={15} />
                    Team
                  </button>
                ) : null}

                {/* The rail is hidden on mobile, so this menu is the only way
                    to reach the audit log there. */}
                {isAdmin ? (
                  <button
                    type="button"
                    className="menu-item"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false)
                      navigate('/attention-log')
                    }}
                  >
                    <ShieldCheck size={15} />
                    Attention audit log
                  </button>
                ) : null}

                {isAdmin ? (
                  <button
                    type="button"
                    className="menu-item"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false)
                      navigate('/sync')
                    }}
                  >
                    <RefreshCw size={15} />
                    Sync missed messages
                  </button>
                ) : null}

                {isAdmin ? (
                  <button
                    type="button"
                    className="menu-item"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false)
                      navigate('/settings')
                    }}
                  >
                    <SettingsIcon size={15} />
                    Accounts &amp; settings
                  </button>
                ) : null}

                <button
                  type="button"
                  className="menu-item"
                  role="menuitem"
                  onClick={() => {
                    // Unmuting counts as the interaction that unblocks Web Audio.
                    armAudio()
                    toggleSound()
                  }}
                >
                  {soundOn ? <Volume2 size={15} /> : <VolumeX size={15} />}
                  <span style={{ flex: 1 }}>Sound</span>
                  <span className="menu-item-state">{soundOn ? 'On' : 'Off'}</span>
                </button>

                <button
                  type="button"
                  className="menu-item"
                  role="menuitem"
                  onClick={toggleTheme}
                >
                  {isDark ? <Sun size={15} /> : <Moon size={15} />}
                  <span style={{ flex: 1 }}>Theme</span>
                  <span className="menu-item-state">{isDark ? 'Dark' : 'Light'}</span>
                </button>

                <button
                  type="button"
                  className="menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    setChangingPassword(true)
                  }}
                >
                  <KeyRound size={15} />
                  Change password
                </button>

                <AccountMenuExtras
                  onAction={() => setMenuOpen(false)}
                  onOpenDiagnostics={() => setShowDiagnostics(true)}
                />

                <button
                  type="button"
                  className="menu-item menu-item-danger"
                  role="menuitem"
                  onClick={logout}
                >
                  <LogOut size={15} />
                  Sign out
                </button>
              </div>
            ) : null}
          </div>
        </header>

        <Outlet />
      </div>

      {changingPassword ? (
        <ChangePasswordModal onClose={() => setChangingPassword(false)} />
      ) : null}

      {reconnecting ? <ReconnectModal onClose={() => setReconnecting(false)} /> : null}

      {askingAi ? (
        <PortalAssistant
          onClose={() => setAskingAi(false)}
          onOpenChat={(id) => {
            setAskingAi(false)
            // On the Inbox page, open it in place; anywhere else, route there
            // and let the ?chat= restore open it.
            if (!openConversation(id)) navigate(`/inbox?chat=${id}`)
          }}
        />
      ) : null}

      {showDiagnostics ? (
        <PushDiagnostics onClose={() => setShowDiagnostics(false)} />
      ) : null}
    </div>
  )
}
