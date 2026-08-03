# tombii/better-ccflare issue #373 — comment posting record

- Issue: https://github.com/tombii/better-ccflare/issues/373
- Posted comment: https://github.com/tombii/better-ccflare/issues/373#issuecomment-5169365998
- Comment ID: 5169365998
- Posted by: zenprocess (GITHUB_TOKEN)
- Posted at: 2026-08-03T17:01:06Z
- Approved text source: reply-373.md (verbatim)

## Verification

Fetched the posted comment back via REST API and diffed against the approved
file. Body content is byte-identical to the approved text; GitHub appends a
single trailing newline, which is the only diff.

## Failed first attempt (deleted before final)

`gh api ... -f body=@file` posted the literal file path instead of the contents
(same bug as `-F body=@file`, despite the casing warning in the task brief).
The bad comment ID was 5169356774, body was the literal path
`@/private/tmp/claude-501/-Users-vvladescu--ao-data-worktrees-ccflare-orchestrator-ccflare-orchestrator/50f51e6c-015a-534d-8ba6-42de7d46233e/scratchpad/reply-373.md`.
Deleted via `gh api ... -X DELETE` immediately after the verify step caught it
(now returns 404). The correct comment was then posted via `curl --data-binary
@<json>` with explicit `Authorization: Bearer $GITHUB_TOKEN` header, which
definitively sends the file contents.

## Lesson

`-f body=@file` is just as broken as `-F body=@file` on this `gh` version
(2.96.0). Use a method that provably sends bytes — `curl --data-binary @file`
or `gh api --input <file>` — when posting binary or path-sensitive content.
