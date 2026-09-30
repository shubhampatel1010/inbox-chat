import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AlertCircle, Clock, Check, Reply } from 'lucide-react'
import {
  clockTime,
  dayKey,
  dayLabel,
  displayName,
  initials,
  avatarIndex,
} from '../lib/format.js'
import MediaAttachment from './MediaAttachment.jsx'
import Lightbox from './Lightbox.jsx'
import QuotedMessage from './QuotedMessage.jsx'
import { splitMatches } from '../lib/thread.js'

/**
 * Consecutive messages from the same sender form a "run": they get tight
 * spacing, and only the last one shows an avatar.
 */
const runKey = (message) =>
  message.direction === 'inbound'
    // In a group, each participant is their own run — otherwise two people in
    // a row would share one avatar and one sender label.
    ? `in:${message.sender_number || ''}`
    : `out:${message.sent_by || ''}`

/** Distance from either end at which the next page starts loading. */
const LOAD_THRESHOLD_PX = 300

/** How long a jumped-to message stays highlighted. Matches the CSS animation. */
const FLASH_MS = 2200

/** Hold duration that turns a touch into a context-menu request. */
const LONG_PRESS_MS = 450

/**
 * How far a finger may drift during a hold and still count as a press rather
 * than a scroll. Generous enough to tolerate a resting thumb's wobble.
 */
const LONG_PRESS_SLOP_PX = 10

/** Rightward travel that commits a swipe-to-reply, in px. */
const SWIPE_REPLY_PX = 60

/** Furthest the bubble follows the finger, so the row never slides off-screen. */
const SWIPE_MAX_PX = 80

/**
 * Horizontal travel needed before a drag is treated as a swipe at all, and the
 * ratio by which it must beat the vertical travel. Together these keep a
 * diagonal thumb-scroll from arming the gesture — the thread scrolls vertically,
 * so scrolling must win every ambiguous case.
 */
const SWIPE_ARM_PX = 12
const SWIPE_AXIS_RATIO = 1.5

