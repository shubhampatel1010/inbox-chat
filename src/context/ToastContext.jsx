import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import ToastStack from '../components/Toast.jsx'

const ToastContext = createContext(null)

const AUTO_DISMISS_MS = 5000

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const nextId = useRef(1)
  const timers = useRef(new Map())

  const dismiss = useCallback((id) => {
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
    setToasts((current) => current.filter((t) => t.id !== id))
  }, [])

  const push = useCallback(
    (toast) => {
      const id = nextId.current++
      setToasts((current) => [...current, { ...toast, id }])
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), toast.duration ?? AUTO_DISMISS_MS)
      )
      return id
    },
    [dismiss]
  )

  const value = useMemo(
    () => ({
      push,
      dismiss,
      notify: (title, text, onClick) => push({ variant: 'message', title, text, onClick }),
      success: (title, text) => push({ variant: 'success', title, text }),
      error: (title, text) => push({ variant: 'error', title, text }),
    }),
    [push, dismiss]
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside ToastProvider')
  return ctx
}
