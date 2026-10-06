import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/web/styles/web-theme.css'
import { App } from './App'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Web app root element (#root) is missing from index.html.')

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