export default function Thread({
  messages,
  loading,
  conversation,
  hasMoreBefore = false,
  hasMoreAfter = false,
  loadingMore = null,
  onLoadOlder,
  onLoadNewer,
  jumpTo = null,
  highlightQuery = '',
  searchActive = false,
  onRestoreFailed,
  selectionMode = false,
  selectedIds = null,
  onToggleSelect,
  onRequestMenu,
  onForwardMedia,
  onReply,
  onJumpToMessage,
}) {
  const isGroup = Boolean(conversation?.is_group)
  const [lightbox, setLightbox] = useState(null)
  const [flashId, setFlashId] = useState(null)
  const scrollRef = useRef(null)
  const lastIdRef = useRef(null)
  const pinnedRef = useRef(true)

  // Where the reader was when in-thread search opened, so Escape can put them
  // back. Stored as a message id plus an offset rather than a raw scrollTop:
  // stepping through matches can replace the whole loaded window, and a
  // scrollTop measured against a different set of messages means nothing.
  const savedViewRef = useRef(null)

  // Set just before an older page is requested; consumed once by the layout
  // effect below to keep the reader's viewport still while content is
  // inserted ABOVE them.
  const prependRef = useRef(null)

  // The message we have not yet scrolled to. Held in a ref rather than
  // compared in the effect body because the message only exists in the DOM
  // once the window that contains it has rendered — which, for a jump into
  // history, is a whole round trip later.
  const pendingJumpRef = useRef(null)

  // In-flight long press: the timer, where the finger went down, and whether
  // it has already fired. Kept in a ref because none of it should re-render.
  const pressRef = useRef(null)

  // Live swipe-to-reply offset, {id, dx}. This one IS state: the bubble has to
  // follow the finger. The distance touchend tests against the threshold is
  // read from pressRef, not from here — a state value could still be one render
  // behind the final touchmove at the moment the finger lifts.
  const [swipe, setSwipe] = useState(null)

  const cancelPress = () => {
    if (pressRef.current?.timer) clearTimeout(pressRef.current.timer)
    pressRef.current = null
  }

  // Cancel on unmount so a pending timer can never fire a menu for a thread
  // that is no longer on screen.
  useEffect(() => cancelPress, [])

  const startPress = (event, message) => {
    // Secondary touches (a second finger, a pinch) are not a long press.
    if (event.touches?.length !== 1) return cancelPress()
    const touch = event.touches[0]

    pressRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      message,
      fired: false,
      // Set once the drag is unambiguously horizontal; from then on the press
      // is a swipe and the long-press timer has already been cancelled.
      swiping: false,
      // Latest horizontal travel, updated synchronously by movePress.
      dx: 0,
      timer: setTimeout(() => {
        if (!pressRef.current) return
        pressRef.current.fired = true
        onRequestMenu?.({ x: touch.clientX, y: touch.clientY, message })
      }, LONG_PRESS_MS),
    }
  }

  const movePress = (event) => {
    const press = pressRef.current
    if (!press || press.fired) return
    const touch = event.touches?.[0]
    if (!touch) return

    const dx = touch.clientX - press.x
    const dy = touch.clientY - press.y

    // Arm the swipe on a clearly-horizontal rightward drag. Leftward is left
    // alone: it belongs to the edge-swipe-back gesture.
    if (
      !press.swiping &&
      onReply &&
      dx > SWIPE_ARM_PX &&
      dx > Math.abs(dy) * SWIPE_AXIS_RATIO
    ) {
      press.swiping = true
      // The hold is now a drag, so the menu must not fire underneath it.
      if (press.timer) clearTimeout(press.timer)
      press.timer = null
    }

    if (press.swiping) {
      // Resisted past the commit point: the bubble keeps moving, but slowly,
      // so there is a felt "catch" at the threshold rather than a silent one.
      const eased =
        dx <= SWIPE_REPLY_PX ? dx : SWIPE_REPLY_PX + (dx - SWIPE_REPLY_PX) * 0.3
      // Raw travel, not the eased offset: the threshold is about how far the
      // finger moved, while the easing is only how far the bubble follows.
      press.dx = dx
      setSwipe({ id: press.message.id, dx: Math.min(eased, SWIPE_MAX_PX) })
      return
    }

    // Drifted far enough to be a scroll — abandon the press so the thread
    // scrolls normally instead of opening a menu under the moving finger.
    if (
      Math.abs(dx) > LONG_PRESS_SLOP_PX ||
      Math.abs(dy) > LONG_PRESS_SLOP_PX
    ) {
      cancelPress()
    }
  }

  const endPress = (event) => {
    const press = pressRef.current

    if (press?.swiping) {
      // Committed only past the threshold; a short swipe springs back and does
      // nothing, which is what makes the gesture safe to explore.
      if ((press.dx ?? 0) >= SWIPE_REPLY_PX) onReply?.(press.message)
      setSwipe(null)
      cancelPress()
      return
    }

    // The menu already opened, so the lifting finger must not also register as
    // a tap on the message underneath.
    if (press?.fired) event.preventDefault()
    cancelPress()
  }

  /**
   * Offset of a message within the scroll content.
   *
   * Measured from bounding rects rather than offsetTop, which is relative to
   * the nearest positioned ancestor and would be wrong the moment anything
   * between here and the message gains `position: relative`.
   */
  const offsetOf = (node) => {
    const el = scrollRef.current
    return node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
  }

  /** The topmost message currently in view, and how far below the fold it sits. */
  const captureView = () => {
    const el = scrollRef.current
    if (!el) return null
    for (const node of el.querySelectorAll('[data-message-id]')) {
      const top = offsetOf(node)
      if (top + node.offsetHeight > el.scrollTop) {
        return { id: node.dataset.messageId, offset: top - el.scrollTop }
      }
    }
    return null
  }

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return

    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight

    // "Pinned" now requires being at the live edge as well as at the bottom of
    // the loaded window. Without the hasMoreAfter test, opening an old search
    // result whose window happens to be short would look pinned, and the next
    // poll would scroll the reader away from the message they jumped to.
    pinnedRef.current = !hasMoreAfter && fromBottom < 90

    if (loadingMore) return

    if (hasMoreBefore && el.scrollTop < LOAD_THRESHOLD_PX && onLoadOlder) {
      prependRef.current = { height: el.scrollHeight, top: el.scrollTop }
      onLoadOlder()
    } else if (hasMoreAfter && fromBottom < LOAD_THRESHOLD_PX && onLoadNewer) {
      onLoadNewer()
    }
  }

  // Keyed on the nonce, not the id: stepping onto the same match twice, or
  // pressing next until it wraps back around, is still a fresh jump request.
  useEffect(() => {
    if (!jumpTo) return
    pendingJumpRef.current = jumpTo.id
    // Clear any previous flash immediately so two jumps in a row can't leave
    // two messages lit at once.
    setFlashId(null)
  }, [jumpTo?.nonce])

  // Remember the reading position on the way into search, restore it on the
  // way out. Both halves live here because only this component knows where the
  // scroller actually is.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    if (searchActive) {
      // Only on the way in — re-capturing mid-search would save a position the
      // reader never chose.
      if (!savedViewRef.current) savedViewRef.current = captureView()
      return
    }

    const saved = savedViewRef.current
    if (!saved) return
    savedViewRef.current = null
    pendingJumpRef.current = null
    setFlashId(null)

    const node = el.querySelector(`[data-message-id="${saved.id}"]`)
    if (node) {
      el.scrollTop = Math.max(0, offsetOf(node) - saved.offset)
    } else {
      // Stepping through matches walked the window away from where they
      // started, so there is nothing here to scroll back to. Inbox reloads the
      // tail instead, which is the honest fallback.
      onRestoreFailed?.()
    }
  }, [searchActive])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || !messages.length) return

    // 1. Older page just landed: hold the viewport still. Must come first —
    //    it is the only case where scrollTop must NOT move.
    const prepend = prependRef.current
    if (prepend) {
      prependRef.current = null
      el.scrollTop = el.scrollHeight - prepend.height + prepend.top
      lastIdRef.current = messages[messages.length - 1].id
      return
    }

    // 2. A jump target is present in the DOM: centre it.
    const jump = pendingJumpRef.current
    if (jump != null) {
      const node = el.querySelector(`[data-message-id="${jump}"]`)
      if (node) {
        pendingJumpRef.current = null
        // Centred rather than scrollIntoView's default, so the messages either
        // side of the hit are visible — the context is the reason for jumping.
        const target = offsetOf(node) - el.clientHeight / 2 + node.offsetHeight / 2
        el.scrollTop = Math.max(0, target)
        lastIdRef.current = messages[messages.length - 1].id
        setFlashId(jump)
        return
      }
      // Not rendered yet — leave it pending and fall through, so a normal
      // bottom-anchor does not fight the jump on the next render.
      return
    }

    // 3. Ordinary behaviour, unchanged: stick to the bottom on first paint and
    //    on new messages, but only if the reader was already there.
    const newestId = messages[messages.length - 1].id
    const changed = newestId !== lastIdRef.current
    const firstRender = lastIdRef.current === null
    lastIdRef.current = newestId

    if (firstRender || (changed && pinnedRef.current)) {
      el.scrollTop = el.scrollHeight
    }
    // The nonce matters as much as `messages`: stepping to a match already in
    // the loaded window changes nothing about the message array, so without it
    // this effect would never run and the thread would not move.
  }, [messages, jumpTo?.nonce])

  // The flash is a brief cue, not a marker — it clears itself.
  useEffect(() => {
    if (flashId == null) return undefined
    const timer = setTimeout(() => setFlashId(null), FLASH_MS)
    return () => clearTimeout(timer)
  }, [flashId])

  // Reset every piece of per-thread scroll state when we switch threads.
  // A saved view or a pending jump that outlived its conversation would apply
  // itself to the next one.
  useEffect(() => {
    pinnedRef.current = true
    lastIdRef.current = null
    prependRef.current = null
    savedViewRef.current = null
    pendingJumpRef.current = null
    setSwipe(null)
  }, [conversation?.id])

  // Shown while a thread loads. Because Inbox only hands over messages that
  // belong to the selected conversation, this can never be masked by stale
  // content from the previous one.
  if (loading && !messages.length) {
    return (
      <div className="thread-scroll" aria-busy="true" aria-label="Loading messages">
        <div className="msg-list">
          {[
            { out: false, w: 42 },
            { out: false, w: 68 },
            { out: true, w: 55 },
            { out: false, w: 34 },
            { out: true, w: 62 },
            { out: true, w: 40 },
          ].map((row, i) => (
            <div className={`msg-row ${row.out ? 'out' : 'in'}`} key={i}>
              {!row.out ? <span className="msg-spacer" /> : null}
              <div className="bubble-skeleton" style={{ width: `${row.w}%` }} />
              {row.out ? <span className="msg-spacer" /> : null}
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (!messages.length) {
    return (
      <div className="thread-scroll">
        <div className="empty">
          <div className="empty-title">No messages yet</div>
          <div className="empty-sub">Send the first message to start this conversation.</div>
        </div>
      </div>
    )
  }

  const contactName = displayName(conversation)
  let previousDay = null

  return (
    <div className="thread-scroll" ref={scrollRef} onScroll={onScroll}>
      <div className="msg-list">
        {/* Sits inside .msg-list so it participates in the same flex-end
            packing — an absolutely positioned spinner would overlap the first
            bubble on a short thread. */}
        {hasMoreBefore ? (
          <div className="page-status" role="status">
            {loadingMore === 'before' ? (
              <>
                <span className="spinner" aria-hidden="true" />
                Loading earlier messages…
              </>
            ) : (
              'Scroll up for earlier messages'
            )}
          </div>
        ) : null}

        {messages.map((message, index) => {
          const isOut = message.direction === 'outbound'
          const failed = message.status === 'send_failed'
          const queued = message.status === 'queued'

          const hasMedia = Boolean(
            message.media_path || message.media_error || message.media_type
          )
          const caption = message.body || message.media_caption || ''
          const mediaOnly = hasMedia && !caption
          const isImage = hasMedia && message.media_type === 'image' && !message.media_error

          const key = dayKey(message.created_at)
          const showDay = key && key !== previousDay
          previousDay = key

          // A day separator also starts a fresh run.
          const previous = messages[index - 1]
          const next = messages[index + 1]
          const isRunStart = showDay || !previous || runKey(previous) !== runKey(message)
          const isRunEnd =
            !next ||
            runKey(next) !== runKey(message) ||
            (dayKey(next.created_at) && dayKey(next.created_at) !== key)

          // In a group the inbound party is the individual sender, not the chat.
          const senderLabel = message.sender_name || (message.sender_number ? `+${message.sender_number}` : null)
          const who = isOut ? message.sent_by || 'You' : (isGroup && senderLabel) || contactName

          const meta = (
            <span className="bubble-meta">
              {clockTime(message.created_at)}
              {queued ? <Clock size={11} aria-label="Queued" /> : null}
              {failed ? <AlertCircle size={11} aria-label="Failed to send" /> : null}
            </span>
          )

          const avatar = isRunEnd ? (
            <span className="msg-avatar" title={who} aria-label={who}>
              {initials(who)}
            </span>
          ) : (
            <span className="msg-spacer" aria-hidden="true" />
          )

          const isSelected = Boolean(selectedIds?.has(message.id))

          return (
            <div
              key={message.id}
              data-message-id={message.id}
              className={message.id === flashId ? 'msg-flash' : undefined}
            >
              {showDay ? (
                <div className="day-sep">
                  <span>{dayLabel(message.created_at)}</span>
                </div>
              ) : null}

              <div
                className={`msg-row ${isOut ? 'out' : 'in'}${isRunStart ? ' run-start' : ''}${
                  selectionMode ? ' is-selectable' : ''
                }${isSelected ? ' is-selected' : ''}`}
                onContextMenu={(e) => {
                  if (selectionMode) return
                  e.preventDefault()
                  onRequestMenu?.({ x: e.clientX, y: e.clientY, message })
                }}
                onTouchStart={(e) => (selectionMode ? undefined : startPress(e, message))}
                onTouchMove={movePress}
                onTouchEnd={endPress}
                // An interrupted touch (a call, the app backgrounding) must
                // spring the bubble back, not strand it mid-swipe.
                onTouchCancel={() => {
                  setSwipe(null)
                  cancelPress()
                }}
                // In selection mode the whole row is the hit target — tapping
                // anywhere toggles, matching how WhatsApp behaves. The real
                // checkbox below is the accessible control; this is a
                // convenience for pointers, so it is deliberately not a second
                // tab stop announcing the same message twice.
                onClick={selectionMode ? () => onToggleSelect?.(message.id) : undefined}
                role={selectionMode ? 'presentation' : undefined}
              >
                {selectionMode ? (
                  <label className={`sel-box${isSelected ? ' is-on' : ''}`}>
                    <input
                      type="checkbox"
                      className="sel-box-input"
                      checked={isSelected}
                      aria-label={`Select message from ${who}`}
                      // The row's onClick already toggles; without this the
                      // event would bubble up to it and toggle a second time.
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => onToggleSelect?.(message.id)}
                    />
                    {isSelected ? <Check size={14} strokeWidth={3} aria-hidden="true" /> : null}
                  </label>
                ) : null}

                {!isOut ? avatar : null}

                <div
                  className={`bubble ${isOut ? 'bubble-out' : 'bubble-in'}${
                    failed ? ' bubble-failed' : ''
                  }${hasMedia ? ' has-media' : ''}${mediaOnly ? ' is-media-only' : ''}${
                    isRunStart ? ' has-tail' : ''
                  }`}
                  style={
                    swipe?.id === message.id
                      ? { transform: `translateX(${swipe.dx}px)` }
                      : undefined
                  }
                >
                  {/* Sits inside the bubble so it travels with the swipe and
                      inherits the bubble's own max-width. */}
                  {message.quoted ? (
                    <QuotedMessage
                      quoted={message.quoted}
                      conversation={conversation}
                      onJump={message.quoted.found ? onJumpToMessage : null}
                    />
                  ) : null}

                  {/* Sender label: groups only, inbound only, and only on the
                      first message of a run — the same rule the avatars use.
                      Inside the bubble so it cannot disturb the row's flex
                      layout or the 65% bubble measure. */}
                  {isGroup && !isOut && isRunStart && senderLabel ? (
                    <span
                      className="msg-sender"
                      data-agent={avatarIndex(message.sender_number)}
                    >
                      {senderLabel}
                    </span>
                  ) : null}

                  {hasMedia ? (
                    <MediaAttachment
                      message={message}
                      onOpenImage={setLightbox}
                      /* Uncaptioned media carries the stamp itself — overlaid
                         on an image, inline on a chip — so it never costs a
                         whole extra row. */
                      stamp={mediaOnly ? meta : null}
                      /* Shortcut straight to the picker for this one file.
                         Hidden during selection mode, where the row's own
                         checkbox is the interaction. */
                      onForward={
                        selectionMode || !onForwardMedia
                          ? null
                          : () => onForwardMedia(message.id)
                      }
                    />
                  ) : null}

                  {caption ? (
                    <div className="bubble-text">
                      {/* Every occurrence in the loaded window gets a standing
                          highlight, so it is visible WHICH messages matched.
                          The current one is marked separately, by the flash. */}
                      {highlightQuery
                        ? splitMatches(caption, highlightQuery).map((part, i) =>
                            part.match ? (
                              <mark className="msg-match" key={i}>
                                {part.text}
                              </mark>
                            ) : (
                              part.text
                            )
                          )
                        : caption}
                      {meta}
                    </div>
                  ) : null}


                </div>

                {/* Desktop affordance — revealed on row hover by CSS. The
                    mobile equivalent is the swipe, and the context menu covers
                    both. Hidden during selection mode, where the row's click
                    belongs to the checkbox. */}
                {onReply && !selectionMode ? (
                  <button
                    type="button"
                    className="msg-reply-btn desktop-only"
                    aria-label={`Reply to ${who}`}
                    title="Reply"
                    onClick={(e) => {
                      e.stopPropagation()
                      onReply(message)
                    }}
                  >
                    <Reply size={15} />
                  </button>
                ) : null}

                {isOut ? avatar : null}
              </div>

              {/* Agent attribution under an outbound run — the text counterpart
                  to the outbound initials avatar, on the SAME run-end rule so it
                  is not repeated on every consecutive message. Never shown when
                  sent_by is null (a message sent from the WhatsApp app): the
                  avatar already renders the generic "You" for that case. */}
              {isOut && isRunEnd && message.sent_by ? (
                <div className="msg-out-sender">{message.sent_by}</div>
              ) : null}
            </div>
          )
        })}

        {/* Only ever visible after a jump into history. Once this clears, the
            window has reached the newest message and polling resumes. */}
        {hasMoreAfter ? (
          <div className="page-status" role="status">
            {loadingMore === 'after' ? (
              <>
                <span className="spinner" aria-hidden="true" />
                Loading newer messages…
              </>
            ) : (
              'Scroll down for newer messages'
            )}
          </div>
        ) : null}
      </div>

      <Lightbox image={lightbox} onClose={() => setLightbox(null)} />
    </div>
  )
}
