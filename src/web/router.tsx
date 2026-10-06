import { useEffect, useState } from 'react'

// Hand-rolled hash router (WEB-1 plan) — matches this repo's existing
// character (hand-rolled data hooks instead of react-query, hand-rolled
// tab state in the extension's own App.tsx) rather than adding
// react-router-dom for five pages. Gives deep links (#/decisions/:id) and
// real browser back/forward via the native hashchange event, at zero
// dependency cost. If the page count grows materially, react-router is
// the documented escape hatch (WEB-1 plan, Architecture).

export type Route =
  | { name: 'overview' }
  | { name: 'decisions' }
  | { name: 'decision-detail'; id: string }
  | { name: 'positions' }
  | { name: 'judgment' }
  | { name: 'strategy' }

function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '') || '/'
  const segments = path.split('/').filter(Boolean)

  if (segments.length === 0) return { name: 'overview' }
  if (segments[0] === 'decisions' && segments[1]) return { name: 'decision-detail', id: segments[1] }
  if (segments[0] === 'decisions') return { name: 'decisions' }
  if (segments[0] === 'positions') return { name: 'positions' }
  if (segments[0] === 'judgment') return { name: 'judgment' }
  if (segments[0] === 'strategy') return { name: 'strategy' }
  return { name: 'overview' }
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash))

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(window.location.hash))
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  return route
}

export function navigate(path: string): void {
  window.location.hash = path
}

export function hrefFor(path: string): string {
  return `#${path}`
}
