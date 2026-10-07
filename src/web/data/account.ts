import { supabase } from '@/supabase'

// WEB-2 (2026-10-08) — a one-shot (non-polling) lookup of an account's
// own display context. Fetched once per mount in App.tsx, not via
// usePoll: within one tab's lifetime portfolioId is fixed (it only
// changes via a fresh full-page load in a new tab), and a portfolio's
// label is effectively static for a session, so there is nothing here
// that benefits from a 30s refresh.
export interface AccountContext {
  id: string
  // The account's OWN distinguishing name (e.g. "E4-B Signal-Drift") —
  // NOT portfolios.label, which (by this project's own established
  // seeding convention, EXP-1 E3/E4) holds the EXPERIMENT/batch name
  // shared by every account in it (e.g. "exp1-e4-dry-run"), not a
  // per-account identifier.
  name: string
  experimentLabel: string | null
  isTest: boolean
}

export async function loadAccountContext(portfolioId: string): Promise<AccountContext> {
  const { data, error } = await supabase.from('portfolios').select('id, name, label, is_test').eq('id', portfolioId).single()
  if (error) throw new Error(`could not load account ${portfolioId}: ${error.message}`)
  return { id: data.id, name: data.name, experimentLabel: data.label, isTest: data.is_test }
}
