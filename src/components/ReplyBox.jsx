import { useEffect, useRef, useState } from 'react'
import { Send, Paperclip, X, FileText, AlertCircle } from 'lucide-react'
import { api, ApiError } from '../lib/api.js'
import { formatBytes } from '../lib/format.js'
import ReplyPreview from './ReplyPreview.jsx'

const MAX_BYTES = 16 * 1024 * 1024

const ACCEPT = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv',
  // Uploadable, but still rendered as chips — no players.
  'video/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/mp4',
  'audio/webm',
].join(',')

export default function ReplyBox({
  conversationId,
  onSend,
  disabled,
  isGroup = false,
  replyTo = null,
  onCancelReply,
  // Supplies the customer's name for a quote of an inbound 1:1 message, which
  // carries no sender fields of its own.
  conversation = null,
  // Receives the queue-files function so the thread's drop zone can hand files
  // to the SAME validation and upload path the paperclip uses.
  onReady,
}) {
  const [value, setValue] = useState('')
  const [sending, setSending] = useState(false)
  // A queue, not one file: a drop can carry several. The API takes one media
  // object per message, so N files become N messages — the same thing WhatsApp
  // does, and it keeps /api/send and /api/upload untouched.
  const [attachments, setAttachments] = useState([]) // [{file, previewUrl, isImage}]
  const [error, setError] = useState(null)
  // Which file of the queue is currently uploading, for the progress label.
  const [progress, setProgress] = useState(null) // {done, total}
  const textareaRef = useRef(null)
  const fileRef = useRef(null)
  // How many of the queue went out before a failure, so the catch can trim the
  // queue to only what still needs sending.
  const sentCountRef = useRef(0)

  // Auto-grow from 1 row up to 5, then scroll. Measured from the element's own
  // computed line-height so it tracks the 14px/16px responsive font sizing.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return

    const styles = window.getComputedStyle(el)
    const lineHeight = parseFloat(styles.lineHeight) || 20
    const chrome =
      parseFloat(styles.paddingTop) +
      parseFloat(styles.paddingBottom) +
      parseFloat(styles.borderTopWidth) +
      parseFloat(styles.borderBottomWidth)

    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, lineHeight * 5 + chrome)}px`
  }, [value])

  // Revoke object URLs when the queue changes or unmounts. Keyed on the URLs
  // themselves so removing one file does not revoke the others' previews.
  useEffect(() => {
    const urls = attachments.map((a) => a.previewUrl).filter(Boolean)
    return () => {
      for (const url of urls) URL.revokeObjectURL(url)
    }
  }, [attachments])

  // Switching conversations must not carry attachments across.
  useEffect(() => {
    setAttachments([])
    setError(null)
    setValue('')
  }, [conversationId])

  // Picking a message to reply to puts the cursor in the composer — the user's
  // next action is always typing, and on mobile this is what raises the
  // keyboard without a second tap.
  useEffect(() => {
    if (replyTo) textareaRef.current?.focus()
  }, [replyTo?.id])

  // Publish the attach handler upward. Kept in a ref by the parent, so a drop
  // reuses this component's validation rather than duplicating the rules —
  // the two must never disagree about what is attachable.
  useEffect(() => {
    onReady?.(attach)
    return () => onReady?.(null)
  }, [onReady, conversationId])

  /**
   * Validate and queue files. Shared by the paperclip, paste, and drag-drop —
   * all three must apply exactly the same rules.
   *
   * Rejections are reported per file and the rest are still queued: dropping a
   * folder of twelve images because one is a .heic would be worse than saying
   * so and sending the eleven.
   */
  const attach = (files) => {
    const incoming = [...(files || [])].filter(Boolean)
    if (!incoming.length) return

    const accepted = []
    const rejected = []

    for (const file of incoming) {
      const mime = String(file.type || '').toLowerCase().split(';')[0]
      if (!ACCEPT.split(',').includes(mime)) {
        rejected.push(`${file.name} (${mime || 'unknown type'})`)
        continue
      }
      if (file.size > MAX_BYTES) {
        rejected.push(`${file.name} (over 16MB)`)
        continue
      }
      const isImage = mime.startsWith('image/')
      accepted.push({
        file,
        isImage,
        previewUrl: isImage ? URL.createObjectURL(file) : null,
      })
    }

    let message = null
    if (rejected.length === 1) message = `Could not attach ${rejected[0]}`
    else if (rejected.length > 1) message = `Could not attach ${rejected.length} files`
    setError(message)

    if (accepted.length) setAttachments((current) => [...current, ...accepted])
  }

  const clearAttachments = () => {
    setAttachments([])
    setError(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  /** Drop one file from the queue, by index — the others are still wanted. */
  const removeAttachment = (index) => {
    setAttachments((current) => {
      const url = current[index]?.previewUrl
      if (url) URL.revokeObjectURL(url)
      return current.filter((_, i) => i !== index)
    })
    setError(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  const submit = async () => {
    const text = value.trim()
    if ((!text && !attachments.length) || sending || disabled) return

    setSending(true)
    setError(null)
    try {
      // No attachments: one plain text message, exactly as before.
      if (!attachments.length) {
        await onSend(text, null, replyTo?.id ?? null)
        setValue('')
        onCancelReply?.()
        return
      }

      // One message per file — the API carries a single media object per
      // message. The typed text becomes the FIRST file's caption, matching how
      // WhatsApp treats a caption on a multi-file send, and the quote is
      // likewise attached only to the first so the thread shows one reply.
      sentCountRef.current = 0
      for (const [index, item] of attachments.entries()) {
        setProgress({ done: index, total: attachments.length })

        // Upload first — a failed upload must not produce a half-sent message.
        const uploaded = await api.upload(conversationId, item.file)
        await onSend(
          index === 0 ? text : '',
          {
            media_path: uploaded.media_path,
            media_type: uploaded.media_type,
            media_mime: uploaded.media_mime,
            media_filename: uploaded.media_filename,
            media_size: uploaded.media_size,
          },
          index === 0 ? replyTo?.id ?? null : null
        )
        sentCountRef.current += 1
      }

      setValue('')
      clearAttachments()
      // The quote belongs to the message just sent, not to the next one.
      onCancelReply?.()
    } catch (err) {
      // Inline, never thrown past this boundary. Anything already sent stays
      // sent — the queue is trimmed to what did NOT go out, so a retry does not
      // duplicate the files that succeeded.
      setAttachments((current) => current.slice(sentCountRef.current))
      setError(err instanceof ApiError ? err.message : 'Could not send. Please try again.')
    } finally {
      setSending(false)
      setProgress(null)
    }
  }

  // Paste an image straight from the clipboard.
  const onPaste = (e) => {
    const files = [...(e.clipboardData?.items || [])]
      .filter((i) => i.kind === 'file')
      .map((i) => i.getAsFile())
      .filter(Boolean)
    if (!files.length) return
    e.preventDefault()
    attach(files)
  }

  const canSend = Boolean(value.trim() || attachments.length)

  let placeholder = isGroup ? 'Message the group…' : 'Write a reply…'
  if (attachments.length === 1) placeholder = 'Add a caption…'
  else if (attachments.length > 1) placeholder = 'Add a caption for the first file…'

  return (
    <div className="reply">
      {error ? (
        <div className="reply-error" role="alert">
          <AlertCircle size={14} />
          <span>{error}</span>
        </div>
      ) : null}

      <ReplyPreview target={replyTo} conversation={conversation} onCancel={onCancelReply} />

      {attachments.length ? (
        <div className="reply-attach-list">
          {attachments.length > 1 ? (
            <div className="reply-attach-summary">
              <span>
                {attachments.length} files · sent as {attachments.length} messages
              </span>
              <button
                type="button"
                className="reply-attach-clear"
                onClick={clearAttachments}
                disabled={sending}
              >
                Remove all
              </button>
            </div>
          ) : null}

          {attachments.map((item, index) => (
            <div className="reply-attach" key={`${item.file.name}-${item.file.lastModified}-${index}`}>
              {item.isImage ? (
                <img className="reply-attach-thumb" src={item.previewUrl} alt="" />
              ) : (
                <span className="reply-attach-icon">
                  <FileText size={16} />
                </span>
              )}
              <span className="reply-attach-body">
                <span className="reply-attach-name">{item.file.name}</span>
                <span className="reply-attach-size">{formatBytes(item.file.size)}</span>
              </span>
              <button
                type="button"
                className="reply-attach-remove"
                aria-label={`Remove ${item.file.name}`}
                onClick={() => removeAttachment(index)}
                disabled={sending}
              >
                <X size={15} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="reply-inner">
        <input
          ref={fileRef}
          type="file"
          className="visually-hidden"
          accept={ACCEPT}
          multiple
          onChange={(e) => {
            attach(e.target.files)
            e.target.value = ''
          }}
        />

        <button
          type="button"
          className="reply-attach-btn"
          aria-label="Attach a file"
          title="Attach a file"
          disabled={disabled || sending}
          onClick={() => fileRef.current?.click()}
        >
          <Paperclip size={17} />
        </button>

        <textarea
          ref={textareaRef}
          className="reply-input"
          rows={1}
          placeholder={placeholder}
          aria-label={attachments.length ? 'Attachment caption' : 'Reply message'}
          value={value}
          disabled={disabled || sending}
          onChange={(e) => setValue(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter makes a new line.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
            // Escape drops the quote before it drops anything else — the
            // composer keeps whatever has been typed.
            if (e.key === 'Escape' && replyTo) {
              e.preventDefault()
              onCancelReply?.()
            }
          }}
        />

        <button
          type="button"
          className="reply-send"
          aria-label={sending ? 'Sending' : 'Send message'}
          disabled={disabled || sending || !canSend}
          onClick={submit}
        >
          {sending ? <span className="spinner" /> : <Send size={16} />}
        </button>
      </div>

      {progress && progress.total > 1 ? (
        <div className="reply-hint" role="status">
          Sending {progress.done + 1} of {progress.total}…
        </div>
      ) : (
        <div className="reply-hint desktop-only">Enter to send · Shift + Enter for a new line</div>
      )}
    </div>
  )
}
