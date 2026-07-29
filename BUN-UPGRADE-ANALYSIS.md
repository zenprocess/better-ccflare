# Bun upgrade analysis: 1.2.23 → 1.3.14

**Date:** 2026-07-29  
**Scope:** Task B only; analysis and recommendation, no implementation or service change.

## Executive recommendation

1. **Move the normal production baseline from Bun 1.2.23 to stable 1.3.14**, but build and validate the actual compiled ccflare artifact on green before cutover. The repository declares Bun `>=1.2.8`, and the inspected runtime surfaces remain supported. The most material migration risk is not removal of `bun:sqlite`, `Bun.SQL`, `fetch`, streams, `Bun.serve`, Workers, or `bun build --compile`; it is Bun 1.3's package/build behavior, especially isolated workspace installs. The compiled artifact must therefore be produced by the same pinned Bun version that green will run.
2. **Do not build Bun from main merely to obtain #35093.** That build still measures about **77 KB/request** on the dropped-reference path, versus about **18.8 KB/request** with ccflare's application-side chunked-drain mitigation on stock Bun. It adds canary/runtime uncertainty without improving the measured production-relevant path.
3. **Blue-green materially changes, but does not reverse, the canary decision.** It makes a pinned prebuilt canary a reasonable *green-only experiment*: validate it under representative traffic, compare it with a 1.3.14 green, then destroy or roll it back without exposing all traffic. It does not make source-building worthwhile when the target fix fails the measured acceptance criterion. Instant routing rollback also cannot undo state written by green, so “instant” applies to traffic, not every consequence.
4. **Use the official prebuilt canary instead of building main** if testing post-1.3.14 Bun is useful. Bun publishes an untested canary binary on every main commit, including Linux x64 and baseline assets. Pin the downloaded artifact by Bun revision/commit and SHA-256; never consume the moving `canary` URL during a rebuild.
5. **Replace `:amd64` as the deployment identity.** Recommended immutable tag:
   `ccflare:3.5.44-bun1.3.14-linux-amd64-<imageGitSha>`.
   Also publish convenience aliases such as `:3.5.44-bun1.3.14-linux-amd64` and, if needed, `:amd64`, but deploy by immutable digest (`image@sha256:…`). Record OCI labels for ccflare version/source revision, Bun version/revision, architecture, and build timestamp.

## Verified baseline and actual ccflare surface

The task specification establishes that production runs better-ccflare 3.5.44 in `registry.zp.digital/zen-infra/ccflare:amd64`, with Bun 1.2.23 on Linux x86_64. It also establishes that 1.3.14 is the latest stable release, that neither #32662 nor #35093 is in a stable release, and that Bun 1.2.23 has not yet been benchmarked by us.

The upstream repository at the requested base has these relevant surfaces:

- Workspace monorepo and Bun engine floor: `package.json:4-7`, `package.json:26-28`.
- The release binary is built with `bun build --compile`, including cross-target Linux x64 builds: `apps/cli/package.json:19-25`.
- Runtime HTTP entry uses Bun's `serve()` with an async fetch handler: `apps/server/src/server.ts:73`, `apps/server/src/server.ts:1143-1155`, `apps/server/src/server.ts:1335`.
- SQLite uses `bun:sqlite`; PostgreSQL uses `Bun.SQL` through a common adapter: `packages/database/src/adapters/bun-sql-adapter.ts:0-2`, `packages/database/src/adapters/bun-sql-adapter.ts:63-79`, `packages/database/src/adapters/bun-sql-adapter.ts:203-248`.
- The Postgres path intentionally uses `sql.unsafe()` and depends on native-driver behavior: `packages/database/src/adapters/bun-sql-adapter.ts:214-224`, `packages/database/src/adapters/bun-sql-adapter.ts:239-248`.
- SQLite maintenance uses Workers, both object-URL code in compiled artifacts and source URLs in development: `packages/database/src/database-operations.ts:1446-1478`, `packages/database/src/incremental-vacuum-worker.ts:47-80`.
- SSE translation uses `TransformStream`: `packages/openai-responses-adapter/src/stream-translator.ts:23-35`, `packages/openai-responses-adapter/src/stream-translator.ts:434`.
- This server does **not** configure a `websocket` handler or call `server.upgrade()`; it explicitly rejects Codex WebSocket upgrade attempts: `apps/server/src/server.ts:1234-1256`. Thus Bun 1.3 WebSocket server API changes are not on the deployed ccflare path.

## Compatibility assessment by requested surface

### Package install and TypeScript/build defaults — validate explicitly

