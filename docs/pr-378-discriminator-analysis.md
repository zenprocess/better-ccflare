# PR #378: Is word-count the right discriminator?

**Task:** analysis only, no code changes, no upstream comment.
**Scope:** the workspace-path path of project attribution, where the
discriminator has to choose between a legitimate directory name (`MyProj`)
and a leaked prose fragment (`repo short words`).
**Read first:** the actual file at
`packages/proxy/src/project-attribution.ts` (PR #378 head `a073df04`,
already merged to `upstream/main`) and the test file
`packages/proxy/src/__tests__/project-attribution.test.ts`. Numbers,
function names, and test cases below all come from those files, not from
paraphrase.

---

## TL;DR (the useful answer)

- **For path segments: no, word-count is the wrong discriminator.**
  Both classes land in the 1–3-word range, and the real signal is that a
  path segment structurally cannot contain whitespace, control characters,
  or `#` (those are the very separators that demarcate a segment).
  Detecting "this is too many words" is a downstream proxy for the
  property you actually want.
- **A simpler Option 4 exists:** tighten `WORKSPACE_PATH_RE`'s capture
  class to `[^/\s\x00-\x1F\x7F#]+`. The leak becomes impossible at the
  source, and the dedicated `isLowRiskPathSegment` validator (and its
  Round-2/3 hardening) can be dropped entirely.
- **For H1 headings: word-count is acceptable.** H1 captures are
  bounded by `[^\n\r]{1,100}` in `HEADING_RE`, and the only way an
  `isLowRiskProjectSlug` candidate gets to 7+ words inside that 100-char
  window is when it's leaked prose. The 6-word cap is a coarse but
  defensible heuristic on a path that already has hard structural
  constraints.
- **A cleaner architectural answer: prefer the
  `x-better-ccflare-project` header.** Inference from the system prompt
  is, by construction, inferring from attacker-influenced text. The
  current code already supports the header path; the real fix is a
  product/SDK decision (client opt-in), not a regex tweak.
- **The current state of the PR is correct.** The three rounds of
  review-fix on `isLowRiskPathSegment` (Round 1: narrower validator;
  Round 2: reject any whitespace; Round 3: detect control chars before
  stripping) close the leak. The question this analysis answers is
  *whether a different design would have been cleaner* — yes, but the
  shipped code is sound.

---

## What the leak actually looked like

Issue #373 (the report that motivated PR #378) shows the symptom on
`/api/insights/anomalies`:

```
len=64 | <project-a>## <system-prompt text — redacted>
len=64 | <project-b>## <system-prompt text — redacted>
len=64 | <project-c>## <system-prompt text — redacted>
```

Three independent signals here, all consistent:

1. **Every value is exactly 64 characters long.** `PROJECT_NAME_MAX_LEN
   = 64` in `project-attribution.ts:21` and the pre-PR `sanitizeProjectName`
   truncated rather than rejected (`project-attribution.ts:26–27`).
   Truncation is what deleted the very separator that would have made
   the leaked half readable as a second word.
2. **The leading token is the correct project name.** The capture
   began with the real `WORKSPACE_PATH_RE` match (e.g.
   `/Users/will/projects/<realname>`), and the regex's `[^/]+` greedily
   ran on past the real directory boundary into following text.
3. **Each captured value was exactly six whitespace-separated tokens.**
   The reporter explicitly notes this — and the pre-PR `isLowRiskProjectSlug`
   already rejected `>6` words at line `:224` (now `:230` after the
   PR). The truncation at 64 chars had the side effect of bringing the
   word count under the threshold for many captures. Fixing the leak by
   detecting "too many words" therefore under-protects whenever the
   truncated form happens to be ≤ 6 words — and a one-word or
   three-word leak is **invisible** to that heuristic. Which is
   exactly the class ("repo short words") the task description calls
   out.

The reporter's hypothesis ("truncation is what brings the token count
under the threshold") is correct, and the consequence is sharp: a
post-hoc word-count check is the wrong place to enforce this constraint,
because the very operation that creates the leak (truncation) is the
operation that suppresses the word-count signal.

## What the three review rounds actually changed

`git log upstream/main..pr-378 --stat` shows four commits, the first
introducing validators and the next three hardening them:

- `2f715272` (Round 0 / initial PR): added `isLowRiskProjectSlug` and
  routed the path segment through it. The path-segment capture was
  validated using the same word-count + shape rules as headings.
