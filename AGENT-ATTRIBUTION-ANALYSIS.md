# Agent Attribution Analysis — Task A

**Branch:** `analysis/agent-attribution`
**Date:** 2026-07-28
**Scope:** Why `agentAttributionSource` is `none` on every sampled ccmax request
while `projectAttributionSource` populates. Analysis only — no code changes, no
config edits, no PR, no push.

All file:line references are to **`upstream/main`** unless otherwise stated
(`origin/feat/x-anthropic-agent-id-header` or `origin/zenprocess-deploy`).
Branches were fetched and inspected via `git show <ref>:<path>`; the assigned
worktree could not check out `upstream/main` directly because the sandbox
disallows creating `.claude/agents/` in the working tree, so all references are
read from git objects rather than the working tree.

---

## TL;DR (headline answer)

1. **`agentAttributionSource` is populated by exactly three values**:
   `"header_agent" | "prompt_agent" | "none"` (type defined at
   `packages/types/src/request.ts:7`).
2. **The exact header upstream reads today**:
   - **Preferred (namespaced):** `x-better-ccflare-agent-id`
   - **Fallback (legacy):** `x-anthropic-agent-id`
   Both are read by `interceptAndModifyRequest` at
   `packages/proxy/src/handlers/agent-interceptor.ts:99-101`. The namespaced
   header takes precedence when both are present; both are trimmed and capped
   at 256 chars.
3. **`origin/feat/x-anthropic-agent-id-header` is the SAME mechanism, now
   older/incomplete.** It introduced the legacy `x-anthropic-agent-id` header
   only (commit `f42a9325`, 2026-06-19). The namespaced
   `x-better-ccflare-agent-id` header, the `AgentAttributionSource` type, the
   per-return-path source labels, and the `agent_attribution_source` DB column
   were all added by commit `b5099129` ("attribution source tags", 2026-07-11),
   which is **not** on that branch — it is on `upstream/main`. So the
   feat-branch is upstream's ancestor for the header mechanism, but it predates
   the source tagging that makes `agentAttributionSource` distinct from
   `agentUsed`.
4. **The feature does NOT exist at all in `origin/zenprocess-deploy`** (HEAD
   `b2c8688e`, dated 2026-05-06). Verified:
   - `AgentAttributionSource` type: zero references
   - `agentAttributionSource` field name: zero references
   - `agent_attribution_source` DB column: zero references
   - `x-better-ccflare-agent-id` header: zero references
   - `x-anthropic-agent-id` header: zero references
   That branch has the legacy `agent_used` column and the
   `agent-interceptor.ts` system-prompt detection path, but it does NOT
   categorize *how* an agent was attributed, and it does NOT read any
   attribution header. **Even if every client started sending
   `x-better-ccflare-agent-id` today, ccmax running that codebase cannot
   populate the field — the code path that reads the header and labels the
   source does not exist.** This converts the situation from a config/header
   fix into an **upgrade requirement**.
5. **Why project attribution populates but agent does not, today.** Project
   attribution has THREE sources that work passively from a Claude Code
   system prompt: explicit `x-better-ccflare-project` /
   `x-project` header, workspace-path regex
   (`/(?:Users|home)/[^/]+/(?:Desktop|projects|repos|src)/([^/]+)/`), and a
   first-eligible non-Claude H1 heading. Claude Code's system prompt almost
   always contains a workspace path, so `path_project` fires for free. Agent
   attribution's only passive source is `prompt_agent`, which requires the
   system prompt to match a content-registered agent file via
   `agentRegistry.findAgentByPrompt` — and Claude Code's system prompt only
   contains an agent's content when the user has inlined it into CLAUDE.md or
   similar. So `prompt_agent` is essentially never fired by Claude Code's
   default request shape. The header path (`header_agent`) is the only
   practical mechanism and requires client cooperation.

---

## 1. What populates `agentAttributionSource`

### 1.1 The type and the field

`packages/types/src/request.ts:1-7`:

```ts
export type ProjectAttributionSource =
  | "header_project"
  | "path_project"
  | "heading_project"
  | "none";

export type AgentAttributionSource = "header_agent" | "prompt_agent" | "none";
```

The `Request` and `RequestResponse` domain objects include
`agentAttributionSource?: AgentAttributionSource`
(`packages/types/src/request.ts:74`, `:111`, `:140`); the row mapper casts
DB column → type at `:206`.

