import { MessageSquare, X, CheckCircle2, AlertCircle } from 'lucide-react'

const ICONS = {
  message: { Icon: MessageSquare, className: '' },
  success: { Icon: CheckCircle2, className: 'ok' },
  error: { Icon: AlertCircle, className: 'err' },
}

export default function ToastStack({ toasts, onDismiss }) {
  if (!toasts.length) return null

  return (
    <div className="toast-stack" role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map((toast) => {
        const { Icon, className } = ICONS[toast.variant] || ICONS.message
        const clickable = Boolean(toast.onClick)

        return (
          <div
            key={toast.id}
            className="toast"
            role={clickable ? 'button' : 'status'}
            tabIndex={clickable ? 0 : undefined}
            style={clickable ? { cursor: 'pointer' } : undefined}
            onClick={
              clickable
                ? () => {
                    toast.onClick()
                    onDismiss(toast.id)
                  }
                : undefined
            }
            onKeyDown={
              clickable
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      toast.onClick()
                      onDismiss(toast.id)
                    }
                  }
                : undefined
            }
          >
            <span className={`toast-icon ${className}`}>
              <Icon size={16} />
            </span>

            <div className="toast-body">
              <div className="toast-title">{toast.title}</div>
              {toast.text ? <div className="toast-text">{toast.text}</div> : null}
            </div>

            <button
              type="button"
              className="toast-close"
              aria-label="Dismiss notification"
              onClick={(e) => {
                e.stopPropagation()
                onDismiss(toast.id)
              }}
            >
              <X size={14} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
