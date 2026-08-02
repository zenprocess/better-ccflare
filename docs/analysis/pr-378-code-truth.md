# Code Truth: tombii/better-ccflare #373 + PR #378

**Status**: analysis only — `packages/proxy/src/project-attribution.ts` is **not** modified by this report, no upstream comment is made.
**Refs**:
- Issue: tombii/better-ccflare #373
- PR: tombii/better-ccflare #378
- Upstream main: `tombii/better-ccflare` @ `2e53e66a` (`chore: add CODEOWNERS …`)
- PR #378 head: `a073df04` (`fix: detect control chars before stripping in workspace-path validation …`)
- Prior security commit on the same file: `c65d7aa6` (`security: validate header-derived project names against isLowRiskProjectSlug`)

Every claim below is marked **CONFIRMED** (with `file:line` against upstream `tombii/better-ccflare` at the ref above) or **UNCERTAIN** (cannot be settled from code alone).

---

## Q1. Full project-attribution chain — every extraction source, in priority order, and what happens when the workspace-path segment is REJECTED

**CONFIRMED**. In PR #378 head (`packages/proxy/src/project-attribution.ts`, function `extractProjectAttribution` declared at `pr-378:326`, body at `pr-378:326-401`):

| # | Source | Source-label returned | Predicate gating the path |
|---|---|---|---|
| 1a | `x-better-ccflare-project` header | `header_project` | `isLowRiskProjectSlug(rawNamespaced)` — `pr-378:336` |
| 1b | legacy `x-project` header | `header_project` | `isLowRiskProjectSlug(rawLegacy)` — `pr-378:347` |
| 2  | `WORKSPACE_PATH_RE` capture in the system prompt | `path_project` | `isLowRiskPathSegment(rawPath)` — `pr-378:368` (new in #378) |
| 3  | first eligible non-Claude H1 heading | `heading_project` | `isLowRiskProjectSlug(rawHeading)` — `pr-378:389` |
| 4  | (none) | `none` | final return — `pr-378:400` |

`WORKSPACE_PATH_RE` itself is unchanged between upstream main and PR #378: `\/(?:Users|home)\/[^/]+\/(?:Desktop|projects|repos|src)\/([^/]+)\/` (`upstream-main:232` ≡ `pr-378:310`). The single-segment capture is therefore a `[^/]+` run.

**What happens when the path segment is REJECTED (`isLowRiskPathSegment(rawPath) === false` at `pr-378:368`):**

The path project block at `pr-378:366-376` is:

```ts
const pathMatch = systemPrompt.match(WORKSPACE_PATH_RE);
const rawPath = pathMatch?.[1];
if (rawPath && isLowRiskPathSegment(rawPath)) {
    const sanitizedPath = sanitizeProjectName(rawPath);
    if (sanitizedPath) {
        return { project: sanitizedPath, projectAttributionSource: "path_project" };
    }
}

// Walk EVERY H1 heading (not just the first) and use the first one that
// is both non-Claude and passes the low-risk slug validator. …
for (const headingMatch of systemPrompt.matchAll(HEADING_RE)) { … }
```

When `isLowRiskPathSegment` returns `false` the entire `if` body is skipped. The function does **not** `return` — execution falls through into the H1 heading loop at `pr-378:383-397`, which itself only `return`s on the first eligible heading. If no H1 heading matches, control reaches `pr-378:400` and returns `{ project: null, projectAttributionSource: "none" }`.

So the rejection terminal states are exactly two:

1. **Fall through to `heading_project`** if any non-Claude, `isLowRiskProjectSlug`-passing H1 heading exists in the system prompt.
2. **Fall through to `none`** otherwise.

**CORROBORATED by an explicit test in the PR diff** — `pr-378:160-169` of `__tests__/project-attribution.test.ts`:

```ts
it("falls through to an eligible H1 heading when the workspace path segment is rejected", () => {
    const headers = new Headers();
    const body = {
        system:
            "/home/will/projects/leaked system prompt fragment with many words/more\n# Harness\nWelcome.",
    };
    const result = extractProjectAttributionFromRequest(headers, body);
    expect(result.project).toBe("Harness");
    expect(result.projectAttributionSource).toBe("heading_project");
});
```

A second test (`pr-378:144-158`) covers the no-valid-heading terminal:

```ts
// path "/home/will/projects/better-ccflare # Some Leaked System Prompt Heading Text/more"
//   (captures "better-ccflare # Some Leaked System Prompt Heading Text" — whitespace + '#' rejected)
expect(result.project).toBeNull();
expect(result.projectAttributionSource).toBe("none");
```

(Note: the second test does **not** assert fall-through to H1 because the `#` in the path does not start a line, so `HEADING_RE` never matches it. The expected terminal is `none`.)

**Tentative assertion "falls through to H1"**: **CONFIRMED**, with the precise qualification that "H1" is the heading loop, and the final terminal is `none` if no heading matches.

---

## Q2. What `isLowRiskProjectSlug` actually enforces, and where it is used

**CONFIRMED**. Defined at `upstream-main:165` ≡ `pr-378:165`. Returns `boolean`. Operates on a control-stripped + trimmed copy of the input; **never length-caps the input** before validation (the comment at `upstream-main:152-155` calls this out — the rule is "reject-wholesale-before-truncating"). The checks, in order:

| # | Predicate (against `cleaned` / `lower`) | Rejects (examples) |
|---|---|---|
| 0 | empty after strip+trim | `""`, `"\x01"` |
| 1 | `lower.includes("://")` or `lower.includes("www.")` or `URI_SCHEME_RE.test(cleaned)` | `https://…`, `WWW.EXAMPLE.COM`, `file:…` |
| 2 | starts with `/` or `\\`, or contains `..` | `/etc/passwd`, `..\..\foo` |
| 3 | `indexOf("@") !== -1 && indexOf(".", atIndex) !== -1` | `me@example.com` |
| 4 | `UUID_RE.test(cleaned)` | `550e8400-e29b-41d4-…` |
| 5 | `DOTTED_HOSTNAME_LABEL_RE.test(cleaned)` | `customer.example.com`, `foo.bar` |
| 6 | any of: `SECRET_TOKEN_RE`, `KNOWN_SECRET_PREFIX_RE`, `MULTI_SEGMENT_TOKEN_RE`, `CREDENTIAL_LABEL_RE`, `lower.includes("bearer ")`, `AWS_KEY_RE`, `IPV4_RE`, `LONG_TOKEN_RE`, `HEX_OPAQUE_TOKEN_RE`, `OPAQUE_MIXED_TOKEN_RE` | `sk_live_…`, `ghp_…`, `api-key-…`, `AKIA…`, `10.0.0.5`, `sess1234567890qwerty`, `deadbeefcafebabe` |
| 7 | `INCIDENT_LABEL_RE.test(cleaned)` or `JIRA_TICKET_RE.test(cleaned)` | `Incident INC-123 Acme`, `PROJ-4821`, `acct-88213` |
| 8 | `cleaned.split(/\s+/).filter(Boolean).length > 6` | free-form 7+ word sentences |
| 9 | `SLUG_SHAPE_RE.test(cleaned)` where `SLUG_SHAPE_RE = /^[\w.][\w .-]{0,63}$/` | anything with `/`, `:`, `>64` chars, leading non-word/dot |

What `isLowRiskProjectSlug` accepts: ordinary repo-name-shaped labels including those with spaces **up to 6 words and ≤ 64 chars** — e.g. `"better-ccflare"`, `"Harness"`, `"My Cool Project"` are all accepted (`pr-378:388-393`).

**Call sites** (every reference in the workspace, plus the upstream source):

| File:line | Purpose |
|---|---|
| `pr-378:336` | `x-better-ccflare-project` header gate |
| `pr-378:347` | `x-project` header gate |
| `pr-378:389` | H1 heading gate |

It is **not** called for the workspace-path branch in PR #378 (that path uses the new `isLowRiskPathSegment`, see Q3). It is exported and also re-used in tests (`packages/proxy/src/__tests__/project-attribution.test.ts:230-539` covers its 11 sub-cases in PR #378).

---

## Q3. Relationship between the `header_project` fix (`c65d7aa6`) and the `path_project` fix (`#378`)

**CONFIRMED** — they are **not** the same validator, they do **not** share an implementation, and they are **deliberately** not interchangeable.

`c65d7aa6` (header fix) wired the existing `isLowRiskProjectSlug` into the two header branches of `extractProjectAttribution`. The diff at that commit ("`37 files changed … security: validate header-derived project names against isLowRiskProjectSlug (fixes #373)`") is +37/-16 on `project-attribution.ts` and no new function is added — the only change is the `if (rawX && isLowRiskProjectSlug(rawX))` guards in front of the existing `sanitizeProjectName` calls. That is why the upstream-main file at `upstream-main:258` and `upstream-main:269` shows both header paths gated by `isLowRiskProjectSlug`.

`#378` (path fix) did **not** reuse `isLowRiskProjectSlug` for the path branch. Round 1 (`2f715272`, "validate workspace-path project names against isLowRisk…") tried to, but round 2 (`1902fe84`, "use a narrower validator for workspace-path segments") split out a brand-new function — `isLowRiskPathSegment` — at `pr-378:253-307`, explicitly because `isLowRiskProjectSlug`'s label-based heuristics false-positive on ordinary directory names (per the doc comment at `pr-378:231-252`):

> `isLowRiskProjectSlug`'s label-based heuristics (CREDENTIAL_LABEL_RE, INCIDENT_LABEL_RE, JIRA_TICKET_RE, DOTTED_HOSTNAME_LABEL_RE) are miscalibrated here: they exist to catch free-text sentences and hostnames, and false-positive on completely ordinary directory names like "password-manager", "customer-portal", "auth-token-service", or "ui.v2".

The new `isLowRiskPathSegment` validator is **NOT** a derived-from / share-implementation-of `isLowRiskProjectSlug` — it is a hand-rolled re-statement of the relevant subset of rules plus the control-char and whitespace rules. Notably:

- It drops the four label-based heuristics (CREDENTIAL_LABEL_RE, INCIDENT_LABEL_RE, JIRA_TICKET_RE, DOTTED_HOSTNAME_LABEL_RE) — `pr-378:253-307` does not import or call any of those regexes.
- It keeps all the secret/UUID/IPv4/long-token checks (the genuinely dangerous ones that can still ride along in a directory name) by re-declaring the imports.
- It rejects control chars **before** stripping them (`pr-378:261`) so a `repo\nleaked-fragment` capture cannot be silently fused into `repoleaked-fragment` (round-3 Greptile review).
- It rejects **any** whitespace (`pr-378:304`) — not the 6-word cap from `isLowRiskProjectSlug` (`upstream-main:224`).

So the two security fixes are **structurally independent** in the PR-378 state: same author, same file, both tighten extraction for untrusted/attacker-influenced input, but the validators diverge on purpose. The round-2 Greptile review literally says "isLowRiskProjectSlug's label-based heuristics … are miscalibrated here", which is the maintainer accepting that the two inputs are not validation-equivalent.

The test at `pr-378:211-233` then pins this divergence: it enumerates five perfectly legitimate directory names (`password-manager`, `customer-portal`, `auth-token-service`, `account-billing`, `ui.v2`) that must be extracted as `path_project` even though `isLowRiskProjectSlug` would reject them.

---

## Q4. Does option 2 (current PR state — reject all whitespace) measurably increase the share of traffic routed through the heading extractor?

**UNCERTAIN from code alone. Cannot be answered from this codebase.**

What the code does establish:

1. **The shape of the shift is known and exactly as the question describes.** In upstream main, `isLowRiskProjectSlug` is **not** applied to the path branch — `path_project` is gated only by `sanitizeProjectName` (control-strip + 64-char cap, see `upstream-main:280-287`). In PR #378 the path branch is gated by `isLowRiskPathSegment` (`pr-378:368`), which has strictly more rejection conditions than `sanitizeProjectName`, and on rejection the code falls through to the H1 heading loop (`pr-378:383`) and then to `none` (`pr-378:400`).

2. **Specifically, the "reject all whitespace" rule is new.** No validator in the path branch in upstream main rejects strings containing spaces; `sanitizeProjectName` deliberately preserves spaces (it only strips `\x00-\x1F\x7F`, see `upstream-main:24`). In PR #378, `isLowRiskPathSegment` rejects any space at all (`pr-378:304`). So a path like `/home/will/Desktop/My Project/file.ts` — which upstream main would attribute as `path_project = "My Project"` — will be rejected in PR #378 and fall through to H1, then `none` if no H1 exists.

3. **The other rejection conditions in `isLowRiskPathSegment` are also new for the path branch** (control chars before strip, opaque token rules, secret/URL/email rules). The combined rejection set is larger than just "spaces."

4. **There is no counter, metric, log, or instrumentation in the proxy codebase that tracks per-source attribution counts.** I searched `packages/proxy/src` for any metric/counter/gauge/histogram/statsd/prometheus-style instrumentation around attribution sources — none. The label `projectAttributionSource` is persisted to the `requests` row (`packages/database/src/repositories/request.repository.ts:18-22` defines a `CASE`-based UPSERT rank for the same column, but only for conflict resolution, not for distribution analytics), and surfaces in the dashboard query layer (`packages/http-api/src/handlers/requests.ts`) but I found no aggregation, no histogram, no log line. I also did not find any usage telemetry shipped from the proxy itself.

5. **No local-fork telemetry either.** The local `zenprocess/better-ccflare` repo at `053746c1` is a *third* state (older than upstream main — header and path paths in our local file use bare `sanitizeProjectName` without `isLowRiskProjectSlug`/`isLowRiskPathSegment`; only the H1 branch uses `isLowRiskProjectSlug`), and even there I find no source-distribution counter.

Therefore: **the code can confirm the structural shift (PR #378 adds a new rejection case for whitespace and several other shapes, and on rejection the request is routed to the heading extractor or to `none`); it cannot confirm the magnitude, because nothing in this codebase measures how many path captures have whitespace, control chars, secret-shaped segments, or other features that would now flip them off the path_project branch and onto the heading_project branch.**

To answer the magnitude question a maintainer would need either (a) a representative sample of real `/Users|/home/…/(Desktop|projects|repos|src)/…` captures from the system prompt corpus to count what fraction carries whitespace or other now-rejected shapes, or (b) a new instrumentation commit that logs `projectAttributionSource` per request to a place that can be aggregated. Neither is present.

---

## Sourcing notes

- `upstream-main` ref was fetched with `git fetch upstream main` and inspected via `git show upstream/main:packages/proxy/src/project-attribution.ts`.
- `pr-378` ref was fetched with `git fetch upstream pull/378/head:pr-378` and inspected via `git show pr-378:packages/proxy/src/project-attribution.ts` and `…/__tests__/project-attribution.test.ts`.
- Local comparison confirmed the local file is **not** a clean mirror of either upstream state — header and path paths in the local file use bare `sanitizeProjectName` and are therefore behind both `c65d7aa6` and PR #378. The local state is **not** part of the answer above; the question is about upstream main and PR #378 head.
- Round-1 / round-2 / round-3 PR #378 commits visible in upstream history: `2f715272` (initial, used `isLowRiskProjectSlug`), `1902fe84` (split out `isLowRiskPathSegment`), `b2810b37` (added the any-whitespace rule), `a073df04` (control-char-before-strip, current PR head).
