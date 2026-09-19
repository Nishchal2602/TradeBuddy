import { createClient } from '@supabase/supabase-js'

// Deliberately not under src/lib/ — that path is already claimed by the
// @/lib/* alias, which resolves to the project-root lib/ (shadcn's `cn()`
// helper), not src/lib/ (progress-tracker.md's UI Step 1 entry / Step 1's
// own alias-order comment in vite.config.ts). A file here would be
// unreachable at @/lib/supabase.
//
// The URL and anon key are hardcoded, not read from a VITE_-prefixed env
// var. This is not the same call CLAUDE.md's Security rules address —
// that list (Gemini keys, news-provider keys, the Supabase service-role
// key) is explicitly about privileged secrets that must never enter
// client code; the anon key is not on it, because it is not privileged —
// RLS is the actual security boundary, and the extension shipping the
// anon key was already decided (progress-tracker.md, Unit 2 Architecture
// Decisions: "the extension ships the public anon key"). Hardcoding
// avoids relying on any VITE_ env var at all, since .env.example's own
// "never VITE_-prefixed anywhere" note — written for the Gemini keys —
// otherwise reads unqualified enough to cause exactly this kind of
// second-guessing the next time someone touches this file.
const SUPABASE_URL = 'https://ymmegosnnywpnyafgnrk.supabase.co'
const SUPABASE_ANON_KEY = 'sb_publishable_Ivy16t3A_t_CDskxYP6O9A_Kemn5ZUJ'

// One client for the whole extension. Read-only in practice: every
// exposed table grants anon SELECT only (RLS), so nothing here can
// mutate portfolio/decision/position state — control actions (pause,
// run-now) are presentation-only in this UI step (no control Edge
// Function exists yet to safely wire them to) and any future write path
// goes through a server-side Edge Function, never a direct client write
// (architecture.md § System Boundaries).
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
