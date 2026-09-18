import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/styles/theme.css'
import { App } from './App'

const rootEl = document.getElementById('root')
if (!rootEl) {
  throw new Error('Popup root element (#root) is missing from popup.html.')
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
