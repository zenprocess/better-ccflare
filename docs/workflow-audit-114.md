# Workflow audit — issue #114

**Repo:** `zenprocess/better-ccflare` (public fork of `tombii/better-ccflare`)
**Goal:** rule once on every inherited GitHub Actions workflow and enforce the ruling mechanically, so future merges from upstream do not silently re-arm anything we already decided not to run.

**Priority lens (per the issue):** this fork is public and has already had a disclosure incident — 16 issues exposing internal infrastructure had to be deleted and the Issues tab was disabled. A workflow that posts generated content to a public repo is a disclosure vector; a publish/release workflow firing from a fork is worse.

**Method:** read every YAML end-to-end (no inference from filename), read both shell scripts, enumerate recent runs on the fork via the GitHub API, then classify and implement.

---

## 1. Inventory on the fork at audit time

### Workflows (`/.github/workflows/`)

| File | Lines | Last upstream sync |
|------|-------|--------------------|
| `auto-rerun-failed.yml` | 107 | inherited verbatim |
| `claude-code-review.yml` | 46 | inherited verbatim |
| `claude.yml` | 52 | inherited verbatim |
| `docker-publish.yml` | 117 | inherited verbatim |
| `issue-triage.yml` | 34 | inherited verbatim |
| `pr-review.yml` | 90 | inherited verbatim |
| `release-dispatch.yml` | 101 | inherited verbatim |
| `release.yml` | 372 | fork-modified (commit `218f41c9 improve: thank merged-PR contributors...`) |
| `signpath-test.yml` | 60 | inherited verbatim |

> Note: `.forgejo/workflows/gate.yml` and `.forgejo/workflows/mirror-main.yml`
> mentioned in the issue brief are **not present** in the tree. Nothing to
> rule on. If they reappear on a future merge, treat them as "NEEDS-DECISION"
> and re-audit.

### Scripts (`/.github/scripts/`)

| File | Lines | Last upstream sync |
|------|-------|--------------------|
| `issue-triage.sh` | 475 | inherited verbatim |
| `pr-review.sh` | 537 | inherited verbatim |

### Repo configuration (from `gh api`)

| Setting | Value |
|---------|-------|
| Default branch | `main` |
| Visibility | `public` |
| Fork of (per GitHub API `parent`) | `snipeship/ccflare` |
| Upstream remote in our clone | `tombii/better-ccflare` |
| `has_issues` | **`false`** (disabled post-disclosure) |
| Actions enabled | `true` |
| `allowed_actions` | **`"all"`** (wide-open) |
| Configured secrets | **`0`** (`/actions/secrets` returns `{"total_count": 0, "secrets": []}`) |
| Published releases on the fork | **0** |
| Commits ahead of `upstream/main` | 100 (we are 0 behind) |

### Recent workflow runs on the fork (26 most-recent)

| Count | Workflow | Event | Outcome |
|-------|----------|-------|---------|
| 8 | Auto-Rerun Failed Workflows | `schedule` | **success** (latest 2026-08-01T10:02:58Z) |
| 10 | Issue Triage Agent | `issues` | **failure** (no `LLM_API_KEY`) |
| 8 | Claude Code | `issues` | **skipped** (gated by `github.actor == 'tombii'`) |

No `claude-code-review`, `pr-review`, `docker-publish`, `release`, `release-dispatch`, or `signpath-test` runs in the recent window — none of their triggers have fired.

### Already-firing disclosure surface (today)

Today the only **active** inherited workflow is `auto-rerun-failed.yml`. It runs every 2 hours, has `actions: write`, and re-runs any failed workflow run from the last 6 hours. It does not post public content but it:

- Wastes CI minutes (8 runs in the recent window, all "no failures to rerun").
- Can re-fire any other workflow, including a future workflow that gets compromised or accidentally re-enabled after an upstream merge.
- Operates against `GITHUB_TOKEN` only, so it is independent of any of our configured secrets (it works today).

