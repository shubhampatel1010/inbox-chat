import { useCallback, useEffect, useRef, useState } from 'react'
import {
  X, ArrowLeft, Image as ImageIcon, FileText, LinkIcon,
  Users, Shield, RefreshCw, Download, Film, ExternalLink, User,
} from 'lucide-react'
import { api } from '../lib/api.js'
import {
  displayName, formatNumber, avatarIndex, initials, formatBytes,
} from '../lib/format.js'
import { useSignedUrl } from '../lib/mediaUrl.js'
import { contactTypeLabel, countryLabel } from '../../functions/_lib/contactMeta.js'
import ContactAvatar from './ContactAvatar.jsx'
import Lightbox from './Lightbox.jsx'

const TABS = [
  { key: 'media', label: 'Media', Icon: ImageIcon },
  { key: 'docs', label: 'Docs', Icon: FileText },
  { key: 'links', label: 'Links', Icon: LinkIcon },
]

/** "2026-07-21T…" -> "3 minutes ago" */
function relativeAge(iso) {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return null
  const mins = Math.round((Date.now() - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/** Short date for a media/link row, e.g. "12 Mar 2026". */
function shortDate(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * Contact / group info panel with shared media.
 *
 * Full-screen on mobile (own back control), a right-hand drawer on desktop.
 * The three tabs each own their own paginated fetch; switching tabs the first
 * time loads that tab, and revisiting shows what was already loaded.
 */
export default function ContactPanel({ conversation, onClose, onJumpToMessage }) {
  const isGroup = Boolean(conversation.is_group)
  const [tab, setTab] = useState('media')
  const [lightbox, setLightbox] = useState(null)

  return (
    <div className="contact-panel" role="dialog" aria-modal="true" aria-label="Conversation info">
      <header className="contact-panel-head">
        <button
          type="button"
          className="icon-btn contact-panel-back"
          aria-label="Back to conversation"
          onClick={onClose}
        >
          <ArrowLeft size={18} />
        </button>
        <span className="contact-panel-title">{isGroup ? 'Group info' : 'Contact info'}</span>
        <button
          type="button"
          className="icon-btn contact-panel-close"
          aria-label="Close"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>

      <div className="contact-panel-scroll">
        <div className="contact-hero">
          <ContactAvatar conversation={conversation} size={96} className="contact-hero-avatar" />
          <div className="contact-hero-name">{displayName(conversation)}</div>
          {isGroup ? (
            <div className="contact-hero-sub">
              {conversation.member_count
                ? `${conversation.member_count} member${conversation.member_count === 1 ? '' : 's'}`
                : 'Group'}
            </div>
          ) : conversation.customer_number ? (
            <div className="contact-hero-sub contact-hero-number">
              {formatNumber(conversation.customer_number)}
            </div>
          ) : null}
          {!isGroup && (conversation.contact_type || conversation.country_of_origin) ? (
            <div className="contact-hero-tags">
              {conversation.contact_type ? (
                <span className="contact-tag">{contactTypeLabel(conversation.contact_type)}</span>
              ) : null}
              {conversation.country_of_origin ? (
                <span className="contact-tag">{countryLabel(conversation.country_of_origin)}</span>
              ) : null}
            </div>
          ) : null}
        </div>

        {isGroup ? <MembersSection key={`members-${conversation.id}`} conversation={conversation} /> : null}

        <div className="contact-tabs" role="tablist" aria-label="Shared content">
          {TABS.map(({ key, label, Icon }) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={`contact-tab${tab === key ? ' is-active' : ''}`}
              onClick={() => setTab(key)}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </div>

        <div className="contact-tab-body">
          {/* Each tab instance is keyed so its paginated state is scoped to the
              conversation AND tab — switching either starts clean. */}
          {tab === 'media' ? (
            <MediaTab key={`media-${conversation.id}`} conversation={conversation} onOpenImage={setLightbox} />
          ) : tab === 'docs' ? (
            <DocsTab key={`docs-${conversation.id}`} conversation={conversation} />
          ) : (
            <LinksTab
              key={`links-${conversation.id}`}
              conversation={conversation}
              onJumpToMessage={onJumpToMessage}
            />
          )}
        </div>
      </div>

      <Lightbox image={lightbox} onClose={() => setLightbox(null)} />
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Members (group only) — folded in from the old standalone modal.
 * ------------------------------------------------------------------ */
// Group member lists can run long; show a short preview and expand on demand.
const MEMBER_PREVIEW_COUNT = 3

function MembersSection({ conversation }) {
  const [members, setMembers] = useState([])
  const [syncedAt, setSyncedAt] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [expanded, setExpanded] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await api.groupMembers(conversation.id)
      setMembers(data.members || [])
      setSyncedAt(data.synced_at || null)
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [conversation.id])

  useEffect(() => {
    load()
  }, [load])

  const refresh = async () => {
    setRefreshing(true)
    setError(null)
    try {
      const data = await api.refreshGroupMembers(conversation.id)
      setMembers(data.members || [])
      setSyncedAt(data.synced_at || null)
      if (data.warning) setError(data.warning)
    } catch (err) {
      setError(err.message)
    } finally {
      setRefreshing(false)
    }
  }

  const age = relativeAge(syncedAt)

  return (
    <section className="contact-section">
      <div className="contact-section-head">
        <span className="contact-section-title">
          <Users size={14} />
          {members.length ? `${members.length} member${members.length === 1 ? '' : 's'}` : 'Members'}
        </span>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={refresh}
          disabled={refreshing}
        >
          {refreshing ? <span className="spinner" /> : <RefreshCw size={13} />}
          Refresh
        </button>
      </div>

      <div className="contact-section-note">{age ? `Updated ${age}` : 'Never synced'}</div>
      {error ? <div className="alert alert-error">{error}</div> : null}

      {loading ? (
        <div className="contact-loading">
          <span className="spinner" />
        </div>
      ) : members.length === 0 ? (
        <div className="contact-empty-inline">No members recorded yet. Try refreshing.</div>
      ) : (
        <>
          <div className="member-list">
            {(expanded ? members : members.slice(0, MEMBER_PREVIEW_COUNT)).map((m) => {
              const pretty = formatNumber(m.member_number)
              // Most members carry no name from WhatsApp. Falling back to the
              // number for the name printed it twice per row and made the
              // avatar a bare '+', so an unnamed member shows the number once,
              // as its own identity. Matches the call menu.
              const name = m.member_name?.trim() || null
              return (
                <div className="member-row" key={m.id}>
                  <span className="conv-avatar member-avatar" data-color={avatarIndex(m.member_number)}>
                    {name ? initials(name) : <User size={13} />}
                  </span>
                  <span className="member-id">
                    {name ? (
                      <>
                        <span className="member-name">{name}</span>
                        <span className="member-number">{pretty}</span>
                      </>
                    ) : (
                      <span className="member-name member-name-number">{pretty}</span>
                    )}
                  </span>
                  {m.is_admin ? (
                    <span className="member-admin" title="Group admin">
                      <Shield size={11} />
                      Admin
                    </span>
                  ) : null}
                </div>
              )
            })}
          </div>
          {members.length > MEMBER_PREVIEW_COUNT ? (
            <button
              type="button"
              className="member-toggle"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? 'Show less' : `Show all (${members.length})`}
            </button>
          ) : null}
        </>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------ *
 * Shared pagination hook for the three tabs.
 * ------------------------------------------------------------------ */
function useTabPage(conversationId, tab) {
  const [items, setItems] = useState([])
  const [status, setStatus] = useState('loading') // loading | ready | error | loadingMore
  const [cursor, setCursor] = useState(null)
  const [hasMore, setHasMore] = useState(false)
  const seenRef = useRef(new Set())

  const fetchPage = useCallback(
    async (nextCursor, signal) => {
      const data = await api.conversationMedia(conversationId, tab, { cursor: nextCursor, signal })
      // De-dupe by message id: the links cursor can, in a pathological batch,
      // re-scan a boundary row. Never render one twice.
      const fresh = (data.items || []).filter((it) => {
        if (seenRef.current.has(it.message_id)) return false
        seenRef.current.add(it.message_id)
        return true
      })
      return { fresh, hasMore: Boolean(data.has_more), next: data.next_cursor }
    },
    [conversationId, tab]
  )

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    setStatus('loading')
    seenRef.current = new Set()

    fetchPage(null, controller.signal)
      .then(({ fresh, hasMore: more, next }) => {
        if (cancelled) return
        setItems(fresh)
        setHasMore(more)
        setCursor(next)
        setStatus('ready')
      })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError' || err.status === 401) return
        setStatus('error')
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [fetchPage])

  const loadMore = useCallback(async () => {
    if (!hasMore || !cursor) return
    setStatus('loadingMore')
    try {
      const { fresh, hasMore: more, next } = await fetchPage(cursor)
      setItems((prev) => [...prev, ...fresh])
      setHasMore(more)
      setCursor(next)
      setStatus('ready')
    } catch (err) {
      if (err.name === 'AbortError' || err.status === 401) return
      setStatus('error')
    }
  }, [cursor, hasMore, fetchPage])

  return { items, status, hasMore, loadMore }
}

/** Shared "load more" footer + loading / error / empty states. */
function TabState({ status, hasMore, loadMore, empty, emptyIcon: Icon }) {
  if (status === 'loading') {
    return (
      <div className="contact-loading">
        <span className="spinner" />
      </div>
    )
  }
  if (status === 'error') {
    return <div className="contact-empty">Could not load this tab.</div>
  }
  return (
    <>
      {hasMore ? (
        <button
          type="button"
          className="btn btn-secondary btn-sm contact-more"
          onClick={loadMore}
          disabled={status === 'loadingMore'}
        >
          {status === 'loadingMore' ? <span className="spinner" /> : null}
          Load more
        </button>
      ) : null}
    </>
  )
}

function EmptyTab({ Icon, children }) {
  return (
    <div className="contact-empty">
      <Icon size={26} />
      <span>{children}</span>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Media tab — image / video thumbnail grid.
 * ------------------------------------------------------------------ */
function MediaTab({ conversation, onOpenImage }) {
  const { items, status, hasMore, loadMore } = useTabPage(conversation.id, 'media')

  if (status === 'ready' && items.length === 0) {
    return <EmptyTab Icon={ImageIcon}>No photos or videos yet.</EmptyTab>
  }
  if (status === 'loading') {
    return (
      <div className="contact-loading">
        <span className="spinner" />
      </div>
    )
  }

  return (
    <>
      <div className="media-grid">
        {items.map((m) => (
          <MediaTile key={m.message_id} item={m} onOpenImage={onOpenImage} />
        ))}
      </div>
      <TabState status={status} hasMore={hasMore} loadMore={loadMore} />
    </>
  )
}

function MediaTile({ item, onOpenImage }) {
  const { url } = useSignedUrl(item.media_path)
  const isVideo = item.media_type === 'video'
  const name = item.media_filename || (isVideo ? 'Video' : 'Photo')

  return (
    <button
      type="button"
      className="media-tile"
      onClick={() => url && onOpenImage({ url, name })}
      aria-label={`Open ${name}`}
      disabled={!url}
    >
      {url ? (
        <img className="media-tile-img" src={url} alt={item.media_caption || name} loading="lazy" />
      ) : (
        <span className="media-tile-skeleton" aria-hidden="true" />
      )}
      {isVideo ? (
        <span className="media-tile-badge" aria-hidden="true">
          <Film size={14} />
        </span>
      ) : null}
    </button>
  )
}

/* ------------------------------------------------------------------ *
 * Docs tab.
 * ------------------------------------------------------------------ */
function DocsTab({ conversation }) {
  const { items, status, hasMore, loadMore } = useTabPage(conversation.id, 'docs')

  if (status === 'ready' && items.length === 0) {
    return <EmptyTab Icon={FileText}>No documents yet.</EmptyTab>
  }
  if (status === 'loading') {
    return (
      <div className="contact-loading">
        <span className="spinner" />
      </div>
    )
  }

  return (
    <>
      <div className="doc-list">
        {items.map((m) => (
          <DocRow key={m.message_id} item={m} />
        ))}
      </div>
      <TabState status={status} hasMore={hasMore} loadMore={loadMore} />
    </>
  )
}

function DocRow({ item }) {
  const { url } = useSignedUrl(item.media_path)
  const name = item.media_filename || 'Document'
  return (
    <a
      className="doc-row"
      href={url || undefined}
      download={name}
      target="_blank"
      rel="noreferrer"
      aria-disabled={!url}
    >
      <span className="doc-row-icon">
        <FileText size={18} />
      </span>
      <span className="doc-row-body">
        <span className="doc-row-name">{name}</span>
        <span className="doc-row-meta">
          {[formatBytes(item.media_size), item.sender_name, shortDate(item.created_at)]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
      <span className="doc-row-dl">
        <Download size={16} />
      </span>
    </a>
  )
}

/* ------------------------------------------------------------------ *
 * Links tab.
 * ------------------------------------------------------------------ */
function LinksTab({ conversation, onJumpToMessage }) {
  const { items, status, hasMore, loadMore } = useTabPage(conversation.id, 'links')

  if (status === 'ready' && items.length === 0) {
    return <EmptyTab Icon={LinkIcon}>No links shared yet.</EmptyTab>
  }
  if (status === 'loading') {
    return (
      <div className="contact-loading">
        <span className="spinner" />
      </div>
    )
  }

  return (
    <>
      <div className="link-list">
        {items.map((m) =>
          m.urls.map((u, i) => (
            <div className="link-row" key={`${m.message_id}-${i}`}>
              <a className="link-row-url" href={u} target="_blank" rel="noreferrer noopener">
                <ExternalLink size={14} />
                <span className="link-row-href">{u}</span>
              </a>
              {/* The message text is the context; tapping it jumps to the
                  message in the thread via the existing anchor loading. */}
              <button
                type="button"
                className="link-row-context"
                onClick={() => onJumpToMessage(m.message_id)}
                title="Go to this message"
              >
                <span className="link-row-text">{m.text}</span>
                <span className="link-row-date">
                  {m.sender_name ? `${m.sender_name} · ` : ''}
                  {shortDate(m.created_at)}
                </span>
              </button>
            </div>
          ))
        )}
      </div>
      <TabState status={status} hasMore={hasMore} loadMore={loadMore} />
    </>
  )
}
