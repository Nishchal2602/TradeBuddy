// Tier 0 provenance (2026-10-03, plan §6B "Jev continuous-evaluation
// architecture", P0 item 1) — binds each hand-maintained *_QUESTION_
// VERSION string to a content hash of the prompt text it actually
// describes, so a wording change without a version bump is a test
// failure, not a silent drift discovered later by a human re-reading the
// file. This has already happened twice in this codebase:
// MANAGEMENT_QUESTION_VERSION was not bumped when ADD was disabled for
// intraday_ls (caught a day later, by chance, while revising an
// unrelated section); strategy_version drifted to a 'v3.1' value that
// was never actually shipped (context/specs/trading-strategy-aggressive-
// v3.md's own Versioning Discipline note).
//
// Deliberately narrow: this is the minimum primitive that makes drift
// detectable now, not a prompt-management system. It is designed to be
// reused later (plan §6B, "Separate case_id from evaluation_id") as the
// prompt-hash component of an evaluation fingerprint:
//   evaluation_id = hash(case_id, model_id, prompt_hashes, inference_config)
// which is also why this is SHA-256 rather than a toy checksum — the
// same function anchors evaluation-fingerprint equality later, where
// collision resistance is what proves two evaluations ran against
// byte-identical prompt text, not merely "probably the same."

export async function hashPromptContent(parts: readonly string[]): Promise<string> {
  const canonical = JSON.stringify(parts)
  const bytes = new TextEncoder().encode(canonical)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
