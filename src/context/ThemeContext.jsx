import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

const THEME_KEY = 'wpchat.theme'
const SOUND_KEY = 'wpchat.sound'

const ThemeContext = createContext(null)

// localStorage so preferences survive a session ending — notably when iOS
// evicts the home-screen PWA, which previously reset the theme on every
// relaunch. Auth tokens deliberately stay in memory; only these preferences
// are persisted.
function readStored(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* private mode — in-memory state still applies */
  }
}

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => (readStored(THEME_KEY, 'light') === 'dark' ? 'dark' : 'light'))
  // Sound defaults on.
  const [soundOn, setSoundOn] = useState(() => readStored(SOUND_KEY, 'on') !== 'off')

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    store(THEME_KEY, theme)
  }, [theme])

  useEffect(() => {
    store(SOUND_KEY, soundOn ? 'on' : 'off')
  }, [soundOn])

  const value = useMemo(
    () => ({
      theme,
      isDark: theme === 'dark',
      toggleTheme: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
      soundOn,
      toggleSound: () => setSoundOn((s) => !s),
    }),
    [theme, soundOn]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider')
  return ctx
}
