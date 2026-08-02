# Disabled upstream workflows

The files in this directory were **inherited wholesale** from
`tombii/better-ccflare` (the upstream we forked from) and have been
deliberately moved out of `.github/workflows/` so GitHub Actions will not
discover, parse, or run them on this fork.

> GitHub Actions only picks up workflow YAML from `.github/workflows/` and its
> subdirectories. Files in this sibling directory are ignored — verified by
> GitHub's documented path semantics
> (https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions).

## Ruling table

| File | Ruling | Why (one line) |
|------|--------|----------------|
| `claude.yml` | DISABLE | Public issue/PR comments + `CLAUDE_CODE_OAUTH_TOKEN`; mentions are user-injectable on a public repo. |
| `claude-code-review.yml` | DISABLE | Auto-posts review comments on every opened PR via `gh pr comment`. |
| `pr-review.yml` | DISABLE | `pull_request_target` + LLM exfil of diff + posts PR comment on failure; most dangerous trigger. |
| `issue-triage.yml` | DISABLE | Auto-labels and auto-comments on every opened issue; sends issue body to LLM. |
| `auto-rerun-failed.yml` | DISABLE | `actions: write` + 2-hour cron — re-fires any failed run, amplifies blast radius of any compromised workflow. |
| `docker-publish.yml` | DISABLE | Publishes images to ghcr.io via `packages: write`; wrong target for our fork. |
| `release.yml` | DISABLE | **Hardcodes `github.com/tombii/better-ccflare/releases/...` in install instructions and links in changelog** — would publish our release notes pointing at tombii's repo. |
| `release-dispatch.yml` | DISABLE | Manual version bump + tag push + npm OIDC publish; bypasses our automated release flow. |
| `signpath-test.yml` | DISABLE | Calls external SignPath signing service; secrets not configured. |
| `../scripts-disabled/issue-triage.sh` | DISABLE | Companion to `issue-triage.yml`; sends issue body to OpenRouter and POSTs comment. Default `REPO_NAME` is `tomascassell/better-ccflare` — broken for us. |
| `../scripts-disabled/pr-review.sh` | DISABLE | Companion to `pr-review.yml`; sends PR diff to OpenRouter and POSTs comment. |

## Why this is mechanical, not a doc

A README alone is not enforcement. The ruling survives because:

1. **GitHub does not scan this directory.** Any `*.yml` / `*.yaml` files here
   will never be picked up as workflows, never parsed, never triggerable from
   the Actions UI, `gh workflow run`, or any event.
2. **Original files are gone from `.github/workflows/`.** Future commits to
   main that add new workflows must be reviewed on their own merit — the
   disabled upstream set no longer "exists" in the scanned path.
3. **Files remain in git history.** `git log --follow` resolves the rename,
   so the audit trail is intact.

## What happens on the next upstream sync

When we merge `tombii/better-ccflare`'s `main` into ours, any of these files
will land in `.github/workflows/` again as a regular file. That is the
moment to re-apply this ruling:

- If the file is **still** in this disabled list → move it back to
  `.github/workflows-disabled/`.
- If tombii has materially changed the file → re-read it, decide again, and
  update this README.
- A CODEOWNERS rule on `.github/workflows/` that requires a maintainer
  approval is the recommended follow-up to prevent accidental re-activation.

## Restoring one (do not do this casually)

If a workflow ever needs to be re-enabled:

1. `git mv .github/workflows-disabled/<name>.yml .github/workflows/<name>.yml`
2. Confirm the secrets it needs are configured in repo settings.
3. Confirm it does not post public content to tombii URLs (for `release.yml`).
4. Update this README's ruling table.