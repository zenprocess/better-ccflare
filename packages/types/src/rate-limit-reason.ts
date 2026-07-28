/**
 * Upstream failure classification used by the proxy response handling path.
 *
 * The producer (response handler) classifies upstream signals into one of
 * these literals at the call site. The circuit breaker (`packages/proxy`)
 * accepts these literals directly via a `FailureKind` alias and decides
 * which kinds should trip the breaker. Keep this union in sync with
 * upstream signal mapping.
 *
 * Variants:
 * - `upstream_429_with_reset` — account/provider-wide 429 with a parseable
 *   `reset`/retry-after. Counts as a circuit failure.
 * - `upstream_429_no_reset_default_5h` — account-wide 429 without reset;
 *   defaults to 5h retry. Counts as a circuit failure.
 * - `upstream_429_no_reset_probe_cooldown` — account-wide 429 without reset;
 *   circuit-probe-driven cooldown. Counts as a circuit failure.
 * - `model_fallback_429` — per-model 429 on a mapped model; the account can
 *   still serve other models via client-side fallback. Does NOT trip the
 *   breaker.
 * - `all_models_exhausted_429` — every mapped model on the account is
 *   429ed (no fallback model remains). Counts as a circuit failure.
 * - `upstream_529_overloaded_with_reset` — 529 with retry-after. Counts as
 *   a circuit failure.
 * - `upstream_529_overloaded_no_reset` — 529 without retry-after. Counts
 *   as a circuit failure.
 * - `out_of_credits` — per-model credit depletion (e.g. context-1m
 *   allocations). Scoped to one model, not account-wide. Does NOT trip
 *   the breaker.
 * - `extra_usage_exhausted` — third-party OAuth extra-usage depletion.
 *   Scoped, not account-wide. Does NOT trip the breaker.
 */
export const RATE_LIMIT_REASONS = [
	"upstream_429_with_reset",
	"upstream_429_no_reset_default_5h",
	"upstream_429_no_reset_probe_cooldown",
	"model_fallback_429",
	"all_models_exhausted_429",
	"upstream_529_overloaded_with_reset",
	"upstream_529_overloaded_no_reset",
	"out_of_credits",
	"extra_usage_exhausted",
] as const;

export type RateLimitReason = (typeof RATE_LIMIT_REASONS)[number];

export function isRateLimitReason(value: string): value is RateLimitReason {
	return (RATE_LIMIT_REASONS as readonly string[]).includes(value);
}