Bun 1.3 changed workspace installs to the isolated linker by default. This repository is a workspace monorepo (`package.json:4-7`), so a clean `bun install --frozen-lockfile` can expose undeclared cross-workspace dependencies that happened to work when dependencies were hoisted. That is desirable enforcement long term, but it is the most plausible upgrade-time build break.

**Action:** run a clean install and all build/test checks with 1.3.14. If the build depends on hoisting, fix package manifests rather than silently retaining hoisting; using `[install] linker = "hoisted"` is a temporary rollback lever, not the preferred final state.

Bun 1.3 also changed its default TypeScript module mode from `ESNext` to `Preserve`. The production build is Bun-bundled/compiled rather than emitted by `tsc`, so no code change is indicated from inspection, but the clean 1.3.14 build and typecheck remain the proof.

### `bun:sqlite` — compatible, with fixes and an SQLite engine update

No relevant API removal was found for the used calls (`new Database`, `query().all/get`, `run`, `exec`, `close`). Bun 1.3.14 updates embedded SQLite to 3.53.0 and contains additional SQLite/runtime fixes. The ccflare calls are conventional and should require no source or config changes.

**Risk:** database semantics can move with the embedded SQLite version even when the JS API is stable. Green validation should include schema migration from a production-like copy, normal reads/writes, WAL behavior, busy retry, incremental vacuum, full compaction, integrity worker, and clean restart.

### PostgreSQL / `Bun.SQL` — compatible and materially improved, but high-value regression target

The adapter's `SQL`, `unsafe()`, query result arrays, pooling, and `close()`-style lifecycle remain supported. Bun 1.3.14 fixes several directly relevant native-driver problems: failed Postgres connections not being garbage-collected, array-column leaks, `sql.unsafe()` simple multi-statement metadata/leaks, and shared TLS-context allocation. These are reasons to prefer 1.3.14 over 1.2.23 when the Postgres backend is used.

There is no identified code/config change. However, this is a native driver and ccflare already carries a retry for a known Bun Postgres integer-decoding race (`packages/database/src/adapters/bun-sql-adapter.ts:148-169`). Green validation must exercise connection failure/recovery, TLS if enabled, pool concurrency, statement timeouts, migrations, transactions, arrays if present, and sustained read/write load. Do not remove the workaround as part of this runtime upgrade.

### `fetch` — API-compatible; memory acceptance must be measured, not inferred

The used fetch/Response/Request surface remains available. Relevant 1.3 changes include corrected manual-redirect semantics, automatic zstd decompression, stream cancellation reason propagation, and many fetch leak fixes. Experimental HTTP/2 and HTTP/3 require explicit flags/options and should remain disabled during this upgrade.

There is no indicated source/config change for ordinary HTTP/1.1 proxying. Nevertheless, the leak under investigation is precisely in this area. A passing functional suite is insufficient: green must run the same held/cancel/drain benchmark and a sustained representative proxy soak. The current evidence says 1.3.14's held/dropped-reference behavior is about 77 KB/request, not fixed.

### Streams and SSE — compatible; cancellation/backpressure are mandatory tests

`TransformStream`, `ReadableStream`, `Response(stream)`, and SSE framing remain supported. Bun 1.3.14 fixes independent-stream cross-closing, abandoned `TransformStream` GC cycles, direct-stream server leaks, and `AbortSignal` listener accumulation. These fixes are favorable, but behavior around cancellation, EOF, and backpressure is where runtime upgrades can surface regressions.

No code/config change is identified. Validate byte-for-byte SSE framing, slow clients, client disconnect, upstream abort, downstream cancellation, error propagation, and graceful shutdown with open streams. Keep the application-side chunked-drain mitigation unless a benchmark proves it unnecessary.

### `Bun.serve` / `serve()` — compatible for ccflare's handler form

The existing async `fetch(req)` handler remains supported. Bun 1.3 adds a route-table model but does not require migration from the fetch handler. The wildcard-route precedence change is irrelevant because ccflare does its own routing inside the handler. HTTP/3 is experimental and opt-in; do not combine it with this upgrade.

No source/config change is identified. Validate listen/bind/TLS, idle timeout, large request bodies, streaming responses, health checks, in-flight drain, stop/shutdown, and memory under sustained traffic.

### Workers — compatible, with teardown fixes

The Worker constructor, object URLs, `postMessage`, `onmessage`, `onerror`, and `terminate()` remain supported. Bun 1.3/1.3.14 includes Worker and MessagePort lifecycle fixes. No code change is indicated.

