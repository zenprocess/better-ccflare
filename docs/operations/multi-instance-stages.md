# Multi-Instance Stages: Operational Guidance

This document is the operational companion to the analysis at
[`docs/351-multi-instance-path.md`](../351-multi-instance-path.md). It
describes what an operator can do at the load-balancer / ingress layer
to make a multi-instance deployment **less bad**, and is explicit about
what that does not fix.

## Context

better-ccflare is single-instance-per-database by design. The seven
categories of in-process state that diverge silently across instances
are enumerated in
[`docs/deployment.md` § Multi-Instance Deployment](../deployment.md#multi-instance-deployment-single-instance-per-process).
The startup guard (PR #376, landed in v3.5.46) warns at startup when
another live process shares the database. It does not solve the
divergence problem; it just makes the symptom visible.

This document covers the operational steps an operator can take if
they have already decided to run multiple instances behind a load
balancer anyway. It is intentionally narrow: it does not propose new
application code, and it does not argue that such deployments are
safe.

## Stage 0: Startup guard (operator-configurable)

The startup guard is configured by environment variable at the
instance level:

- `BETTER_CCFLARE_MULTI_INSTANCE=warn` (default). The instance logs
  the peer row(s) and continues.
- `BETTER_CCFLARE_MULTI_INSTANCE=refuse`. The instance logs and
  throws `MultiInstanceRefusedError`, causing the process to exit
  before serving traffic.

For deployments with a load balancer in front of multiple instances:
set `refuse` so a misconfigured second instance fails its health
check rather than serving traffic with a divergent state. The
heartbeat expiry is 30 seconds, so an instance that crashed without
clearing its row will not block a legitimate restart for more than
half a minute.

The guard does not protect against a second instance that starts
after the first one has exited. It is a startup check; nothing else.

## Stage 1: Ingress stickiness (operational guidance only)

Ingress stickiness is the operator-side configuration that pins a
client to one instance for the duration of a session. It is the only
mitigation that does not require new application code.

### What it is

Configure the load balancer or ingress to send the same client to
the same instance:

- **Cookie-based affinity** (preferred for HTTP / HTTPS): the LB
  injects a cookie on the first request and forwards subsequent
  requests carrying that cookie to the same backend.
- **Source-IP hash** (acceptable for clients with stable IPs): the
  LB hashes the client IP and routes consistently. This is brittle
  when clients are behind NAT or a corporate proxy.

### What it preserves

- **Session affinity.** Once a client picks an instance, the
  in-process `SessionAffinityStrategy` map stays consistent for that
  client. The same client will keep being routed to the same account
  on the same instance, which is what the 5-hour session design
  depends on.

### What it does NOT fix

Ingress stickiness is a partial mitigation for **one** of the seven
divergence categories. It does not fix:

- **UsageCache divergence.** Each instance still keeps its own view
  of account utilisation. Rate-limit decisions still diverge.
- **Duplicated schedulers.** Both instances still run
  `AutoRefreshScheduler`. Both still race on the same OAuth tokens.
  This is the highest-blast-radius of the seven categories because
  it races against the upstream provider, not just against the other
  instance.
- **Probe lease races.** The `probeLeases` map is per-instance. Two
  instances each run their own rate-limit recovery probe. The
  single-flight guarantee is lost.
- **SessionGovernor divergence.** The session-volume circuit
  breaker is per-instance. Sessions can be ended earlier or later
  than expected depending on which instance handles them.
- **Keepalive body replay cache divergence.** Each instance keeps
  its own replay cache. Replay may miss or duplicate across
  instances.

### What it does NOT give you

Stickiness is not a foundation for safe multi-instance. The
database is still shared; the seven categories are still divergent;
OAuth is still racing; rate-limit decisions are still split across
two views. Stickiness removes the "stuck client picks a different
account mid-conversation" failure mode and nothing else.

### Concrete configs

#### nginx (cookie-based)

```nginx
upstream ccflare {
    # Sticky cookie named "ccflare_route", persisted for 1 hour.
    sticky cookie ccflare_route expires=1h httponly secure path=/;

    server 10.0.0.1:8080 max_fails=3 fail_timeout=30s;
    server 10.0.0.2:8080 max_fails=3 fail_timeout=30s;
}

server {
    listen 443 ssl;
    server_name ccflare.example.com;

    location / {
        proxy_pass http://ccflare;
    }
}
```

#### nginx (source-IP hash)

```nginx
upstream ccflare {
    ip_hash;
    server 10.0.0.1:8080;
    server 10.0.0.2:8080;
}
```

#### HAProxy

```
backend ccflare
    balance source
    hash-type consistent
    stick-table type ip size 50k expire 1h
    stick on src
    server instance-a 10.0.0.1:8080 check
    server instance-b 10.0.0.2:8080 check
```

#### Kubernetes Ingress

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ccflare
  annotations:
    nginx.ingress.kubernetes.io/affinity: "cookie"
    nginx.ingress.kubernetes.io/session-cookie-name: "ccflare_route"
    nginx.ingress.kubernetes.io/session-cookie-expires: "3600"
spec:
  rules:
    - host: ccflare.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ccflare
                port:
                  number: 8080
```

## Stages 2–4: Not implemented

These stages are listed in
[`docs/351-multi-instance-path.md`](../351-multi-instance-path.md) §
"Stage ranking" and are explicitly **not implemented** in
better-ccflare. Each carries an operational cost that is not
justified by the use case for a single-maintainer project:

- **Stage 2 — Leader election.** A coordination dependency (etcd,
  ZooKeeper, or Postgres advisory locks) for every read and write
  path. The single-maintainer operational cost is not amortised by
  the rarity of the failure mode.
- **Stage 3 — Distributed affinity.** Requires a Redis or
  Postgres-backed shared cache layer. Every routing decision
  becomes a network round-trip. Latency and complexity rise; the
  in-process state that diverges is not all about routing.
- **Stage 4 — Probe single-flight.** Requires a distributed lock
  manager (same dependency as Stage 2) and only addresses one of the
  seven categories.

If a future Stage 2 PR arrives, the project should review it on its
merits. The current recommendation is not to absorb the operational
cost of a coordination layer for a deployment topology that the
project does not need to support.

## Related

- [`docs/deployment.md` § Multi-Instance Deployment](../deployment.md#multi-instance-deployment-single-instance-per-process)
  — the single-instance rule and what the startup guard does.
- [`docs/351-multi-instance-path.md`](../351-multi-instance-path.md) —
  the full analysis of the seven categories, stage ranking, and the
  anti-roadmap argument.
- [`packages/database/src/multi-instance-guard.ts`](../../packages/database/src/multi-instance-guard.ts)
  — the guard implementation.
