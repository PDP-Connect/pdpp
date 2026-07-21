---
title: "Scale-to-zero runtimes separate service capability from warm-instance readiness"
date: 2026-07-16
topic: distributed-systems
tags: [health, scale-to-zero, allocator, runtime, browser-surface]
status: final
sources: [cloud-run-autoscaling, cloud-run-min-instances, aws-lambda-environments, kubernetes-probes, chatgpt-session-loss-rootcause, chatgpt-session-discriminator, retained-credential-boundary-surface-process]
---

## CLAIMS

- Cloud Run services default to zero minimum instances and scale a revision to zero when it receives no traffic; a later request creates a new instance. [cloud-run-autoscaling]
- Cloud Run describes minimum instances as an optional latency optimization that keeps instances warm and incurs idle cost. A service does not need a warm instance merely to remain deployable and callable. [cloud-run-min-instances]
- AWS Lambda creates an execution environment when an on-demand function is first invoked, may reuse it after the invocation, and advises applications not to depend on an environment being long-lived. [aws-lambda-environments]
- Kubernetes readiness is an instance-level condition: a readiness probe decides whether a running Pod can receive Service traffic. It does not establish whether a separate control plane can allocate a future instance. [kubernetes-probes]
- Two isolated ChatGPT connections completed successful runs and then both reported `chatgpt_session_required` immediately after replacement Chromium containers were created. Stable profile keys and, for one connection, a reused profile mount rule out a different or empty profile as the common explanation. [chatgpt-session-loss-rootcause]
- A read-only check of the surviving replacement surface reached `/api/auth/session` with HTTP 200 but `hasUser=false`, while DOM login and app/account markers were simultaneously present. The connector's authenticated-session probe is therefore the correct discriminator; a reachable page, persisted profile, URL, title, or logged-looking DOM is not proof of authentication. [chatgpt-session-discriminator]
- The retained-surface contract deliberately preserves a credential-boundary browser process during routine idle and capacity events. After reconciliation with the replacement evidence, its current OpenSpec treats genuine process/container loss as non-green continuity uncertainty with no owner action unless a typed provider invalidation proof exists; it still does not define portable authenticated state that survives process replacement. [retained-credential-boundary-surface-process]

## SOURCES

**cloud-run-autoscaling**

URL: https://docs.cloud.google.com/run/docs/about-instance-autoscaling

Accessed: 2026-07-16

**cloud-run-min-instances**

URL: https://docs.cloud.google.com/run/docs/configuring/min-instances

Accessed: 2026-07-16

**aws-lambda-environments**

URL: https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html

Accessed: 2026-07-16

URL: https://docs.aws.amazon.com/lambda/latest/dg/foundation-progmodel.html

Accessed: 2026-07-16

**kubernetes-probes**

URL: https://kubernetes.io/docs/concepts/workloads/pods/probes/

Accessed: 2026-07-16

**chatgpt-session-loss-rootcause**

Path: internal workstream report `chatgpt-session-loss-rootcause-0716.md` (not tracked in this repo)

Accessed: 2026-07-16

**retained-credential-boundary-surface-process**

Paths: `openspec/changes/retain-credential-boundary-surface-process/{proposal.md,design.md,tasks.md,specs/polyfill-runtime/spec.md}`

Accessed: 2026-07-16

**chatgpt-session-discriminator**

Path: internal workstream report `chatgpt-session-discriminator-0716/report.md` (not tracked in this repo)

Accessed: 2026-07-16

## SYNTHESIS

An allocate-on-demand runtime has at least two independent health questions: whether its control plane is currently reachable enough to accept and describe work, and whether a concrete warm instance is currently ready. Scale-to-zero systems intentionally allow the second answer to be "none" while the service remains operable. Requiring a warm instance to keep connection health green converts an optional latency/cost tradeoff into a false availability requirement.

PDPP's dynamic browser runtime should therefore treat a successful, bounded allocator `listSurfaces()` read as current evidence that the allocator API is reachable and returned a valid inventory response. That read does not prove free capacity, successful future container creation, profile-specific startup, CDP readiness, or provider collectability; those deeper facts are established only by lease acquisition, allocator `ensureSurface`, and the run-scoped readiness probe. Active lease/surface failure remains current fail-closed evidence. A prior ready-to-released receipt remains historical proof of a particular run, never a substitute for current allocator capability and never a reason to revive a retired surface row.

Static runtimes differ: when there is no allocation control plane that can create a replacement on demand, current instance readiness can legitimately remain load-bearing. Non-browser connectors have neither concern and must not inherit browser-runtime uncertainty.

Credential-boundary continuity is adjacent but not reducible to health projection. A successful allocator probe, a replacement lifecycle receipt, and a prior successful run cannot prove that provider authentication crossed a browser-process boundary. The current connector/runtime interface has no generic, provider-safe export/import contract for portable authenticated state; the active retention design instead avoids ordinary replacement, while unexpected process loss remains non-green and creates no owner action without provider proof. The replacement incidents therefore require two separate outcomes: PDPP can make every replacement causally auditable without secrets, while durable session transfer remains open until the connector-runtime credential boundary owns an explicit restoration contract and proves it with forced replacement of two isolated connections. That restoration must run and pass the connector's authenticated-session probe before owner action; DOM or profile-presence heuristics cannot substitute. Health must not turn green by treating either a profile mount or an old success as that proof.