Because ccflare embeds worker code before the final compile, validate both development-source workers and the compiled binary's Blob/object-URL workers. Exercise compaction, incremental vacuum, integrity checks, worker error paths, and repeated creation/termination while monitoring RSS.

### `bun build --compile` — supported, but compiler version becomes part of the artifact

The exact CLI form used by ccflare remains supported, including `--target=bun-linux-amd64`. Bun 1.3 adds capabilities and fixes standalone executable issues; no required flag migration was found.

The compiled executable embeds Bun, so updating a runtime layer without rebuilding the ccflare executable does not necessarily update the Bun runtime actually executing ccflare. The release must therefore build the application binary with pinned Bun 1.3.14, then verify the resulting artifact reports both ccflare and Bun identity. Cross-target output should be tested on Linux x86_64, not merely built on another platform.

## Main/source build decision

### What blue-green changes

Blue-green removes much of the operational blast radius of a canary:

- green can be built and tested without receiving production traffic;
- a limited traffic slice or replay/soak can reveal crashes, protocol regressions, and memory growth before cutover;
- traffic can be switched back quickly if green regresses;
- stable and canary greens can be tested with identical ccflare code and workload.

That makes “never run canary” too strong. A **pinned prebuilt canary on green** is a valid experiment, and—after passing explicit gates—could be a consciously accepted temporary production candidate when its measured benefit is compelling and the operator accepts the remaining risk.

Blue-green does **not** eliminate:

- latent defects not reached during green validation;
- compatibility differences in a 1.4.0-canary runtime;
- state mutations made by green against shared stores;
- request failures during the detection window;
- provenance/rebuild risk if the binary is not pinned;
- the cost of maintaining a private runtime variant.

### Why #35093 does not justify main today

The desired result is lower memory growth on ccflare's real dropped-reference path. The supplied measurements are:

| Runtime/path | Measured growth |
|---|---:|
| Bun 1.3.14, held/dropped-reference | ≈77 KB/request |
| Bun build containing #35093, held/dropped-reference | ≈77 KB/request |
| Stock Bun + ccflare chunked drain | ≈18.8 KB/request |

The #35093 build fixes explicit cancellation, but it does not improve the measured dropped-reference case. Its measured result is about **4.1×** the drain mitigation's growth (77 / 18.8). Therefore a source build from main adds canary and supply-chain/build complexity for no demonstrated benefit on the acceptance path.

**Recommendation:** retain the drain mitigation and adopt stable 1.3.14 first. Test #35093/canary on green only if explicit-cancel behavior is independently valuable or to gather evidence for Bun upstream. Do not cut over because a PR number is present; cut over only if the pinned candidate beats the stable+drain baseline on the same harness and passes functional/soak gates.

## Middle options that actually exist

1. **Stable 1.3.14 prebuilt binaries:** confirmed as the latest stable release on 2026-07-29. It is newer than 1.2.23 and is the recommended baseline. Exact-version installation and versioned GitHub assets are available.
2. **Official prebuilt canary:** Bun documents that an untested canary is built on every main commit. The `canary` release currently exposes Linux x64, Linux x64 baseline, musl, ARM, macOS, Windows, profile variants, and signed SHA sums. On 2026-07-29 the Linux x64 asset had been updated at `2026-07-29T01:03:12Z` and published digest `sha256:54b875…5332`; this proves a prebuilt path exists, not that that moving asset is suitable to pin forever.
3. **Exact PR build:** `bunx bun-pr <PR>` is documented for local PR testing. It is useful for validation, but production provenance should still be captured as an immutable artifact with commit and checksum.
4. **Source build at a commit:** available when custom patches or architecture/toolchain requirements demand it, but unnecessary solely to consume #35093 because official canary/PR binaries exist.

There is no stable release newer than 1.3.14 as of the verified date. Both leak fixes landed after it, so no stable middle option contains them.

## Source-build cost and reproducibility

Current Bun contributor documentation states:

- **Setup time:** 10–30 minutes depending on machine and network.
- **Disk:** about 10 GB for repository and build artifacts; locally building WebKit/JSC adds 8 GB or more.
- **Toolchain:** exact LLVM 21.1.8; pinned Rust nightly from `rust-toolchain.toml`; GCC 11+ on Ubuntu for C++20; CMake, Ninja, Git, Go, Ruby, pkg-config/libtool and platform packages; an existing release Bun binary for build/codegen.
- **Build commands:** `bun run build` for debug and `bun run build:release` for release.
- **RAM:** the current documentation consulted does not publish a requirement. Any number would be an **estimate**. Operationally, provision at least **16 GB RAM (estimate)** and prefer **32 GB (estimate)** to avoid link-time pressure and leave headroom.
- **Full release build duration:** the current documentation does not give a single guaranteed time. Budget **15–45 minutes for a cold release build (estimate)** after setup on a modern multi-core x86_64 builder; record the observed CI duration instead of treating this estimate as an SLA.

