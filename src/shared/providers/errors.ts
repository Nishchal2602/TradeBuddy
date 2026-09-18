// Shared error taxonomy for market-data and news provider adapters.
//
// Deliberately generic (no CoinGecko/CryptoPanic-specific fields) so the
// agent cycle can branch on failure kind without knowing which provider is
// behind the interface — the same reason the provider interfaces themselves
// are generic (architecture.md § Model Boundary / code-standards.md
// "Keep provider integrations behind adapters").
//
// The distinction that matters most (code-standards.md § Error Handling,
// invariant 6): a validation failure and a rate limit are both "the cycle
// must fail closed," but they're different failures an operator would want
// to tell apart in logs — hence separate classes rather than one generic
// ProviderError with a string reason.
//
// Fields are declared + assigned explicitly rather than via TS constructor
// parameter-property shorthand: tsconfig.app.json sets erasableSyntaxOnly,
// which forbids parameter properties (they emit real assignment code, not
// just erasable type annotations) — Deno's checker doesn't enforce this, so
// this only surfaces under the real `tsc -b` build. Keeping one style here
// avoids the two runtimes silently diverging on what's writable.

export class ProviderFetchError extends Error {
  readonly provider: string
  override readonly cause?: unknown

  constructor(message: string, provider: string, cause?: unknown) {
    super(message)
    this.name = 'ProviderFetchError'
    this.provider = provider
    this.cause = cause
  }
}

export class ProviderRateLimitError extends ProviderFetchError {
  readonly retryAfterSeconds?: number

  constructor(provider: string, retryAfterSeconds?: number) {
    super(`${provider} rate limit exceeded`, provider)
    this.name = 'ProviderRateLimitError'
    this.retryAfterSeconds = retryAfterSeconds
  }
}

// The provider responded, but the payload didn't match the shape we
// validate against. Distinct from ProviderFetchError (network/HTTP failure)
// because a validation failure means the provider is reachable but its
// response format drifted — worth alerting on differently than an outage.
export class ProviderValidationError extends Error {
  readonly provider: string
  readonly issues: unknown

  constructor(message: string, provider: string, issues: unknown) {
    super(message)
    this.name = 'ProviderValidationError'
    this.provider = provider
    this.issues = issues
  }
}
