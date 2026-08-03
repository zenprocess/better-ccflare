# ccflare descriptor landed in ao-company (issue #108)

The authoring-source copy of ccflare's gate descriptor now exists on `main` of
`zenprocess/ao-company`:

- path: `config/descriptors/ccflare.project.yaml`
- size: 4639 bytes
- commit: `50d218c feat(descriptors): add ccflare descriptor + gate wiring (issue #108)`
- verification (this session, 2026-08-03):
  `gh api repos/zenprocess/ao-company/contents/config/descriptors | jq -r '.[].name' | grep -q '^ccflare\.project\.yaml$'`
  → `ACCEPTANCE PASS`

## Why a note branch on ccflare rather than just merging ao-company

This is a bookkeeping commit only. The file lives in ao-company (the
authoring source); the ccflare-side `.zp/project.yaml` apply-target was already
on `ao/ccflare-108/wire-fabro-gate` at commit `7f1a5d30`. The descriptor
mirror must now happen: copy `config/descriptors/ccflare.project.yaml` from
ao-company main into `ccflare/.zp/project.yaml` and confirm body equality
(line-for-line minus the header deferral comment). That copy is the gate
acceptance test for issue #108 — it is intentionally NOT done here.

## What the prior worker got right vs what it missed

A prior session pushed `50d218c` to the side branch `ao/ccflare-108/wire-fabro-gate`
in ao-company (via ccflare's worktree, since both repos are reachable from the
cald broker). Two prior reports of success were unbacked because the file was
on a branch, not on main, and the verifier `gh api
repos/zenprocess/ao-company/contents/config/descriptors` does not enumerate
remote-only branches. This session:

1. confirmed the prior branch's commit was a clean single-file diff (`git show
   --stat 50d218c` → 1 file changed, 80 insertions),
2. confirmed main was a direct ancestor (`27971dc7` on main, `50d218c` as
   fast-forward descendant of the same parent),
3. fast-forwarded `main` to `50d218c` and pushed — single commit, no merge
   commit, prior worker's authorship preserved.

## Next step (out of scope here)

Mirror the ao-company file to ccflare's `.zp/project.yaml` so the gate can
discover it, then open the PR for issue #108.

Refs #108