`Issue Triage Agent` has fired 10 times on `issues:opened` and **failed every time** because no `LLM_API_KEY` is configured. Failures are not a disclosure — the script aborts before contacting the LLM or posting a comment. **But the act of attempting the run is itself a signal**: someone opens an issue on this fork and a CI minute is spent spinning up an LLM-calling job. If a fork maintainer ever adds `LLM_API_KEY`, the same runs would start posting public triage comments.

---

## 2. Per-workflow classification

For each: trigger → effect → secrets → writes to public repo? → ruling → reason.

### `claude.yml` — DISABLE

- **Trigger:** `issue_comment:created`, `pull_request_review_comment:created`, `issues:opened|assigned`, `pull_request_review:submitted`. Gated by `if:` requiring the event body to contain `@claude` AND the actor to be `tombii` OR a site admin OR a user with `write`/`admin` permission on this repo.
- **Effect:** runs `anthropics/claude-code-action@v1` which has the ability to read the repo, run `gh` commands, and post comments.
- **Secrets:** `CLAUDE_CODE_OAUTH_TOKEN` — **not configured** on this fork.
- **Writes public content?** **Yes** — the action can comment on issues/PRs at the LLM's discretion.
- **Risk on this fork:** any comment containing `@claude` from a user with write/admin permission (e.g., anyone who lands a merged PR) triggers a workflow that can post arbitrary content under the maintainer's identity. On a public repo with a disclosure history, this is a high-blast-radius exfil channel.
- **Ruling:** **DISABLE** — secret absent today, but the gate is permissive enough that re-introducing the secret later re-arms the disclosure surface.

### `claude-code-review.yml` — DISABLE

- **Trigger:** `pull_request:opened`. Gated by actor being `tombii` / site admin / write / admin.
- **Effect:** runs Claude and explicitly tells it to "`Use gh pr comment` to leave your review as a comment on the PR."
- **Secrets:** `CLAUDE_CODE_OAUTH_TOKEN` — **not configured**.
- **Writes public content?** **Yes** — every opened PR from a permitted actor gets an LLM-generated comment posted.
- **Risk on this fork:** combined with the comment generator, generates deterministic public commentary on every PR. While the actor gate is strict today, the **upstream receiver pattern** (any PR) is exactly what we want to suppress on a public repo.
- **Ruling:** **DISABLE** — same reason as `claude.yml`.

### `pr-review.yml` — DISABLE

- **Trigger:** `pull_request_target:labeled|synchronize` where the label `ai_code_review` is present.
- **Effect:** checks out `refs/pull/<n>/merge`, diffs against `BASE_REF`, sends the full diff to an OpenRouter LLM (`LLM_URL` + `LLM_API_KEY`), and POSTs the LLM's markdown review as a PR comment via the REST API. On failure, posts a fixed comment via `actions/github-script`.
- **Permissions:** `contents: read`, **`pull-requests: write`**.
- **Secrets:** `LLM_API_KEY`, `LLM_URL` — **not configured**.
- **Writes public content?** **Yes** — two writers: the script unconditionally posts a review comment, and the `actions/github-script` step posts a failure comment.
- **Trigger severity:** `pull_request_target` is the most dangerous trigger in the GitHub Actions catalog — it runs in the context of the base branch with access to secrets, **even from forks**. Combined with `pull_request_target` reading `refs/pull/<n>/merge` and the script POSTing to the issues API, a PR submitted by an untrusted external party can post comments in our maintainer's voice.
- **Risk on this fork:** highest blast radius of any inherited workflow. Even with secrets absent, the workflow file being present is a foot-gun: adding `LLM_API_KEY` later re-arms it instantly.
- **Ruling:** **DISABLE**.

### `issue-triage.yml` — DISABLE

- **Trigger:** `issues:opened`.
- **Effect:** runs `issue-triage.sh` which sends the issue title + body + author to an OpenRouter LLM, applies AI-suggested labels via `POST /repos/.../issues/<n>/labels`, and POSTs the LLM's response as a triage comment on the issue.
- **Permissions:** **`issues: write`**, `contents: read`.
- **Secrets:** `LLM_API_KEY`, `LLM_URL` — **not configured**.
- **Writes public content?** **Yes** — labels are public, comment is public.
- **State interaction:** currently irrelevant — `has_issues` is `false` on this repo, so the trigger cannot fire. **But** if Issues are ever re-enabled, this workflow would resume firing the moment the trigger reappears. The condition is reversible; the file is not.
- **Risk on this fork:** also exfiltrates issue body content to a third-party LLM endpoint. Even when issues were open, an issue author had no expectation that their report would be sent to an OpenRouter model.
- **Ruling:** **DISABLE** — regardless of current `has_issues` state.