- `1902fe84` (Round 1 review fix): introduced `isLowRiskPathSegment`,
  a *narrower* validator that drops the label-based denylists
  (`CREDENTIAL_LABEL_RE`, `INCIDENT_LABEL_RE`, `JIRA_TICKET_RE`,
  `DOTTED_HOSTNAME_LABEL_RE`) because they false-positived on legitimate
  directory names like `password-manager`, `customer-portal`,
  `auth-token-service`, `account-billing`, `ui.v2` (see
  `__tests__/project-attribution.test.ts:208–221` and the
  `legitDirNames` table at `:205`). Kept the 6-word cap and the slug
  shape.
- `b2810b37` (Round 2 Greptile fix): the 6-word cap proved insufficient
  for short leaks. Switched the path-segment validator to **reject any
  whitespace at all** (`/\s/.test(cleaned) → false`). Test
  `it("rejects a short space-separated run-on rather than persisting
  it as the project (round-2 Greptile review on #378)"` at
  `:191–201` is the failing case that motivated this.
- `a073df04` (Round 3 Greptile fix): even with no-whitespace-allowed,
  `sanitizeProjectName`'s strip-then-check order silently fused
  `"repo\nleaked-fragment"` into `"repoleaked-fragment"`, hiding the
  leak. **Detect control chars in the raw value, before any
  stripping**, and reject if present. Test
  `it("rejects a path segment where a control char fuses the real
  directory with leaked text (round-3 Greptile review on #378)"`
  at `:202–217` is the failing case.

All three rounds are post-hoc validation around the same anchor: a
greedy regex capture that's allowed to over-capture into attacker text
and is then triaged after the fact.

## Why "word count" is the wrong discriminator for path segments

The task framing is precise: both the legitimate and the leaked class
land in the 1–3 word range, and there is no word count that separates
them. "My Project" and "repo short words" both have 2 words; "Harness"
and "Q1" both have 1. The discriminator has to come from somewhere
else.

The "somewhere else" that does the work is actually visible in the test
suite: every legit path-segment test uses a slug-shaped name with **no
whitespace, no control characters, and no `#`**:

```
["password-manager", "password-manager"],
["customer-portal", "customer-portal"],
["auth-token-service", "auth-token-service"],
["account-billing", "account-billing"],
["ui.v2", "ui.v2"],
```

And the failing cases are exactly the ones that introduce one of
those characters: a literal space, a `\n`/`\t`/`\r`, or a `#`. So
the real signal isn't "too many words" — it's **"this string contains
any character that cannot appear in a path segment."** The
Round-2/3 implementation arrives at this realization through
incremental hardening; the structural answer is to put the constraint
in the regex itself.

## Option 4: tighten the regex, drop the validator

The structural fix is to encode the segment character class directly
in `WORKSPACE_PATH_RE`:

```ts
// Before (a073df04:231)
const WORKSPACE_PATH_RE =
    /\/(?:Users|home)\/[^/]+\/(?:Desktop|projects|repos|src)\/([^/]+)\//;

// After (proposed)
const WORKSPACE_PATH_RE =
    /\/(?:Users|home)\/[^/]+\/(?:Desktop|projects|repos|src)\/([^/\s\x00-\x1F\x7F#]+)\//;
```

With this change, the capture group `[^/\s\x00-\x1F\x7F#]+` will
simply not match strings that contain any of the leak vectors. The
captured group, by construction, is a valid segment, and there is
nothing to validate. The Round-1/2/3 machinery (`isLowRiskPathSegment`,
the pre-strip control-char check, the 6-word cap on this branch) can
go away.

Cost and risk:

- **Code is simpler.** One line in one regex. The 3-round validator
  (`isLowRiskPathSegment` + its control-char pre-check + its
  whitespace rejection) is roughly 50 lines of code that exists only
  to defend against what the regex tightening makes impossible.