To make a source build reproducible:

1. Pin the full Bun Git commit SHA (not `main`, `canary`, a branch, or only a PR number).
2. Fetch submodules at their recorded commits.
3. Pin the builder image by digest and install the exact required LLVM and the repository-pinned Rust toolchain.
4. Record build command/profile, target, environment, compiler versions, and source-dirty status.
5. Generate SHA-256 for the Bun binary and the final ccflare image; store SBOM/provenance and test results beside them.
6. Verify `bun --version` and `bun --revision` in the builder and verify the embedded runtime identity from the compiled ccflare artifact.
7. Promote the exact tested image digest from green to production; never rebuild between test and cutover.

## Image tags and identity

`:amd64` answers only “which architecture?” and is mutable. It cannot answer which ccflare source, Bun runtime, or rebuild is running.

### Recommended scheme

Immutable human-readable tag:

```text
registry.zp.digital/zen-infra/ccflare:3.5.44-bun1.3.14-linux-amd64-<ccflareGitSha>
```

For a canary/source runtime:

```text
registry.zp.digital/zen-infra/ccflare:3.5.44-bun1.4.0-canary.1-<bunSha>-linux-amd64-<ccflareGitSha>
```

If the same source can be rebuilt, append a build identifier or provenance digest prefix. Publish optional mutable aliases (`:3.5.44-bun1.3.14-linux-amd64`, `:amd64`) only for discovery; deployment manifests should reference `@sha256:<imageDigest>`.

Required OCI labels/annotations:

- `org.opencontainers.image.version=3.5.44`
- `org.opencontainers.image.revision=<ccflare full SHA>`
- `org.opencontainers.image.source=<repository URL>`
- `org.opencontainers.image.created=<UTC timestamp>`
- `org.opencontainers.image.architecture=amd64`
- `io.zp.bun.version=1.3.14` (or canary semantic version)
- `io.zp.bun.revision=<Bun full SHA from bun --revision>`

Also expose these identities in startup logs and a read-only version/health response. The operator should be able to reconcile container digest, OCI labels, application version, and embedded Bun revision without inspecting a bundled dashboard.

## Green validation and cutover gates

The runtime candidate should not receive production cutover until all of these pass on the **exact image digest**:

1. clean frozen install and build under Bun 1.3.14;
2. repository test/typecheck/build checks;
3. compiled binary starts and reports ccflare 3.5.44 plus expected Bun revision;
4. SQLite migration/read/write/restart and maintenance-worker tests;
5. Postgres migration/read/write/pool/error-recovery tests if green uses Postgres;
6. HTTP proxy tests for normal JSON, large/streaming bodies, redirects, aborts, and upstream errors;
7. SSE byte/framing, slow-client, disconnect, cancellation, and shutdown tests;
8. the same held/cancel/drain leak harness, with 1.2.23 measured separately by Task C;
9. representative sustained soak with RSS slope, latency, error rate, CPU, DB connections, and stream completion compared against stable+drain;
10. rollback rehearsal to the prior image digest.

A canary should have a stricter gate: it must demonstrate a quantified benefit over stable 1.3.14 + drain on the intended path, not merely parity.

## Sources

- [Bun 1.3 release notes](https://bun.sh/blog/bun-v1.3)
- [Bun 1.3.14 release notes](https://bun.sh/blog/bun-v1.3.14)
- [Bun installation, exact versions, canary and direct downloads](https://bun.sh/docs/installation)
- [Bun GitHub releases](https://github.com/oven-sh/bun/releases)
- [Bun contributor/build documentation](https://bun.com/docs/project/contributing)
- [Bun source repository](https://github.com/oven-sh/bun)

## Confidence and open evidence

- **High confidence:** stable/canary availability, actual repo API surface, compiled-binary build path, #35093 recommendation from the supplied measurements, and image-tagging recommendation.
- **Moderate confidence:** no source/config migration is required for the inspected runtime APIs; this must be proven by clean build and green tests because Bun 1.2.23 has not been run through this analysis environment.
- **Estimates explicitly labeled:** RAM and cold release-build duration.
- **Still required:** Task C's Bun 1.2.23 benchmark. Until it exists, the upgrade's memory delta versus the runtime actually in production is unknown.