### 1.2 The four return paths that set the source

All four are inside
`interceptAndModifyRequest` (`packages/proxy/src/handlers/agent-interceptor.ts`):

| # | Line | Trigger condition                                  | Source value   |
|---|------|----------------------------------------------------|----------------|
| 1 | 75   | No request body buffer                             | `"none"`       |
| 2 | 134  | `x-better-ccflare-agent-id` or `x-anthropic-agent-id` header present (after preference check, regardless of rewrite outcome) | `"header_agent"` |
| 3 | 151  | Header absent, no system prompt extractable        | `"none"`       |
| 4 | 209  | Header absent, no agent match via registry          | `"none"`       |
| 5 | 243  | Header absent, system-prompt detected an agent, but preference absent or matches original model (no rewrite) | `"prompt_agent"` |
| 6 | 257  | Header absent, system-prompt detected an agent, preference differs, but model not servable (catalog veto) | `"prompt_agent"` |
| 7 | 266  | Header absent, system-prompt detected an agent, preference rewritten     | `"prompt_agent"` |
| 8 | 277  | Parse/extract failure (catch)                      | `"none"`       |

(One source label per return; the three "none" labels for header-absent paths
collapse to the same value.)

### 1.3 How the source reaches the database

`packages/proxy/src/proxy.ts:231` sets
`requestMeta.agentAttributionSource = agentAttributionSource;` from the
interceptor's return value, then `packages/proxy/src/handlers/proxy-operations.ts`
forwards it on every direct save site (`:498`, `:816`, `:928`, `:997`, `:1140`,
`:1307`, `:1337`). The async usage worker (post-processor) carries it via the
`StartMessage`/`Summary` payload. `packages/database/src/repositories/request.repository.ts:224`
maps `data.agentAttributionSource || null` into the `agent_attribution_source`
column. The HTTP API rehydrates it from `agent_attribution_source` and casts
back to the typed enum (`packages/http-api/src/handlers/requests.ts:118-119`).

The migration that adds the column lives in
`packages/database/src/migrations.ts` (init table definition
`agent_attribution_source TEXT` plus an idempotent ALTER TABLE block) and
parity for PostgreSQL in `migrations-pg.ts`.

---

## 2. The exact header/field upstream expects a client to send

**The header (preferred, vendor-neutral, upstream-current):**

```
x-better-ccflare-agent-id: <agent-id>
```

**The legacy alias (still honored when the namespaced one is absent):**

```
x-anthropic-agent-id: <agent-id>
```

Both are read at `packages/proxy/src/handlers/agent-interceptor.ts:99-101`:

```ts
const explicitAgentId =
  requestHeaders?.get("x-better-ccflare-agent-id")?.trim()?.slice(0, 256) ||
  requestHeaders?.get("x-anthropic-agent-id")?.trim()?.slice(0, 256);
```

Concrete semantics (from the test suite at
`packages/proxy/src/handlers/__tests__/agent-interceptor.header.test.ts`):

- Header lookup is case-insensitive (the `Headers` API lowercases keys): both
  `X-Anthropic-Agent-Id: foo` and `x-better-ccflare-agent-id: foo` resolve.
- The namespaced header wins deterministically when both are present.
- Leading/trailing whitespace is trimmed.
- The value is capped at 256 characters (`slice(0, 256)`).
- An empty value (after trim) falls through to the system-prompt path.
- Once the header is present, the path returns `agentAttributionSource: "header_agent"`
  regardless of whether a model rewrite happens (preference absent, preference
  matches original, catalog veto all still set `"header_agent"`). This is
  important for observability — every request tagged with the header is
  attributable, even if no model substitution occurs.

### 2.1 Comparing `origin/feat/x-anthropic-agent-id-header` to what upstream reads today

