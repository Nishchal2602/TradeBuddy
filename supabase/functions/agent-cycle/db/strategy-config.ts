import type { SupabaseClient } from '@supabase/supabase-js'
import { IntradayLsConfig } from '../../../../src/shared/strategy/config-schema.ts'
import { configHashInput } from '../../../../src/shared/strategy/config-schema.ts'
import { V4_1_CORRECTED_CONFIG, V4_COMPAT_CONFIG } from '../../../../src/shared/strategy/config-presets.ts'
import { hashPromptContent } from '../model/jev/prompt-hash.ts'

// CFG-1 — strategy_configs is the DB home for the config schema
// (config-schema.ts); this module is the only thing that reads/writes
// it. Content-hashed via the SAME SHA-256 primitive P0 item 1 already
// built for prompt-artifact hashing (model/jev/prompt-hash.ts), reused
// deliberately rather than a second hashing scheme — this is exactly the
// reuse that file's own comment anticipated.
//
// Pre-registration, reconciled with user-tunability: a config value no
// longer means "the number never changes" — it means "a result is only
// ever claimed for one config hash." Changing a value is an explicit,
// attributable act (a new row, a new hash) rather than a silent edit to
// a constant nobody recorded.

// Canonical JSON — keys sorted recursively, so two structurally-equal
// configs ALWAYS hash identically regardless of construction order (the
// two presets happen to share key order today via object spread, but
// this must not be relied upon for configs built any other way, e.g. a
// future DB round-trip).
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export async function computeConfigHash(config: IntradayLsConfig): Promise<string> {
  return hashPromptContent([canonicalJson(configHashInput(config))])
}

export interface LoadedConfig {
  config: IntradayLsConfig
  configHash: string
}

// Idempotent, cheap (two point-selects on a tiny table) — called once
// per cycle from index.ts, same "side write, never fails the cycle"
// discipline as market_bars/market_quotes. After the first successful
// call, every subsequent call is a no-op (both presets already exist).
export async function ensureConfigSeeded(supabase: SupabaseClient): Promise<void> {
  const { count, error: countError } = await supabase.from('strategy_configs').select('id', { count: 'exact', head: true })
  if (countError) {
    console.error(`ensureConfigSeeded: could not check strategy_configs: ${countError.message}`)
    return
  }
  if (count !== null && count > 0) return

  for (const [config, isActive] of [[V4_COMPAT_CONFIG, true], [V4_1_CORRECTED_CONFIG, false]] as const) {
    const configHash = await computeConfigHash(config)
    const { error: insertError } = await supabase.from('strategy_configs').insert({
      profile: 'intraday_ls',
      preset_name: config.presetName,
      config,
      config_hash: configHash,
      is_active: isActive,
    })
    if (insertError) {
      console.error(`ensureConfigSeeded: could not seed ${config.presetName}: ${insertError.message}`)
    }
  }
}

// Reads the active row, re-validates it against the schema (never trust
// a DB jsonb blob silently — same discipline the jev_request_projection
// envelope already established as this backend's first Zod-validated
// persisted jsonb shape), and recomputes the hash to confirm it matches
// what's stored — a tamper/drift detector, not just a read. A mismatch
// means the row was edited without going through computeConfigHash
// (e.g. a hand SQL UPDATE), which must never be silently trusted.
export async function loadActiveIntradayLsConfig(supabase: SupabaseClient): Promise<LoadedConfig | null> {
  const { data, error } = await supabase
    .from('strategy_configs')
    .select('config, config_hash')
    .eq('profile', 'intraday_ls')
    .eq('is_active', true)
    .maybeSingle()
  if (error) throw new Error(`could not load active intraday_ls config: ${error.message}`)
  if (!data) return null

  const parsed = IntradayLsConfig.safeParse(data.config)
  if (!parsed.success) throw new Error(`active strategy_configs row failed schema validation: ${parsed.error.message}`)

  const recomputedHash = await computeConfigHash(parsed.data)
  if (recomputedHash !== data.config_hash) {
    throw new Error(`strategy_configs hash mismatch for '${parsed.data.presetName}' — stored config was edited without recomputing its hash (expected ${data.config_hash}, got ${recomputedHash})`)
  }

  return { config: parsed.data, configHash: recomputedHash }
}

// EXP-1 (2026-10-07) — the same load-validate-rehash discipline as
// loadActiveIntradayLsConfig above, but by explicit id rather than
// "whichever is_active". An experiment_variant pins ITS OWN
// strategy_config_id, independent of whatever is globally active — the
// whole point of a variant being a reproducible treatment rather than a
// moving target. is_active is not consulted here at all; a variant may
// reference an inactive (even permanently retired) config row.
export async function loadConfigById(supabase: SupabaseClient, configId: string): Promise<LoadedConfig> {
  const { data, error } = await supabase
    .from('strategy_configs')
    .select('config, config_hash')
    .eq('id', configId)
    .single()
  if (error || !data) throw new Error(`could not load strategy_configs row ${configId}: ${error?.message}`)

  const parsed = IntradayLsConfig.safeParse(data.config)
  if (!parsed.success) throw new Error(`strategy_configs row ${configId} failed schema validation: ${parsed.error.message}`)

  const recomputedHash = await computeConfigHash(parsed.data)
  if (recomputedHash !== data.config_hash) {
    throw new Error(`strategy_configs hash mismatch for row ${configId} ('${parsed.data.presetName}') — stored config was edited without recomputing its hash (expected ${data.config_hash}, got ${recomputedHash})`)
  }

  return { config: parsed.data, configHash: recomputedHash }
}
