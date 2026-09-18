/**
 * Popup root. Unit 1 (scaffold) renders an empty themed frame only —
 * no agent status, decision feed, or portfolio data yet. Those land in
 * later units once the shared domain types, Supabase reads, and feature
 * components exist. See context/progress-tracker.md.
 */
export function App() {
  return (
    <div className="flex h-[560px] w-[400px] flex-col bg-bg-base text-text-primary">
      <header className="border-b border-border-default px-4 py-3">
        <h1 className="font-sans text-sm font-medium text-text-primary">
          AI Trader
        </h1>
        <p className="mt-0.5 font-mono text-xs text-text-muted">
          scaffold — no agent connected yet
        </p>
      </header>
      <main className="flex flex-1 items-center justify-center px-4">
        <p className="text-center font-mono text-xs text-text-muted">
          Decision feed, portfolio, and controls land in later units.
        </p>
      </main>
    </div>
  )
}
