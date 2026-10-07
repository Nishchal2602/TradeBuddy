import { useEffect, useState } from 'react'

// Hand-rolled hash router (WEB-1 plan) — matches this repo's existing
// character (hand-rolled data hooks instead of react-query, hand-rolled
// tab state in the extension's own App.tsx) rather than adding
// react-router-dom for five pages. Gives deep links (#/decisions/:id) and
// real browser back/forward via the native hashchange event, at zero
// dependency cost. If the page count grows materially, react-router is
// the documented escape hatch (WEB-1 plan, Architecture).

export type Route =
  | { name: 'overview'; portfolioId?: string }
  | { name: 'decisions'; portfolioId?: string }
  | { name: 'decision-detail'; id: string; portfolioId?: string }
  | { name: 'positions'; portfolioId?: string }
  | { name: 'judgment'; portfolioId?: string }
  | { name: 'strategy'; portfolioId?: string }
  | { name: 'experiments' }
  | { name: 'experiment-detail'; id: string }

function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '') || '/'
  const segments = path.split('/').filter(Boolean)

  // EXP-1/WEB-2 (2026-10-08) — an optional /p/:portfolioId prefix, peeled
  // off before the existing dispatch chain runs UNCHANGED on whatever
  // segments remain. Every bare URL (no "p" prefix) produces exactly
  // today's route object (portfolioId undefined) — the behavior-
  // neutrality this retrofit depends on. A stripped portfolioId survives
  // even into the fallback case, so a typo'd scoped path lands on that
  // account's own Overview, never silently swaps to the champion.
  let portfolioId: string | undefined
  if (segments[0] === 'p' && segments[1]) {
    portfolioId = segments[1]
    segments.splice(0, 2)
  }

  if (segments.length === 0) return { name: 'overview', portfolioId }
  if (segments[0] === 'decisions' && segments[1]) return { name: 'decision-detail', id: segments[1], portfolioId }
  if (segments[0] === 'decisions') return { name: 'decisions', portfolioId }
  if (segments[0] === 'positions') return { name: 'positions', portfolioId }
  if (segments[0] === 'judgment') return { name: 'judgment', portfolioId }
  if (segments[0] === 'strategy') return { name: 'strategy', portfolioId }
  if (segments[0] === 'experiments' && segments[1]) return { name: 'experiment-detail', id: segments[1] }
  if (segments[0] === 'experiments') return { name: 'experiments' }
  return { name: 'overview', portfolioId }
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

export function navigate(path: string, portfolioId?: string): void {
  window.location.hash = portfolioId ? `/p/${portfolioId}${path}` : path
}

export function hrefFor(path: string, portfolioId?: string): string {
  return portfolioId ? `#/p/${portfolioId}${path}` : `#${path}`
}