### `auto-rerun-failed.yml` — DISABLE

- **Trigger:** `schedule: '0 */2 * * *'` + `workflow_dispatch`.
- **Effect:** every 2 hours, lists failed workflow runs from the last 6 hours and calls `gh run rerun --failed` on each, unless a newer successful run of the same workflow+branch exists.
- **Permissions:** **`actions: write`**, `contents: read`.
- **Secrets:** `GITHUB_TOKEN` (auto-injected). **No external secrets needed.**
- **Writes public content?** No — it re-fires existing workflows, it doesn't write anything itself.
- **Risk on this fork:** this is the **only inherited workflow that is currently running** (8 successful scheduled runs in the recent window). It does not disclose, but it amplifies: any future compromised or accidentally re-armed workflow would be silently re-run within 2 hours of a transient failure, before a human notices. It also normalises the idea that the fork runs scheduled background jobs.
- **Ruling:** **DISABLE** — `actions: write` + cron is a privilege-escalation surface we do not need. We have no flaky-test problem on this fork (we ship a CLI proxy, not a multi-platform release matrix).

### `docker-publish.yml` — DISABLE

- **Trigger:** `workflow_run` (completed) when the upstream `Release Multi-Architecture Binaries` workflow completes, plus `workflow_dispatch`.
- **Effect:** builds multi-arch images (`linux/amd64`, `linux/arm64`) and `docker push`es them to `ghcr.io/<this-repo>` with `packages: write`. Generates artifact attestations.
- **Permissions:** `contents: read`, **`packages: write`**, `id-token: write`, `attestations: write`.
- **Secrets:** `GITHUB_TOKEN` (auto-injected).
- **Writes public content?** **Yes** — publishes container images to `ghcr.io/zenprocess/better-ccflare`.
- **Risk on this fork:** would only auto-fire from a successful upstream `release.yml` run on this fork. Since we are disabling `release.yml`, that trigger is broken. **But** `workflow_dispatch` is still a manual backdoor — a maintainer who clicks "Run workflow" in the UI would publish images under our org. There is no reason for this fork to publish Docker images.
- **Ruling:** **DISABLE**.

### `release.yml` — DISABLE (HIGHEST RISK)

- **Trigger:** `push: tags: 'v*'` + `workflow_dispatch`.
- **Effect:** on a `v*` tag push, builds CLI binaries for 5 platforms, runs `gh release create` to publish a GitHub Release with `contents: write`, uploads the 5 binaries to it.
- **Permissions:** **`contents: write`**.
- **Secrets:** `GITHUB_TOKEN` (auto-injected).
- **Writes public content?** **Yes** — GitHub Releases are public.
- **Why this is the worst offender:** the workflow's release notes hardcode `github.com/tombii/better-ccflare/releases/download/...` URLs in the install instructions (lines 109–122 and 142–154). It also constructs changelog comparison links to `https://github.com/tombii/better-ccflare/compare/...` (line 332). **If this ever fired on our fork, it would publish a release with install instructions pointing at tombii's releases, and our changelog would link every commit to tombii/better-ccflare's commit page.**
- **Fork-local modification:** commit `218f41c9 improve: thank merged-PR contributors...` modified the contributor-crediting section. That change is moot once the workflow is disabled.
- **Risk on this fork:** any accidental `v*` tag push from us (e.g., someone running `git tag v0.0.1 && git push --tags` while testing) would publish a real GitHub Release with tombii hardcoded in the body.
- **Ruling:** **DISABLE**.

### `release-dispatch.yml` — DISABLE