The branch is at `40ec1095` (the review commit "honor model preferences on
header path + cap agent-id at 256 chars"), whose parent is the original
feature commit `f42a9325` ("feat(proxy): optional X-Anthropic-Agent-Id header
for explicit agent attribution", 2026-06-19).

What that branch introduced vs. what upstream reads today:

| Feature                                | feat/x-anthropic-agent-id-header | upstream/main today            |
|----------------------------------------|----------------------------------|--------------------------------|
| Read `x-anthropic-agent-id`            | Yes                              | Yes (as legacy alias)          |
| Read `x-better-ccflare-agent-id`       | **No**                           | **Yes (preferred)**            |
| Cap agent id at 256 chars              | Yes (added in `40ec1095`)        | Yes                            |
| Honor DB model preference on header    | Yes (added in `40ec1095`)        | Yes                            |
| Trim whitespace                        | Yes                              | Yes                            |
| `AgentAttributionSource` enum          | **No**                           | **Yes**                        |
| `agentAttributionSource` return field  | **No**                           | **Yes**                        |
| `agent_attribution_source` DB column   | **No**                           | **Yes**                        |
| Source labels threaded to DB           | **No**                           | **Yes**                        |

**Verdict:** same mechanism, older/incomplete. The branch is the historical
provenance of the feature (it landed the legacy header) but upstream has
extended it in two ways the branch lacks:

1. The namespaced alias `x-better-ccflare-agent-id` was added in commit
   `b5099129` (2026-07-11, "feat(proxy): attribution source tags for project/agent
   identification"). Verified:
   `git log --all -S 'x-better-ccflare-agent-id' --oneline` returns only
   `b5099129` (plus branch-indexing commits on local checkouts), and
   `git merge-base --is-ancestor b5099129 origin/feat/x-anthropic-agent-id-header`
   is **false**.
2. The source-tagging infrastructure (type, return field, DB column, source
   labels, threaded propagation) was introduced in the same commit `b5099129`,
   not on the feat-branch.

So if a client sends only the legacy `x-anthropic-agent-id` header, **it still
populates agent attribution on upstream/main** (it's honored as a fallback).
The feat-branch is a strict subset of upstream's read logic — not unrelated.

---

## 3. Why project attribution populates while agent does not

The asymmetry comes from the asymmetry in *passive* sources between the two
features.

### 3.1 Project attribution — three sources that work for free from a Claude Code system prompt

`packages/proxy/src/project-attribution.ts:240-303` defines
`extractProjectAttribution` with this precedence:

1. Header `x-better-ccflare-project` (namespaced) → `"header_project"`
2. Header `x-project` (legacy) → `"header_project"`
3. Workspace-path regex on system prompt
   (`WORKSPACE_PATH_RE = /\/(?:Users|home)\/[^/]+\/(?:Desktop|projects|repos|src)\/([^/]+)\//`)
   → `"path_project"`
4. First eligible non-Claude H1 heading in system prompt → `"heading_project"`
5. None → `"none"`

Crucially, sources 3 and 4 require **no client cooperation**. Claude Code's
system prompt almost always contains a workspace path (as part of "Contents of
/Users/<user>/projects/<repo>/CLAUDE.md ..." or similar context the CLI
injects), so `path_project` fires passively for almost every request that
isn't an API direct hit. ccmax observes `projectAttributionSource` populating
because Claude Code — without any code change — gives ccflare a system prompt
that matches source 3.

### 3.2 Agent attribution — only ONE source that works without client cooperation

`packages/proxy/src/handlers/agent-interceptor.ts:148-209` shows the
header-absent path:

- Extract the system prompt.
- Call `agentRegistry.findAgentByPrompt(systemPrompt)` (delegating to the
  registry's own matcher).
- If no match → `"none"`.

The registry's matcher (in `packages/agents/src/discovery.ts`) matches the
system prompt against the bodies of registered agent markdown files
(`.claude/agents/*.md`). For a match, the request's system prompt must
contain the literal text of an agent file's content block. Claude Code does
not inline agent definitions into the system prompt by default; it loads
them only via the Task tool when spawning a sub-agent. So `prompt_agent`
essentially never fires from a vanilla Claude Code request — it requires
the operator to have arranged for an agent's content to land in the system
prompt (typically by pasting it into CLAUDE.md or a similar context-bearing
file), which is operationally fragile and not what Claude Code "just does".

The header path (`header_agent`) is the only mechanism that gives the
client deterministic control. Without explicit header cooperation,
`agentAttributionSource` will be `none` (or `prompt_agent` in narrow
configurations). Without a header, the asymmetry between project and
agent attribution is structural, not a bug.

---

## 4. Is the feature present in `origin/zenprocess-deploy`? — **NO**

**This is the headline answer the spec asked for.** All five searches against
`origin/zenprocess-deploy` (HEAD `b2c8688e`, dated **2026-05-06**) return
**zero hits**:

```text
$ git grep -l 'AgentAttributionSource|agentAttributionSource|
                agent_attribution_source|x-anthropic-agent-id|
                x-better-ccflare-agent-id' origin/zenprocess-deploy -- '*.ts' '*.md'
(no output)

$ git grep -n 'agent_attribution_source|agentAttributionSource' origin/zenprocess-deploy
(no output)

$ git show origin/zenprocess-deploy:packages/database/src/migrations.ts | grep attribution
(no output)

$ git show origin/zenprocess-deploy:packages/proxy/src/handlers/agent-interceptor.ts | wc -l
418
$ git show upstream/main:packages/proxy/src/handlers/agent-interceptor.ts | wc -l
543
```

That branch DOES have `agent-interceptor.ts` (418 lines vs. upstream's 543) and
DOES have the `agent_used` column, and DOES detect agents via system-prompt
matching for purposes of model preference substitution. It does NOT:

- Define an `AgentAttributionSource` type (no enum, no DB column, no field).
- Read `x-anthropic-agent-id` OR `x-better-ccflare-agent-id` from request
  headers (the interceptor signature on zenprocess-deploy takes only
  `(requestBody, dbOps)` — there is no `requestHeaders` parameter; confirmed
  by reading
  `git show origin/zenprocess-deploy:packages/proxy/src/handlers/agent-interceptor.ts`
  lines 30-44).
- Categorize how an agent was attributed.

**Consequence for ccmax:**

The platform-side observation is that ccmax reports `agentAttributionSource=none`
on every sampled request. If ccmax is running `origin/zenprocess-deploy` (or a
strict descendant that hasn't cherry-picked the attribution-source
infrastructure), there are exactly two possibilities for why the field appears
in API responses at all:

1. ccmax is on a fork that has cherry-picked commit `b5099129` (the migration
   + the typed field + the column) but **not** the runtime code path that
   actually classifies source — leaving the field always populated with the
   default `"none"` at every return path.
2. ccmax is on a build that pre-populates the column with `"none"` on insert
   (e.g. the migration default), and no write path updates it.

Either way, the code-side observation is the same: **even if every client
started sending `x-better-ccflare-agent-id` (or the legacy
`x-anthropic-agent-id`) today, ccmax running a build without
`b5099129`-equivalent code cannot populate the field**, because the runtime
header-reading branch doesn't exist in that codebase.

**This converts the situation from a config/header fix into an upgrade
requirement.** There is no client-side change that will make
`agentAttributionSource` populate on ccmax if ccmax is running something
close to `origin/zenprocess-deploy`.

### 4.1 Evidence the orchestrator's "inference, not confirmed" qualifier applies here too

The orchestrator's shared-context note already flags that ccmax's
`rateLimitStatus` / `sessionInfo` shape (string vs object) and
`lb_strategy=least-used` are *circumstantial* evidence it runs something
close to zenprocess-deploy, **not confirmed**. The same uncertainty applies
to the agent-attribution question: it is consistent with "ccmax runs
zenprocess-deploy plus a partial cherry-pick of `b5099129`" or with "ccmax
runs a different newer build that hasn't wired the header path yet". Both
explain the same observation. **Confirming which requires host access**
(SSH/curl to ccmax.zp.digital — out of bounds per the shared context) or a
binary/build-version dump from the operator.

---

## 5. What would a client (Claude Code or fleet) need to change

**Upstream behavior expected today (in ccflare-main builds that include
`b5099129` or later):**

To populate `agentAttributionSource` for a Claude Code request, the client
(or a ccflare-side wrapper) must add ONE header to outbound `/v1/messages`
requests:

```
x-better-ccflare-agent-id: <agent-id>
```

The value should be a stable identifier (UUID/slug), trimmed, ≤256 chars.
If the namespaced header is undesirable for any reason (e.g. clients that
already send `x-anthropic-agent-id` from older code), the legacy alias is
honored on upstream, but new clients should prefer the namespaced header —
it is the documented contract going forward.

**For the Claude Code client specifically (most likely first-party
candidate):**

Claude Code would need to set the header in its outgoing HTTP requests
during/after a Task/sub-agent dispatch, keyed off the spawned agent's id.
The header is currently NOT sent by Claude Code at the time of this
analysis (no upstream ccflare code or Claude Code client code we surveyed
sets it). On the ccflare side, no further config is required — receiving
the header and threading the source is wired end-to-end (`proxy.ts:231` →
`proxy-operations.ts` → usage worker → `request.repository.ts:224` →
HTTP API rehydration at `handlers/requests.ts:118-119` → dashboard).

**For the fleet (multi-agent orchestrators, routers, SDK wrappers) — the
exact use case the original commit's docstring calls out
(`f42a9325`):**

Set `x-better-ccflare-agent-id` per request from whatever identity the
fleet already maintains for the issuing agent. No fleet-side schema change
is required; the header is opaque to ccflare's parser apart from being a
non-empty trimmed ≤256-char string. Operators who want a specific agent to
also receive a model preference can additionally set the preference in
the dashboard (DB row in `agent_preferences` keyed by the same id) — that
is the only place where the header value becomes load-bearing for behavior,
not just attribution.

### 5.1 Caveat that converts this from "ship the header" into "upgrade first"

If ccmax runs `origin/zenprocess-deploy` (or anything that hasn't cherry-
picked `b5099129`), shipping the header from the fleet will not change
`agentAttributionSource` on ccmax. **The fleet-side change is a
prerequisite**, not a fix. The operator must first confirm ccmax is on a
build that includes the attribution-source infrastructure before expecting
the field to populate. Two operator-side artifacts that would settle this
without a sandbox-violating probe:

- A ccmax binary/build version string (look for a `X-Build-Sha` response
  header, a `/version` endpoint, or the process banner at startup).
- A direct query against the ccmax `requests` table to see whether the
  `agent_attribution_source` column exists. If it exists but is always
  `none`, the column-side cherry-pick happened but the runtime code path
  didn't — an internal upgrade is required.

If the column doesn't exist at all, ccmax is genuinely on a build without
the feature, and the entire attribution-source subsystem must land
(including a schema migration). That is unambiguously an upgrade, not a
config change.

---

## Appendix A — Branch comparison summary

| Ref                              | HEAD      | Date       | agentAttributionSource? | Header read?                          |
|----------------------------------|-----------|------------|--------------------------|---------------------------------------|
| `upstream/main`                  | `053746c1` | recent    | Yes (full feature)       | `x-better-ccflare-agent-id` + legacy |
| `origin/feat/x-anthropic-agent-id-header` | `40ec1095` | older | No (partial — just the legacy header, no source tagging) | Only `x-anthropic-agent-id` |
| `origin/zenprocess-deploy`       | `b2c8688e` | 2026-05-06 | **No** (column, type, and read path all absent) | **None**                              |

## Appendix B — Pointers for follow-up

- Confirmed-via-`git show` (no working-tree checkouts needed):
  - `upstream/main:packages/proxy/src/handlers/agent-interceptor.ts` (543 lines)
  - `upstream/main:packages/proxy/src/project-attribution.ts` (336 lines)
  - `upstream/main:packages/types/src/request.ts` (line 7: type definition)
  - `upstream/main:packages/database/src/migrations.ts` (column add)
  - `upstream/main:packages/proxy/src/handlers/__tests__/agent-interceptor.header.test.ts`
    (header semantics test cases)
- Commits of interest:
  - `f42a9325` — original `x-anthropic-agent-id` header introduction (in
    origin/feat/x-anthropic-agent-id-header).
  - `40ec1095` — review: cap agent-id at 256 chars + honor preferences
    on header path (in origin/feat/x-anthropic-agent-id-header).
  - `b5099129` — attribution source tags (adds the namespaced header,
    the type, the field, the column, and the source labels). **Not in
    feat/x-anthropic-agent-id-header, not in zenprocess-deploy.**
  - `a584070a` — fix(proxy): propagate attribution sources on
    extra_usage_exhausted (consistency fix).

## Appendix C — What this analysis did NOT establish

- Whether ccmax is on `origin/zenprocess-deploy` itself or a partial
  cherry-pick thereof. This is undecidable from code alone — requires a
  build/version artifact from the ccmax deployment.
- Whether ccmax's API endpoint normalizes unknown/null columns to the
  string `"none"` (which would also explain a populated-but-always-none
  field). Possible but unverified.
- Whether Claude Code sends either header today. The ccflare codebase
  contains the receiver but no evidence Claude Code's own HTTP layer
  attaches it; the most parsimonious reading is "no, not by default."

These are all host-side or vendor-side facts and would require evidence
from ccmax/Claude Code to settle.