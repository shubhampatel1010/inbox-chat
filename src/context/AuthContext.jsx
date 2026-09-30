import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { api, setToken, setSessionLostHandler } from '../lib/api.js'

const AuthContext = createContext(null)

/**
 * Session state lives entirely in memory here. Durability comes from the
 * HttpOnly refresh cookie, which JavaScript cannot read — so there is nothing
 * to persist and nothing to clear from storage.
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  // 'loading' until the cold-start refresh resolves — App renders a splash
  // during this window so the login screen never flashes.
  const [status, setStatus] = useState('loading')

  const clearSession = useCallback(() => {
    setToken(null)
    setUser(null)
    setStatus('anon')
  }, [])

  // Only fires after a refresh attempt has itself failed.
  useEffect(() => {
    setSessionLostHandler(clearSession)
    return () => setSessionLostHandler(null)
  }, [clearSession])

  // Cold start: try to restore from the refresh cookie before rendering.
  useEffect(() => {
    let cancelled = false

    api
      .refresh()
      .then((data) => {
        if (cancelled) return
        if (data?.user) {
          setUser(data.user)
          setStatus('authed')
        } else {
          setStatus('anon')
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('anon')
      })

    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(async (email, password) => {
    const data = await api.login(email, password)
    setToken(data.token)
    setUser(data.user)
    setStatus('authed')
    return data
  }, [])

  const logout = useCallback(async () => {
    // Revoke this device's refresh token server-side; other devices are
    // unaffected. Local state is cleared either way.
    await api.logout()
    clearSession()
  }, [clearSession])

  const value = useMemo(
    () => ({
      user,
      status,
      isLoading: status === 'loading',
      isAuthenticated: status === 'authed',
      isAdmin: user?.role === 'admin',
      login,
      logout,
    }),
    [user, status, login, logout]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
