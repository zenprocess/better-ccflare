# Adversarial evaluation of `path_project` attribution leak options — issue #373 / PR #378

> Internal analysis only. No code changes, no upstream comments.
> Goal: defeat each option with concrete inputs, then recommend.

## Context (recap)

`packages/proxy/src/project-attribution.ts` extracts a project label from a
client workspace path captured out of the system prompt. The capture is
`[^/]+` between `/projects/` (or `/Desktop/`, `/repos/`, `/src/`) and the
next `/`. When the system prompt's newlines collapse, that greedy capture
runs on past the real directory name into following prompt text. That text
gets hard-truncated to 64 chars and persisted in `requests.project`,
returned by `/api/requests` and `/api/insights/*` (both unauthenticated by
default). Three options under consideration:

- **Option 1:** allow whitespace, cap at a 6-word "sentence" (current
  `isLowRiskProjectSlug` behavior).
- **Option 2:** reject any whitespace outright (current PR #378).
- **Option 3:** cap at 2 words when whitespace present, single-word otherwise.

This document tests whether each option is meaningfully leak-tight against a
hostile or unlucky system prompt.

## Method

Inlined a faithful copy of both `isLowRiskProjectSlug` (Option 1 surface)
and `isLowRiskPathSegment` (Option 2 surface, current PR) plus a synthetic
Option 3 (2-word cap layered on Option 1) in
`scripts/probes/bypass-attribution-373.ts` and ran them against a probe set
of 45 inputs covering: customer-name fragments, internal codenames,
incident/jira labels, credential labels, dotted hostnames, single-word
codenames, hyphenated IP shapes, ASCII whitespace variants, every Unicode
"whitespace lookalike" that JavaScript's `\s` handles, and fullwidth-slash
path separators. The probe runs against JavaScript regex semantics on
Node 22.22.0 / bun 1.3.2. Empirical results, then analysis.

### Probe summary

```
Total accepted: O1=24/45, O2=15/45, O3=18/45
```

- **Option 1 (6-word cap)** is the most permissive — accepts 24/45, including
  all of the prose-fragment attack vectors it is supposed to drop.
- **Option 2 (no whitespace, current PR)** accepts 15/45 — strictest of the
  three. Defeats every prose-fragment attack but loses attribution on some
  real-shaped directories (which it then falls through to the H1 heading
  path for — see "Cost of losing attribution" below).
- **Option 3 (2-word cap)** accepts 18/45 — sits between the other two. It
  loses the prose-fragment vectors Option 1 lets through but re-enables the
  2-word noun-phrase attack vectors that Option 2 blocks.

---

## 1. Concrete strings that leak under EACH option

The probe code lives at `scripts/probes/bypass-attribution-373.ts`. The
table below shows the most useful leak candidates from that probe. ✓ =
accepted (i.e., ends up in `requests.project` and shows on
`/api/insights/*`). ✗ = rejected.

| # | input | what it leaks | O1 | O2 | O3 |
|---|---|---|:-:|:-:|:-:|
| 1.1 | `Acme Corp subsidiary internal` | customer name + ops context (4 words) | ✓ | ✗ | ✗ |
| 1.2 | `Project Phoenix Confidential` | internal codename + classification marker (3 words) | ✓ | ✗ | ✗ |
| 1.3 | `PHOENIX SkyNet operational review notes` | two internal codenames + ops review (5 words) | ✓ | ✗ | ✗ |
| 1.4 | `Internal legal hold pending` | incident/hold language (4 words) | ✓ | ✗ | ✗ |
| 1.5 | `prod aws amazon com` | hostname-shaped (4 words; un-dotted form dodges `DOTTED_HOSTNAME_LABEL_RE`) | ✓ | ✗ | ✗ |
| 1.6 | `Production host rotated cluster` | operational metadata (5 words) | ✓ | ✗ | ✗ |
| 3.1 | `Acme Corp` | customer name (2 words) | ✓ | ✗ | ✓ |
| 3.2 | `Project Phoenix` | internal codename (2 words) | ✓ | ✗ | ✓ |
| 3.3 | `Nimbus` | single-word codename | ✓ | ✓ | ✓ |
| 3.4 | `Strapi` | single-word tool/admin path | ✓ | ✓ | ✓ |
| 3.6 | `Internal Only` | confidentiality marker (2 words) | ✓ | ✗ | ✓ |
| 3.7 | `Do Not` | operational-instruction prefix (2 words; e.g. "Do Not [share]") | ✓ | ✗ | ✓ |
| 3.8 | `eyes only` | classification marker | ✓ | ✗ | ✓ |
| 3.9 | `Customer Portal` | internal system name | ✓ | ✗ | ✓ |
| 3.10 | `Phoenix` | bare codename (1 word) | ✓ | ✓ | ✓ |
| 2.15 | `intranet.corp.example` | internal hostname (no whitespace) | ✗ | ✓ | ✗ |
| 2.16 | `foo.bar` | generic dotted label | ✗ | ✓ | ✗ |
| 2.17 | `INC-12345` | incident id | ✓ | ✓ | ✓ |
| 2.18 | `PROJ-12345` | Jira key | ✓ | ✓ | ✓ |
| 2.19 | `api-key` | credential-label prefix with empty tail | ✓ | ✓ | ✓ |
| 2.23 | `MySecretRepo` | normal-looking name bearing "Secret" | ✓ | ✓ | ✓ |
| 2.24 | `10-0-0-5` | IP-shaped internal host (hyphenated to dodge `IPV4_RE`) | ✓ | ✓ | ✓ |
| 2.27 | `MyCo-2026-Q4-Confidential-Q3-roadmap` | codename + classification + quarter + project (63 chars, all literal word chars) | ✓ | ✓ | ✓ |

### Option-specific defeats

**Option 1 leaks** (concrete inputs that pass): rows 1.1-1.6 plus 3.1-3.10
plus 2.15-2.27. The 6-word cap is functionally a no-op for every
realistic leak shape except an unusually verbose prose dump longer than 6
words. In a hostile system prompt, the threat actor keeps their payload
under 6 words. Empirically — every 1-, 2-, 3-, 4-, 5-, 6-word attack in the
probe set passes.

**Option 2 defeats all 4-6 word prose fragments** (rows 1.1-1.6 collapse to
✗). It also defeats the 2-word noun-phrase leak set (rows 3.1, 3.2, 3.6,
3.8, 3.9) — these are all ✗ under Option 2. **However**, Option 2 retains
all of:

- `INC-12345` / `PROJ-12345` — incident- and Jira-shaped operational metadata.
- `api-key` — credential-shaped labels without opaque tails.
- `intranet.corp.example` — internal hostname (single dotted, no spaces).
- Single-word codenames (`Nimbus`, `Phoenix`, `Strapi`).
- Hyphenated IP shapes (`10-0-0-5`) — `IPV4_RE` only matches dotted form.
- 64-char normal-looking slugs carrying classification verbs (`MyCo-2026-Q4-Confidential-Q3-roadmap`).

I will come back to these in §3 because they are *not* whitespace bypasses;
they are a consequence of PR #378's explicit removal of the
`CREDENTIAL_LABEL_RE` / `INCIDENT_LABEL_RE` / `JIRA_TICKET_RE` /
`DOTTED_HOSTNAME_LABEL_RE` checks from the path-segment validator. The
removal is Greptile-driven — it false-positives on legitimate directory
names like `password-manager`, `customer-portal`, `auth-token-service`,
`account-billing`, `ui.v2`.

**Option 3 defeats all 4-6 word prose fragments** (same as Option 2), but
**does not** defeat 1- or 2-word fragments (rows 3.1-3.10 are ✓). It also
keeps all the no-whitespace leaks that Option 2 keeps (2.17-2.27 minus
the dotted-hostname subset).

## 2. Residual INFORMATION CONTENT for Option 3 specifically

The premise the user's lean relies on: that 2 words leaks meaningfully less
information than 6. **For the noun-phrase part of a sensitive payload, it
doesn't.** Empirical:

- The sensitive content of `"Acme Corp subsidiary internal"` (6 words, O1)
  is the noun phrase `Acme Corp`. Option 3 limits you to `Acme Corp`. The
  nouns are unchanged. The "subsidiary internal" tail is operational
  flavor, not a new leak.
- Same for `"Project Phoenix Confidential"` → `"Project Phoenix"`. The
  codename is unchanged. `"Confidential"` is a marker, but the project
  itself is in the first two words.
- Same for `"PHOENIX SkyNet operational review notes"` → `"PHOENIX SkyNet"` —
  both codenames survive, operational context is what gets dropped.

So Option 3 is **NOT** meaningfully safer than Option 1 against the
codename-and-customer-name leak class. The 2-word cap drops prose glue but
keeps the entity name. Both `Acme Corp` (2 words) and `Acme Corp
subsidiary internal` (4 words) leak the same secret: the customer.

Where Option 3 IS a real improvement over Option 1: **sentence-shaped
disclosures** where the leak encodes structured info — customer + status +
qualifier or similar. Examples:

- `"Internal legal hold pending on Acme"` (5 words, O1 ✓) reveals customer
  + has-pending-legal-action. Option 3 limits to `"Internal legal"` or
  `"Acme"` (whichever fits in 2 words) — neither conveys status.
- `"BARBADOS BILL gates queries pool"` (5 words, O1 ✓) reveals internal
  place names + operation verb. Option 3 kills it.

**However**, Option 2 already rejects all of these — every 1-, 2-, 3-, 4-,
5-, 6-word sentence-shaped fragment is rejected, because they all contain
whitespace. So **Option 2 captures the entire marginal safety benefit
Option 3 offers, and more**, while also capturing the noun-phrase leaks
Option 3 lets through.

### Realistic 2-word fragments that ARE genuinely sensitive

These all pass Option 3:

- `Acme Corp` / `Acme Inc` / `BetaSoft Ltd` — customer name (when customer
  list is non-public).
- `Project Phoenix` / `Project Aurora` — internal codename + Project label.
- `Internal Only` / `eyes only` — confidentiality markers (tells an attacker
  this workspace is treated as confidential in the host org).
- `Customer Portal` — internal system name; if the org hosts
  customer-cardholder data via "Customer Portal" this becomes a high-value
  disclosure.
- `Bamboo Phoenix` / `Vellum Atlas` — two-word internal codenames
  (speculative: only sensitive if your org uses two-word codenames).
- `VPN Config` / `Staging Keys` / `Prod Keys` — infrastructure hints.
- `Do Not` — operation prefix where the second word follows in context
  (e.g. "Do Not" before a sentence continuation).

None of these are 64-character truncated garbage that screams "leak" — they
all read like a normal project label. That is precisely what makes them
dangerous under Option 3: there is no observable signal in
`/api/insights/*` that the field is leaked prose vs. a real project.

### Single-word fragments

1-word fragments that are sensitive:

- A bare project codename (`Nimbus`, `Aurora`, `Phoenix`, `Vellum`,
  `Bamboo`). These pass all three options.
- A bare customer name (`Acme`, `Globex`, `Hooli`).
- A short tool/admin path word (`Strapi`, `Phpmyadmin`).
- A release tag shape: `Draft2024Q4`.

These are unavoidable in any option that allows real directory names —
because real directory names are also one or two words. The path-attribution
recovery from a system prompt cannot distinguish a directory called
`Acme` (real) from a system prompt that concatenated "Acme is a customer"
into a path it shouldn't be.

### Bottom line on Option 3

> Option 3 is not meaningfully safer than the 6-word cap it would replace
> for the codename/customer-name leak class. Option 2 captures Option 3's
> marginal safety gain against verbose prose *and* eliminates the
> noun-phrase leaks Option 3 allows. Recommend Option 2.

A direct attack on the lean: **the 2-word cap sounds safer than it
actually is.** The sensitive payload in a hostile system prompt
_self-selects_ to fit in 1-2 words. A 6-word cap only frustrates an
attacker who is sloppy about their payload size.

## 3. Can Option 2 be bypassed via whitespace substitutes?

Tested every ASCII and Unicode whitespace-class codepoint I could think
of:

| input | codepoint | class | O1 | O2 | O3 |
|---|---|---|:-:|:-:|:-:|
| `Acme Corp` (regular space) | U+0020 | `\s` | ✓ | ✗ | ✓ |
| `Acme Corp` (nbsp) | U+00A0 | `\s` | ✗ | ✗ | ✗ |
| `Acme Corp` (thin space) | U+2009 | `\s` | ✗ | ✗ | ✗ |
| `Acme　Corp` (ideographic space) | U+3000 | `\s` | ✗ | ✗ | ✗ |
| `Acme Corp` (narrow no-break space) | U+202F | `\s` | ✗ | ✗ | ✗ |
| `AcmeCorp` (zero-width space) | U+200B | NOT `\s` in JS | ✗ | ✗ | ✗ |
| `Acme﻿Corp` (BOM / ZWNBSP) | U+FEFF | `\s` in modern JS | ✗ | ✗ | ✗ |
| `Acme⁠Corp` (word joiner) | U+2060 | NOT `\s` | ✗ | ✗ | ✗ |
| `Acme\tCorp` (tab) | U+0009 | `\s` | ✗ | ✗ | ✗ |
| `Acme\fCorp` (form feed) | U+000C | `\s` | ✗ | ✗ | ✗ |
| `Acme\vCorp` (vertical tab) | U+000B | `\s` | ✗ | ✗ | ✗ |
| `Acme\nCorp` (LF) | U+000A | `\s` | ✗ | ✗ | ✗ |
| `Acme\x00Corp` (NUL) | U+0000 | `\x00-\x1F` | ✗ | ✗ | ✗ |
| `abc／def` (fullwidth slash U+FF0F) | — | not a path separator | ✗ | ✗ | ✗ |
| `%20only` (percent-encoded space) | — | fails `SLUG_SHAPE_RE` (no `\w` start) | ✗ | ✗ | ✗ |

Every whitespace-substitute bypass is defeated. JS `\s` covers
nbsp/thin/ideographic/narrow-nbsp/BOM and the ASCII whitespace set; the
control-char pre-check catches LF/CR/TAB/NUL; `SLUG_SHAPE_RE`'s `\w`
bounds reject zero-width characters that aren't `\s`. PR #378's emptiness
character coverage is **robust**.

The fullwidth-slash attack (`abc／def`) is stopped both by
`SLUG_SHAPE_RE` (fullwidth slash isn't `\w`, `.`, space, or `-`) and
independent of the validator by `WORKSPACE_PATH_RE`'s literal `/` — the
path regex requires an actual ASCII `/` to match in the first place. So
a Unicode-only path-separator rewrite of the entire workspace path cannot
even enter this branch.

### Option 2's REAL residual leak surface (no whitespace involved)

Option 2 does *not* defeat the no-whitespace leaks listed above (2.15-2.27).
These are not Unicode bypasses; they are real-shaped values that satisfy
both `isLowRiskPathSegment` and `SLUG_SHAPE_RE`. They come from PR #378's
Greptile-driven decision to drop four regex checks from the path-segment
validator:

```diff
- if (DOTTED_HOSTNAME_LABEL_RE.test(cleaned)) return false;
- if (INCIDENT_LABEL_RE.test(cleaned) || JIRA_TICKET_RE.test(cleaned)) return false;
- if (CREDENTIAL_LABEL_RE.test(cleaned)) return false;
```

The PR's rationale (verbatim from the diff): the label-based heuristics
"are miscalibrated here: they exist to catch free-text sentences and
hostnames, and false-positive on completely ordinary directory names like
password-manager, customer-portal, auth-token-service, or ui.v2."

That trade-off is real — `customer-portal` IS a normal directory name,
and rejecting it would block the legit customer-portal workspace. **But
the trade-off leaks the legitimate-detection surface as well.** Speculative
but concrete:

- A workspace at `/Users/dev/repos/PROJ-12345-auth/` (legit ticket number
  in the dir name) gets stored as project `PROJ-12345-auth`. The customer
  learns their internal Jira key from `/api/insights/*`.
- A workspace at `/Users/dev/repos/intranet.corp.example-config/` gets
  stored as project `intranet.corp.example-config`. The hostname leaks.
- A workspace that includes IP-shape as a dir: `/Users/dev/repos/10-0-0-5-secrets/`
  → stores `10-0-0-5-secrets`. Hyphenated IP survives because `IPV4_RE`
  requires literal dots.

These are not Option 1 / Option 3 / Option 2 differences — **they are
properties of PR #378 itself**, which removed the only checks that would
have caught them. The whitespace-rejection is one defense layer; the
label-rejection is another, and PR #378 deliberately weakened the second
layer.

> The completeness claim "Option 2 rejects all whitespace" is true but
> misleading as a safety argument. The full robustness story needs *both*
> the whitespace check AND the label/dotted-hostname check; PR #378
> trades the second for legitimate-directory leniency.

## 4. Worst case if attribution is simply LOST (Option 2's cost)

Walked every consumer of `requests.project` and `state.project` in the
codebase. **None of them gate routing, billing, rate limits, or quota.**

What they DO use it for:

- `request.repository.save()` stores it as TEXT (column `requests.project`).
- `/api/requests` JSON response includes `project` on each row.
- `/api/insights/...` aggregates token/cost/error metrics per
  `(account, model)` AND `(project, model)` (see `insights.ts:114-125`).
- Anomaly detection buckets requests by `(account, model, project)`
  triples; rows with `project IS NULL` co-fall into a single
  `COALESCE(r.project, 'Unknown')` group.
- Dashboard filters by project (table grouping in
  `dashboard-web/src/components/RequestsTab.tsx`).
- Performance-index migration skips rows with `project IS NULL` for an
  optional index.

What's NOT affected by a null `project`:

- Account selection (`selectEligibleAccount`) — uses account priority,
  pause/rate-limit/usage-exhausted state, model, OAuth vs API-key
  capability. Project is never passed in.
- `combo_name` selection (custom account groups) — separate column,
  independent of project.
- Rate-limit windows — entirely per account.
- Billing — `cost_usd` is computed per request independently of project.
- `billing_type` — separate column, independent of project.

**Therefore, the worst case for Option 2's "lost attribution" cost is
observability degradation:**

1. Per-project cost/token model-breakdown charts lose one bucket
   (`Unknown` lumps it with other unattributed rows).
2. Project-grouped request tables show "(no project)" for affected rows.
3. Anomaly detection has slightly weaker per-project signal — rows that
   would have been in their own bucket now share an `Unknown` bucket with
   other unattributed requests.
4. Sliding back: those rows do still get H1 heading attribution as a
   fallback (PR #378's `if (rawPath && isLowRiskPathSegment(rawPath))` —
   if path validation fails, falls through to the H1 matcher's
   `for (const headingMatch of systemPrompt.matchAll(HEADING_RE))`).
   So attribution is rarely fully lost — only the path-derived
   attribution is, when H1 heading text isn't low-risk-slug-shaped.

It's not zero cost. Operators relying on per-project dashboards to spot
cost spikes will see a louder `Unknown` bucket. But it's bounded and
isolated to observability. **No routing, billing, rate-limit, or quota
behavior changes.**

## Recommendation

Pick **Option 2** (the current PR #378).

- It is the strictest of the three against the original leak vector
  (prose fragments riding along with a real workspace path).
- Its safety claim is true on the axis it advertises (whitespace
  rejection is complete — no Unicode/ASCII bypass).
- The user's lean toward Option 3 over Option 2 rests on the belief
  that 2-word fragments leak less than 6-word fragments. Empirically: the
  noun phrase leaks either way, and Option 3 re-enables
  customer-name and codename leaks that Option 2 blocks. Option 2
  captures Option 3's marginal benefit against sentence-shaped
  disclosures and more.
- Option 2's cost (lost attribution) is observability-only; confirmed by
  tracing every consumer of `requests.project`.

A follow-up, not a blocker: PR #378 explicitly removed
`DOTTED_HOSTNAME_LABEL_RE` / `INCIDENT_LABEL_RE` / `JIRA_TICKET_RE` /
`CREDENTIAL_LABEL_RE` to fix Greptile false-positives on
`password-manager`-style legit directory names. Those checks still catch
real leaks (`intranet.corp.example`, `INC-12345`, `PROJ-12345`,
`api-key`). A future revision could narrow each label-regex with a
boundary requirement (require the label to be a complete path segment,
not hyphen-joined with descriptive material) so both wins are kept
without false-positives on legitimate directory names. **Not in scope for
this analysis; speculative.**

## Files

- `scripts/probes/bypass-attribution-373.ts` — faithful reimplementation
  of `isLowRiskProjectSlug` and `isLowRiskPathSegment` plus synthetic
  Option 3, 45-case probe set, runs under bun or node.
- Probe invocation: `bun run scripts/probes/bypass-attribution-373.ts`.
