import { useCallback, useEffect, useState } from 'react'
import { Navigate, Link } from 'react-router-dom'
import { ArrowLeft, ShieldCheck } from 'lucide-react'
import { api } from '../lib/api.js'
import { useAuth } from '../context/AuthContext.jsx'
import { useToast } from '../context/ToastContext.jsx'
import { REASON_CATEGORIES } from '../lib/attentionReasons.js'
import AttentionEventList from '../components/AttentionEventList.jsx'

const PAGE_SIZE = 50

const EMPTY_FILTERS = { actor_user_id: '', category: '', action: '', since: '', until: '' }

/**
 * Admin-only closure audit log.
 *
 * The management-visibility half of the accountability feature: every attention
 * flag that was closed, by whom, when, and with what stated reason. Without this
 * the reasons dismiss-attention records would be write-only.
 *
 * Paging is "load more" rather than numbered pages — an audit trail is read
 * newest-first and scanned, never navigated to page 7 of.
 */
export default function AttentionLog() {
  const { isAdmin } = useAuth()
  const toast = useToast()

  const [events, setEvents] = useState([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [users, setUsers] = useState([])

  // `filters` is what the inputs are bound to; `applied` is what was last sent.
  // Keeping them apart is what lets the date fields be typed into without
  // firing a request per keystroke — nothing moves until Apply.
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [applied, setApplied] = useState(EMPTY_FILTERS)

  const load = useCallback(
    async (activeFilters, offset = 0) => {
      const first = offset === 0
      if (first) setLoading(true)
      else setLoadingMore(true)

      try {
        const data = await api.attentionEvents({
          ...activeFilters,
          // The date inputs give a bare day. `until` is exclusive server-side,
          // so it is pushed to the START of the next day — otherwise choosing
          // the same day for both bounds would return nothing, and picking
          // "until today" would silently drop today's own events.
          until: activeFilters.until ? nextDay(activeFilters.until) : '',
          limit: PAGE_SIZE,
          offset,
        })
        const incoming = data.events || []
        setEvents((current) => (first ? incoming : [...current, ...incoming]))
        setHasMore(Boolean(data.has_more))
      } catch (err) {
        if (err.status !== 401) toast.error('Could not load the audit log', err.message)
      } finally {
        setLoading(false)
        setLoadingMore(false)
      }
    },
    [toast]
  )

  useEffect(() => {
    load(applied, 0)
  }, [load, applied])

  // The agent filter's roster. Failure is silent: the log itself is the point,
  // and losing one dropdown should not present as the page being broken.
  useEffect(() => {
    let cancelled = false
    api
      .users()
      .then((data) => {
        if (!cancelled) setUsers(data.users || [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // Agents never reach this page — the endpoint enforces it too.
  if (!isAdmin) return <Navigate to="/inbox" replace />

  const set = (key) => (e) => setFilters((f) => ({ ...f, [key]: e.target.value }))

  const apply = (e) => {
    e.preventDefault()
    setApplied(filters)
  }

  const clear = () => {
    setFilters(EMPTY_FILTERS)
    setApplied(EMPTY_FILTERS)
  }

  const dirty = JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS)

  return (
    <div className="page-scroll">
      <div className="page-inner">
        <Link to="/inbox" className="btn btn-secondary btn-sm page-back">
          <ArrowLeft size={14} />
          Back to inbox
        </Link>

        <section className="card">
          <div className="card-head">
            <ShieldCheck size={17} style={{ color: 'var(--text-2)' }} />
            <h2 className="card-title">Attention audit log</h2>
          </div>

          <p className="attn-log-intro">
            Every attention flag that was closed, and the reason given. Records are
            permanent — closing a flag adds an entry, and undoing one adds another
            rather than removing it.
          </p>

          <form className="attn-log-filters" onSubmit={apply}>
            <div className="field">
              <label className="label" htmlFor="flt-agent">Agent</label>
              <select
                id="flt-agent"
                className="select"
                value={filters.actor_user_id}
                onChange={set('actor_user_id')}
              >
                <option value="">Everyone</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="label" htmlFor="flt-reason">Reason</label>
              <select
                id="flt-reason"
                className="select"
                value={filters.category}
                onChange={set('category')}
              >
                <option value="">Any reason</option>
                {REASON_CATEGORIES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="label" htmlFor="flt-action">Action</label>
              <select
                id="flt-action"
                className="select"
                value={filters.action}
                onChange={set('action')}
              >
                <option value="">All</option>
                <option value="dismissed">Closed</option>
                <option value="restored">Re-opened</option>
              </select>
            </div>

            <div className="field">
              <label className="label" htmlFor="flt-since">From</label>
              <input
                id="flt-since"
                className="input"
                type="date"
                value={filters.since}
                onChange={set('since')}
              />
            </div>

            <div className="field">
              <label className="label" htmlFor="flt-until">To</label>
              <input
                id="flt-until"
                className="input"
                type="date"
                value={filters.until}
                onChange={set('until')}
              />
            </div>

            <div className="attn-log-filter-actions">
              <button type="submit" className="btn btn-primary btn-sm">
                Apply
              </button>
              {dirty ? (
                <button type="button" className="btn btn-secondary btn-sm" onClick={clear}>
                  Clear
                </button>
              ) : null}
            </div>
          </form>

          {loading ? (
            <div className="card-body">
              <span className="spinner" style={{ color: 'var(--text-3)' }} />
            </div>
          ) : (
            <>
              <AttentionEventList events={events} showConversation />
              {hasMore ? (
                <div className="attn-log-more">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={loadingMore}
                    onClick={() => load(applied, events.length)}
                  >
                    {loadingMore ? <span className="spinner" /> : null}
                    Load more
                  </button>
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>
    </div>
  )
}

/**
 * The day after `yyyy-mm-dd`, as the same bare-day string.
 *
 * Built from UTC parts rather than `new Date(str)` + setDate: parsing a bare
 * day gives UTC midnight, and formatting it back through a local getter shifts
 * the date by one in any negative-offset timezone. Date.UTC keeps both ends in
 * the same frame, so month and year ends roll over correctly.
 */
function nextDay(day) {
  const [y, m, d] = String(day).split('-').map(Number)
  if (!y || !m || !d) return ''
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}