- **Trigger:** `workflow_dispatch` only. Inputs: `bump` ∈ {patch, minor, major}.
- **Effect:** on manual run, computes the next version, edits `apps/cli/package.json` + root `package.json`, commits the version bump, pushes to `refs/heads/main`, creates and pushes the `v<version>` tag, then runs `npm publish --provenance --access public` from `apps/cli/`. Uses `RELEASE_PAT` so the push can trigger downstream workflows.
- **Permissions:** **`contents: write`**, `id-token: write` (npm OIDC trusted publishing).
- **Secrets:** `RELEASE_PAT` — **not configured**.
- **Writes public content?** **Yes** — pushes to main, pushes a tag (which would re-arm `release.yml`), publishes to npmjs.org.
- **Risk on this fork:** we already have an automated release flow described in this repo's `CLAUDE.md`: `CLAUDE_CLI_VERSION` is auto-updated, and pushing to git triggers npm auto-publish via the release system. This workflow is an **alternative** path that would bypass that flow, write to npm under our namespace, and tag the repo. There is no scenario where running this on our fork is correct.
- **Ruling:** **DISABLE**.

### `signpath-test.yml` — DISABLE

- **Trigger:** `workflow_dispatch` only.
- **Effect:** builds the Windows binary, uploads it as an artifact, calls `signpath/github-action-submit-signing-request@v1` to submit to SignPath for test signing, downloads the signed binary as a 7-day artifact.
- **Permissions:** `contents: write`, `actions: read`.
- **Secrets:** `SIGNPATH_API_TOKEN`, `SIGNPATH_ORGANIZATION_ID` — **not configured**.
- **Writes public content?** Artifacts (private by default) + an external API call to SignPath.
- **Risk on this fork:** SignPath is a paid signing service we do not use; `better-ccflare` is unsigned per its release notes ("`xattr -d com.apple.quarantine better-ccflare-macos-arm64  # Required for unsigned binaries`"). There is no scenario for this on our fork.
- **Ruling:** **DISABLE**.

### `issue-triage.sh` (script) — DISABLE

- **Effect (summarised):** reads `LLM_URL` + `LLM_API_KEY`, sends the issue title/body/author as a prompt to an OpenRouter-compatible API, parses the JSON response for labels + severity + a "response" string, then:
  1. `curl POST /repos/${REPO_NAME}/issues/${ISSUE_NUMBER}/labels` to apply labels.
  2. Builds a Markdown comment with severity + analysis + response.
  3. `curl POST /repos/${REPO_NAME}/issues/${ISSUE_NUMBER}/comments` to post it.
- **Defects in the script itself** (relevant even though we are disabling it):
  - Default `REPO_NAME` is `tomascassell/better-ccflare` — **not even tombii's repo**. Inherited from a third party and never corrected.
  - Sanitisation is best-effort `sed` patterns; relies on `jq` for JSON escaping. Has known issues with control characters in prompt content (the script debug-logs positions of control characters but proceeds anyway).
  - The script posts even when the AI's response is empty or unparseable (falls back to `"Thank you for opening this issue!"`).
- **Ruling:** **DISABLE** (companion to `issue-triage.yml`).

### `pr-review.sh` (script) — DISABLE

- **Effect (summarised):** reads the PR diff from stdin, sanitises control characters, builds a prompt asking for a security / quality / perf / logic / best-practices review, sends to OpenRouter, parses the markdown response, then unconditionally `curl POST /repos/${REPO_NAME}/issues/${PR_NUMBER}/comments` with the review.
- **Defects:** same pattern as `issue-triage.sh` — sanitisation is sed-based, control-character handling is debug-heavy and incomplete.
- **Risk:** exfiltrates the full PR diff to a third-party LLM.
- **Ruling:** **DISABLE** (companion to `pr-review.yml`).

---

## 3. Mechanical enforcement

### Choice: move files, not delete them

Each of the 9 workflows was moved from `.github/workflows/` to `.github/workflows-disabled/`, and both scripts were moved from `.github/scripts/` to `.github/scripts-disabled/`. Git tracks the rename so `git log --follow` resolves the history.

### Why move is sufficient and clearer than delete

