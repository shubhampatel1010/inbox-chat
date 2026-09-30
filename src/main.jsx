import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { registerServiceWorker, markStandalone, watchInstallPrompt } from './lib/pwa.js'
import './styles.css'
// Removable "new lead" feature — see functions/api/leads/mine.js to remove.
import './features/leads/leads-feature.css'

// Must run before render so CSS sees the standalone flag on the first paint.
markStandalone()
watchInstallPrompt()
registerServiceWorker()

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