- **Equivalent expressiveness for the legit case.** Real directory
  names on Unix allow almost anything except `/` and NUL, but in
  practice they are dash-/underscore-/dot-separated alnum tokens
  (the only classes the test suite enumerates). The PR's
  Round-2 docstring (`isLowRiskPathSegment`'s header comment) already
  states the design intent: "a real directory name is never
  space-separated."
- **One real behavior change.** A directory literally named with a
  space (e.g. `~/projects/My Project/`) is **rejected** under the
  tightened regex, whereas pre-PR `[^/]+` would have captured it and
  the original `sanitizeProjectName` would have kept it. Under the
  current `a073df04` state, it is also rejected (`isLowRiskPathSegment`
  rejects any whitespace). So Option 4 preserves the current behavior
  for the boundary case and only diverges from the pre-PR leak.
- **Doesn't help the H1 path.** H1 captures are bounded by
  `[^\n\r]{1,100}` already, and prose leaking into an H1 has to
  bypass `SLUG_SHAPE_RE`'s `[^#\n\r]` and the 6-word cap. That's a
  different problem with a different (acceptable) heuristic.

If Option 4 is too aggressive — if "My Project" as a directory name
is a deployment that has to keep working — the conservative narrowing
is just `[^/\s\x00-\x1F\x7F]+` (drop the `#` from the excluded
class). The leak paths that mattered in #373 all contain `#` or
whitespace, and the post-PR state is already more restrictive than
that. The point isn't which subset to exclude; the point is that
**the regex should exclude something, and currently doesn't**.

## What about "have the client send the project name"?

The task explicitly raises this. The codebase already supports it
via `x-better-ccflare-project` (precedence order in
`extractProjectAttribution`, `project-attribution.ts:240–280`):

1. `x-better-ccflare-project` header
2. legacy `x-project` header
3. workspace path in system prompt
4. first eligible H1 in system prompt
5. no project

So the answer to "can the client supply the project name explicitly
instead of it being inferred?" is "yes, and the code already does
that — for clients that opt in." The path-extraction code paths
(2-3) are the *fallback* for clients that haven't opted in. The
real architectural answer is product-level: shift clients toward the
header path, and the system-prompt inference becomes best-effort
attribution rather than the security boundary. That's the cleanest
fix of all, but it lives outside this PR.

A similar flag at the client level ("`x-better-ccflare-project` is
required when running against an untrusted upstream, optional
otherwise") is what would actually make the leak path unreachable.
PR #378 doesn't address that, and shouldn't — it's a coordination
problem across the Claude Code / ccflare boundary, not a code-level
issue.

## A note on the H1 path: word count is OK there, by accident

The 6-word cap in `isLowRiskProjectSlug`
(`project-attribution.ts:230`) is a heuristic that I would not
propose to apply to path segments — but it is a defensible
heuristic on the H1 path, for two reasons:

1. H1 captures are bounded by `[^\n\r]{1,100}` in `HEADING_RE`. To
   even reach `isLowRiskProjectSlug`, the captured heading has to
   pass the 100-char cap, contain no `\n`/`\r`, and contain no
   `#` (via `SLUG_SHAPE_RE`). The 6-word cap is the *last* line of
   defense; the structural constraints already do most of the work.
2. The legitimate H1 cases tested (`Harness`, `attribution-source-tags`,
   `My Cool Project`) are 1–3 words; the leak cases tested (sentence /
   incident / etc.) are 7+ words. The 6-word threshold cleanly
   separates them in the test suite, and the test suite is the
   surrogate for "what real Claude Code / system-prompt prose looks
   like."

That's not a guarantee — a legitimate 7-word H1 would be rejected
— but it's an acceptable error mode, and the alternative (allow
arbitrarily long H1 captures) is the leak that #373 was about.

## Costs and risks of the three shipped options (for comparison)

Each of the three rounds adds code that exists only to detect what
the regex already had the power to prevent:

- **Round 1 (narrower validator):** ~50 lines of
  `isLowRiskPathSegment`, plus a parallel test suite. The validator
  is necessary *only* because the regex captured invalid input.
- **Round 2 (reject any whitespace):** one extra line in
  `isLowRiskPathSegment` and one new test case. Same root cause.
- **Round 3 (detect control chars before strip):** one extra line
  + one new test case. The whole reason this is needed is that
  `sanitizeProjectName` strips control chars, and the regex doesn't
  exclude them, so the capture can contain a control char that
  *survives* the strip by being fused into a single token.

If the regex excluded those characters, none of these rounds would
have been needed, and the failure modes that motivated them
(`"repo short words"` slipping through the 6-word cap, the
`"repoleaked-fragment"` fusion) would have been impossible at the
source rather than detected after the fact.

## Recommendation

If a future revision of this code path comes up, the structural
fix is to tighten `WORKSPACE_PATH_RE`'s character class and remove
`isLowRiskPathSegment` (and its associated tests) entirely. The
H1 path stays as it is.

If a higher-stakes change is on the table, the priority is
client-side: have Claude Code (or whatever client) send
`x-better-ccflare-project` by default, demoting the system-prompt
inference to a fallback. That is a much larger blast radius than
this PR and is out of scope here.

**For the question this analysis was asked to answer: yes, a
better discriminator exists. It is the regex character class
itself, and it is simpler than the three post-hoc rounds of
validation the PR shipped.** The current code is correct; the
recommended form is just less code.