| Approach | Survives an upstream merge? | Self-documenting? | Cost |
|----------|----------------------------|-------------------|------|
| Delete files | No — merge re-creates them | No — invisible to future reviewers | None |
| Rename to `*.yml.disabled` | Yes, but file appears as "not a workflow" with no signal of intent | No — `*.yml.disabled` looks like a leftover | None |
| Add `if: false` to every trigger | Yes if the file is re-edited; no if upstream's file is reverted | No — file looks active | None |
| **Move to `.github/workflows-disabled/`** | **Yes — GitHub ignores the new path; on next merge the file reappears in `.github/workflows/` and needs explicit action** | **Yes — sibling directory + manifest README is unambiguous** | None |

GitHub Actions only scans `.github/workflows/` and its subdirectories. The new directories are **siblings** of the scanned directories (not children), and their names do not match the scanned path, so they are not detected. Verified against the GitHub Actions documentation.

### What survives a future `tombii/better-ccflare` merge into our `main`

When upstream merges land a file at `.github/workflows/foo.yml`:

1. The file is created at the scanned path → it WILL run if its trigger fires.
2. Reviewer must consult `.github/workflows-disabled/README.md` to see if the file is in the disallowed set.
3. If it is, move it: `git mv .github/workflows/foo.yml .github/workflows-disabled/foo.yml`.

**Recommended follow-up (not in scope of this PR):** add a CODEOWNERS rule on `.github/workflows/` requiring maintainer approval for any change there. That prevents accidental re-activation in a single click.

---

## 4. Things already firing that should not be

| Workflow | Trigger count in 26 most-recent runs | Why it shouldn't fire |
|----------|----------------------------------------|----------------------|
| `auto-rerun-failed.yml` | 8 schedule runs, all success | No flaky tests on this fork; `actions: write` cron is unjustified privilege. Disabled in this PR. |
| `Issue Triage Agent` | 10 failures | Was firing on `issues:opened` and failing because `LLM_API_KEY` is absent. No actual disclosure, but the CI minute cost and the latent risk if the secret is ever added make this unsafe. Disabled in this PR. |
| `Claude Code` | 8 skipped | Properly gated by `github.actor == 'tombii'` (false today → skipped). Disabled in this PR so the trigger surface itself goes away. |

No `release`, `release-dispatch`, `docker-publish`, `claude-code-review`, `pr-review`, or `signpath-test` runs in the recent window — none of their triggers have fired. Those workflows are dangerous **by their existence**, not by their activity.

---

## 5. File-level diff this PR makes

```
R  .github/scripts/issue-triage.sh          -> .github/scripts-disabled/issue-triage.sh
R  .github/scripts/pr-review.sh             -> .github/scripts-disabled/pr-review.sh
R  .github/workflows/auto-rerun-failed.yml  -> .github/workflows-disabled/auto-rerun-failed.yml
R  .github/workflows/claude-code-review.yml -> .github/workflows-disabled/claude-code-review.yml
R  .github/workflows/claude.yml             -> .github/workflows-disabled/claude.yml
R  .github/workflows/docker-publish.yml     -> .github/workflows-disabled/docker-publish.yml
R  .github/workflows/issue-triage.yml       -> .github/workflows-disabled/issue-triage.yml
R  .github/workflows/pr-review.yml          -> .github/workflows-disabled/pr-review.yml
R  .github/workflows/release-dispatch.yml   -> .github/workflows-disabled/release-dispatch.yml
R  .github/workflows/release.yml            -> .github/workflows-disabled/release.yml
R  .github/workflows/signpath-test.yml      -> .github/workflows-disabled/signpath-test.yml
A  .github/workflows-disabled/README.md
A  docs/workflow-audit-114.md
```

Net result: `.github/workflows/` is empty; `.github/scripts/` is empty; every inherited file is in a sibling "disabled" directory with a manifest explaining why; this audit report is checked in alongside.

---

## 6. Acceptance

- `git ls-files .github/workflows/` returns **empty**.
- `git ls-files .github/scripts/` returns **empty**.
- `git ls-files .github/workflows-disabled/` returns all 9 workflows + `README.md`.
- `git ls-files .github/scripts-disabled/` returns both scripts.
- `git log --follow` on every moved file resolves its origin in upstream history.
- No secrets, no API calls, no irreversible actions taken.