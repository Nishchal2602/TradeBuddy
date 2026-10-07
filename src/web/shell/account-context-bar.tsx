import { hrefFor } from '../router'

// WEB-2 (2026-10-08) — rendered once, in App.tsx, above every routed
// page's own content whenever a portfolioId is present in the URL — this
// guarantees the "you are viewing a test account" indicator is present on
// every one of that account's own pages without touching any of the 5
// page components individually. Shows the id prefix immediately (known
// synchronously from the URL at mount) and upgrades to the real label
// once loadAccountContext resolves, so there's never a flash where a
// scoped page looks unscoped.
export function AccountContextBar({ portfolioId, name }: { portfolioId: string; name: string | null }) {
  const display = name ?? `account ${portfolioId.slice(0, 8)}`
  return (
    <div className="glass border-w-accent/30 mb-6 flex items-center gap-3 px-5 py-3">
      <span className="h-2 w-2 rounded-full bg-w-accent" />
      <span className="wt-body-sm text-w-text">Viewing test account — {display}</span>
      <span className="text-w-faint">·</span>
      <span className="wt-body-sm text-w-muted">This is not the live account</span>
      <a href={hrefFor('/')} className="wt-body-sm text-w-accent ml-auto hover:underline">
        Open the live account →
      </a>
    </div>
  )
}
