# Mobile / PDPP connector feasibility

**Date:** 2026-09-24
**Assessment:** Current Node/Playwright Collection Profile artifacts cannot run unchanged in Mobile. OCI remains useful as a signed distribution input. A future Mobile target could share provider collection code through a common browser API, as all seven legacy Mobile scripts already do with Desktop; how much modern Profile code can use that API remains unproven. Signed delivery, execution, and `$pdpp` ingestion are separate contracts.
**Confidence:** High that current OCI code cannot execute directly in Mobile; medium that the bounded sharing pilot will be useful. No numeric schedule is established.
**Scope:** Source investigation only. No Mobile implementation is in progress; the Desktop cutover is independent and higher priority.

## Recommendation

Pure provider parsers and record builders are the simplest first extraction. A common browser-facing collector is also a credible option: Mobile already runs unchanged copies of seven legacy Desktop scripts by emulating their limited `page` API. The modern Meta collector instead uses Playwright directly, so sharing its whole collector needs a deliberate API adaptation and proof. The signed OCI bytes cannot execute unchanged in Mobile. See the [independent review](mobile-pdpp-connector-feasibility-review-2026-09-24.md) for the declaration, destination, and DCR gates before any Mobile cutover.

The installed Mobile shell already runs bounded JavaScript in a native-owned provider WebView. It fetches a same-origin connector index and script, checks a closed metadata schema and supported `runtimeVersion`, snapshots the resolved script for the run, and executes it through `PageShim`. The shell already has an execution lease for ordinary connects and Direct continuations, per-owner browser profiles, and a writer that uses the product WebView's owner authority. Preserve those contracts.

Evaluate one provider collector with two host adapters:

1. **Desktop adapter:** current Collection Profile runtime, Node/Playwright browser context, stdin/stdout protocol, state/checkpoints, schema validation, and Desktop `$pdpp` ingestion.
2. **Mobile adapter:** a PageShim-compatible bundle using the current visible provider WebView, manually initiated login, Mobile scope allowlist, and Mobile-native owner-data writer.

The seven old shared scripts prove that collection code can be portable across these hosts when authored against a common `page` subset. It does not make the modern Profile entrypoint portable. The Collection Profile is collection-method neutral and informative for PDPP Core conformance, but its own v0.1 run contract specifies a spawned process with stdin/stdout JSONL; its standard `browser_automation` binding specifies a CDP WebSocket. Mobile would need a bridge or a separately packaged target to honor that contract. Playwright itself is a choice of the current data-connectors implementation, not a Collection Profile requirement.

Use the signed Collection Profile and its retained declaration as the source for portable identity, stream, schema, primary-key, semantics, and provenance facts. Compile or package Mobile-compatible code separately. A published signature proves artifact identity and integrity; it does not make the program's runtime APIs available on Mobile, make its declared capabilities enforceable, or validate records at the Personal Server boundary.

Keep Desktop stage 1's installer, runtime, admission, and rollout on its own track. The eventual shared logic may benefit both hosts, but no Mobile work is a prerequisite for Desktop stage 1 and Desktop stage 1 should not wait for it.

Three facts limit the Mobile option today. First, Meta's modern Desktop collector depends on Playwright session and response events, so pure parsing and record construction are the easiest first shared units; a shared browser collector needs an adapter proof. Second, Meta's Profile source ID and per-post record shape differ from Mobile's current Instagram declaration and single snapshot record; names alone cannot preserve existing grants or data. Third, Mobile writes encrypted owner-data scope versions, while Desktop sends individual `$pdpp` records to the Personal Server. A Mobile connector build cannot claim PDPP or DCR parity until the declaration mapping, destination acceptance, and full approved-scope delivery are proven. These are feasibility constraints, not work queued for the current Desktop cutover.

There is also a strong reuse precedent: all seven scripts in `apps/mobile/public/connectors/index.json` (`chatgpt`, `spotify`, `linkedin`, `github`, `oura`, `icloud_notes`, `instagram`) are byte-identical to their corresponding legacy scripts in `apps/desktop/connectors/` in the inspected Unity checkout. This is copy reuse across two host adapters, not a shared package or a PDPP Profile. It proves that two platform-specific provider collectors are not inherently necessary. A future Profile implementation might reuse a common provider collection core through both hosts, with host-specific browser, session, and output adapters. The first pilot must establish how much of the modern Profile collector can use that common core; Meta's Playwright coupling makes an automatic whole-connector build an unsafe assumption.

## The seams are separate

| Concern | Current Mobile behavior | Collection Profile / signed OCI behavior | Migration consequence |
|---|---|---|---|
| Artifact delivery and trust | Index and versioned JS arrive from the selected Mobile HTTPS origin. Same-origin and size/redirect bounds are enforced. There is no independent signature verification; the current accepted trust root is the Mobile deployment. | Connector catalog resolves OCI digests. Installer code verifies cosign/Sigstore identity, signature payload digest, and Rekor evidence before installation. | Choose whether Mobile verifies signatures itself or trusts an audited release pipeline that copies verified inputs. Do not describe same-origin HTTPS as signed artifact verification. |
| Execution | `PageShim` exposes a narrow page API: navigation, evaluate, user actions, scoped HTTP fetch, capture hooks, progress and JSON result. Provider session lives in a per-owner native WebView profile. | `runConnector` is a Node process. Browser profiles are Playwright contexts; START and INTERACTION_RESPONSE arrive on stdin, messages leave on stdout. It expects Node modules, filesystem/runtime support, and the Playwright `Page`/`context` API. | OCI installation is not execution compatibility. Mobile needs a host adapter or a different runtime build. |
| Scope and declaration admission | Closed Mobile catalog rows define Mobile source id, login URL, cookie domain, supported scopes, and runtime version. The script receives the approved scopes. | Profile manifests define connector identity/version and streams; separate retained Source Declarations define the exact declaration revisions and authorization mapping. | Map profile streams to Mobile scopes explicitly. Do not equate a source id or matching stream label with grant compatibility. |
| Data and schema ingestion | Connector result JSON is split by scope and written via `toOwnerDataBody`; Mobile's ingest does not call `buildCollectionProfileEnvelopes`. | Desktop reads the verified installed manifest, resolves the exact retained declaration, checks that it fulfills the selected stream, validates/annotates each record, then writes one `$pdpp` envelope per record. | A successful Mobile connector run is not proof of PDPP declaration-backed data. Add a separate Mobile ingestion adapter before claiming that parity. |

This split is grounded in `apps/mobile-shell/lib/connect/connector_catalog.dart`, `page_shim.dart`, `connect_run.dart`, `export_sink.dart`, `apps/mobile/src/features/personal-server/owner-data-ingest.ts`, `apps/desktop/src/services/collectionProfilePdppIngest.ts`, `packages/app-runtime/src/sources/pdpp-collection-profile-ingest.ts`, and `/home/tnunamak/code/data-connectors/packages/polyfill-connectors/src/connector-runtime.ts`.

## What is portable from a Collection Profile

“Portable” below means the fact or data contract can be represented on Mobile. It does not mean the Mobile shell currently enforces or implements it.

| Profile information or requirement | Portability | Needed Mobile work |
|---|---|---|
| `connector_id`, `connector_key`, profile version, display name, stream names, summaries | High | Resolve to a Mobile catalog projection; bind it to a pinned profile revision and exact connector artifact. |
| Stream JSON Schemas, primary keys, `semantics`, required/optional status, field labels, and query affordances | High as metadata | Apply schemas and primary-key rules on the Mobile ingest path. Only expose selection/query behavior where the current Mobile UI and writer implement it. |
| Exact Source Declaration revision and `$pdpp` provenance digest | High as data; currently absent from the Mobile writer | Retain the declaration bytes/revision and use the existing shared annotator or a behavior-equivalent path. Never derive provenance from the latest label or the artifact version alone. |
| `human_interaction: manual_action` | Partial | Map to the current manual login sheet and explicit completion action. General INTERACTION requests need typed host UI and a response bridge. |
| Network/browser bindings | Partial | Mobile's WebView provides provider-origin browsing and scoped host operations; the profile's broad `network`/`browser` declaration is not a Mobile-enforced egress policy. Need a narrower capability mapping and actual enforcement. |
| Node runtime requirements, imports, `process`, filesystem, executable entrypoints | Not portable | Replace with a Mobile build target/adapter or add a different supported JS runtime. Current PageShim does not provide Node or a local filesystem API. |
| Playwright `Page`, `BrowserContext`, cookie APIs, locators, request/response lifecycle | Partial and connector-specific | Adapt only operations with equivalent Mobile capabilities. Meta currently reads `context.cookies()` and waits for specific GraphQL responses; Mobile has capture hooks but does not expose Playwright's full context or `waitForResponse` contract. |
| Credentials and auth strategies (`static_secret`, provider authorization, env injection) | Not portable by default | Require a separately designed Mobile-native credential ceremony and secure bridge. Current Mobile explicitly avoids host credentials/process environment in connector JS and preserves owner login in the provider WebView. |
| `STATE`, checkpoints, incremental/full refresh, coverage and terminal outcomes | Conceptually portable; runtime contract absent | Define durable Mobile state, retry/partial-coverage semantics, and write-confirmed checkpoint advancement. Do not silently ignore state and claim Profile parity. |
| Filesystem/manual-upload setup | Not portable through current PageShim | Add a native picker/staging capability with scoped file authority, or defer those connectors on Mobile. |

The current Meta (Instagram) artifact is a useful stress case. Its Profile declares network and browser requirements and five streams. The collector uses Playwright's browser context for session cookies and waits for responses matching the profile and timeline GraphQL calls. The older Mobile Instagram script is already PageShim-style JavaScript and can run in the shell, but it is not the same source or the same current collector. Updating Meta therefore needs source sharing or a deliberate port and parity proof; copying the OCI entrypoint into Mobile is not an adapter.

Evidence: `/home/tnunamak/code/data-connectors/connectors/meta/manifest.json`, `/home/tnunamak/code/data-connectors/connectors/meta/index.ts`, `/home/tnunamak/code/data-connectors/connectors/meta/schemas.ts`, and `/home/tnunamak/code/data-connectors/packages/polyfill-connectors/src/connector-runtime.ts`; Mobile precedent: `/home/tnunamak/code/unity-surfaces/apps/mobile/public/connectors/instagram-2.2.1.js`, `/home/tnunamak/code/unity-surfaces/apps/mobile/public/connectors/index.json`, and `/home/tnunamak/code/unity-surfaces/apps/mobile-shell/lib/connect/page_shim.dart`.

## Option assessment

### A. Build a Mobile-compatible target from shared connector logic — recommend

**Feasibility:** Proven for whole legacy collector scripts across the seven current Mobile sources; medium for a bounded pure-parser and record-builder extraction from modern Profiles; plausible but unproven for a common modern browser collector. PageShim is already a runtime for a curated class of browser-session connectors, but Meta's current collector depends heavily on Playwright lifecycle and browser APIs. The pilot must measure useful sharing rather than assume it.

**Do not overstate the reuse.** Current Data Connectors modules import `node:*`, `@pdpp/connector-protocol`, and Playwright and delegate lifecycle/protocol to `runConnector`. The Mobile legacy script is a self-contained function against `page.*`. A build target has to make the shared part real: shared provider request/parsing/normalization code, plus a Desktop runtime adapter and a Mobile PageShim adapter. Otherwise “shared implementation” only means a copied/ported connector and leaves two behavior paths to drift.

**Main risks:** connector-specific API gaps; behavior drift during source extraction; silently widening the scope set; profile schemas being declared but not enforced on Mobile; and the host artifact trust model remaining the deployment origin unless signature verification is added at an explicit boundary.

### B. Host signed OCI PDPP profiles directly in Mobile — do not choose

**Feasibility:** Low as a direct path. The artifact is a signed package format, not a mobile execution ABI. Current Desktop starts a bundled Node process, passes a JSON START message on stdin, reads protocol records from stdout, provides Playwright, and gates output against the installed profile. Mobile has none of that runner contract. Implementing Node plus compatible Playwright/browser-process semantics inside the iOS/Android shell would be a second and much larger runtime project, with OS-specific packaging and lifecycle costs. A Mobile WebView running JS does not supply Node modules, child processes, or Playwright's `BrowserContext` API.

**Main risks:** large native/runtime surface; credentials or filesystem capability crossing a new bridge; adapter mismatches misreported as Profile-compatible execution; store-policy uncertainty; and entangling Mobile release and Desktop stage 1 around a runtime Mobile does not need.

**Where B can still help:** use signed OCI as a verified upstream source for release tooling or for a future host that actually implements the Profile runtime. If a release pipeline extracts/compiles from OCI into a Mobile PageShim bundle, that output is Option A's Mobile target. Keep the signature and build provenance receipt separate from runtime compatibility and record ingestion.

## Incremental migration and order

1. **Keep today's Mobile contract.** Continue using its hosted catalog, PageShim, per-owner WebView profiles, single coordinator/continuation lease, approved scope list, and owner-data write path. The current migration document already requires exact script snapshots, no arbitrary JS through the privileged bridge, and no change to the current provider flow.
2. **Check declaration compatibility in shadow mode.** For one pilot source, compare exact retained declaration revisions, profile streams, current grants, and Mobile scope semantics without refusing legacy runs. Active admission waits until the destination and data migration contracts are proven.
3. **Pilot only the portable part of one connector.** Extract pure request parsing, normalization, and record building from host lifecycle. A simpler connector may prove the build pattern; Meta is the harder compatibility case because of Playwright coupling and its different Instagram data shape. Keep the current Mobile script active until the compatible target passes the same fixtures and a physical-device run.
4. **Design the destination before any Mobile cutover.** Specify an owner-authorized Personal Server import for Profile records, or a tested translation from Mobile owner-data scope versions into PDPP records. Enforce exact declaration and stream fulfillment, schema and primary-key validation, idempotency, retry, and partial-write behavior. Merely calling `buildCollectionProfileEnvelopes` inside Mobile's existing `writeScope` path would not prove that the PDPP importer accepts the records. Preserve legacy ingestion for unmigrated sources.
5. **Prove and migrate source-by-source.** Compare Mobile and Desktop outputs for the same fixtures; then prove account/session behavior, approved-scope behavior, profile binding, schema refusal, partial/empty streams, cancellation, owner transitions, and writes on physical iOS and Android. Replace a legacy Mobile script only after its current user journey still works and the Profile-backed records pass the destination validator.
6. **Keep signature work orthogonal.** Decide whether Mobile's trust root is (a) its selected first-party Mobile deployment, with an auditable verified-OCI-to-hosted-build pipeline, or (b) native verification of a signed catalog and artifact digest before every new run. Do not add a fallback to unsigned scripts. Signing does not grant runtime APIs or ensure declaration conformance.

**Order:** preserve Mobile execution → map profile/declaration requirements → shared logic pilot → declaration-backed ingestion → source-by-source rollout → separately decide Mobile runtime signature verification. Desktop stage 1 proceeds independently on its existing signed OCI/Node path.

## Effort and risk

Do not schedule the fleet migration from this investigation. The bounded pilot must first measure how much of one connector's parsing and record building can be shared, and prove the destination, grants, DCR acknowledgement, and iOS/Android behavior. Meta is a high-risk pilot because its collection loop depends on Playwright session and response events. A direct Mobile Node/Playwright host additionally needs a new execution ABI, browser binding, isolation model, and store review; it does not remove the record-ingestion work. No measured implementation or device evidence supports a numeric estimate yet.

## Policy and security boundary

The existing hosted-Mobile plan knowingly accepts the Mobile origin as the executable-code trust root and already lists store-review risk. Current Apple Guideline 2.5.2 says apps may not download or execute code that adds or changes app features or functionality; Apple's Developer Program Agreement permits some interpreted code under purpose/security constraints, while separately restricting additional features. Google Play explicitly exempts interpreted JavaScript in a WebView from its executable-bytecode download restriction, but runtime-loaded interpreted code must still comply with policy and its abuse examples include a WebView JavaScript interface loading untrusted content or unverified URLs. These texts do not establish guaranteed approval or rejection for this product. Treat store review as an unresolved release risk and provide an accurate description and review notes.

Signatures improve publisher identity and artifact integrity. They do not make code safe, reduce what a compromised connector can do through the native bridge, or resolve whether an update changes app functionality under store policy. Keep the native bridge narrow and host-owned; preserve same-origin artifact selection and the current per-owner provider profile boundary.

Primary sources: [Apple App Review Guidelines, 2.5.2](https://developer.apple.com/app-store/review/guidelines/), [Apple Developer Program License Agreement, §3.3.1(B)-(C)](https://developer.apple.com/support/terms/apple-developer-program-license-agreement/), [Google Play Device and Network Abuse policy](https://support.google.com/googleplay/android-developer/answer/16559646), [Android WebView guidance](https://developer.android.com/develop/ui/views/layout/webapps/webview), and [Android JavaScript bridge guidance](https://developer.android.com/develop/ui/views/layout/webapps/native-api-access-jsbridge).

The reusable findings are recorded at [mobile WebView and store policy research](</home/tnunamak/code/dotfiles/ai/research/mobile-runtime/mobile-webview-javascript-bridges-have-platform-and-store-policy-boundaries.md>) and indexed in `/home/tnunamak/code/dotfiles/ai/research/INDEX.md`. Other relevant corpus entries include:

- `/home/tnunamak/code/dotfiles/ai/research/connector-architecture/vana-needs-separate-runtime-and-scope-admission-for-published-pdpp-connectors.md`
- `/home/tnunamak/code/dotfiles/ai/research/connector-architecture/a-connector-artifact-should-embed-the-exact-declaration-revisions-it-fulfills-and-gate-each-run-on-the-revisions-live-grants-hold.md`
- `/home/tnunamak/code/dotfiles/ai/research/connector-architecture/oci-subject-is-a-singular-optional-descriptor-and-in-toto-subject-is-a-required-array-both-bind-by-exact-digest-with-no-native-range-or-multi-artifact-list.md`
- `/home/tnunamak/code/dotfiles/ai/research/connector-architecture/version-compatibility-declarations-diverge-refuse-vs-warn-by-ecosystem-k8s-crds-uniquely-support-serving-many-versions-simultaneously-via-a-conversion-layer.md`
- `/home/tnunamak/code/dotfiles/ai/research/connector-architecture/data-connectors-has-18-registered-legacy-connectors-but-only-eight-have-real-modern-replacements.md` — cautions against fleet-wide one-to-one legacy/profile assumptions.
- `/home/tnunamak/code/dotfiles/ai/research/connectors/pdpp-data-connect-should-ship-connectors-as-signed-oci-artifacts-with-sigstore-keyless-identity-tiered-trust-badges-and-strict-lockfile-pinning.md`
- `/home/tnunamak/code/dotfiles/ai/research/connectors/data-connectors-already-publishes-a-signed-oci-catalog-artifact-in-ci-with-zero-consumers.md`
- `/home/tnunamak/code/dotfiles/ai/research/connectors/oci-referrers-npm-provenance-and-hacs-show-signature-attachment-and-attestation-as-separate-objects-not-inline-index-fields.md`
- `/home/tnunamak/code/dotfiles/ai/research/connectors/oci-version-tags-are-mutable-and-digest-pinned-locks-do-not-follow-republished-content.md`
- `/home/tnunamak/code/dotfiles/ai/research/connectors/plugin-ecosystems-converge-on-thin-per-platform-artifact-with-host-side-install-time-selection-fat-bundles-and-runtime-fetch-are-exceptions.md`
- `/home/tnunamak/code/dotfiles/ai/research/connectors/mature-plugin-ecosystems-place-the-trusted-execution-runtime-in-a-separately-governed-project-or-the-product-never-in-the-content-repo.md`
- `/home/tnunamak/code/dotfiles/ai/research/cross-platform-connector-runtime/README.md` and `/home/tnunamak/code/dotfiles/ai/research/cross-platform-connector-runtime/04-browser-runtime-cross-os.md`
- `/home/tnunamak/code/dotfiles/ai/research/distributed-systems/durable-local-work-uses-sqlite-outbox-leases-and-destination-confirmed-checkpoints.md`

## Evidence paths

**Mobile execution and delivery**

- `/home/tnunamak/code/unity-surfaces/apps/mobile-shell/lib/connect/connector_catalog.dart` — hosted HTTPS index and script fetch, same-origin check, closed schema, supported runtime versions, scope subset, immutable script-byte snapshot.
- `/home/tnunamak/code/unity-surfaces/apps/mobile-shell/lib/connect/page_shim.dart` — the JS `page` contract used by the Mobile runner; no Node or Playwright runtime.
- `/home/tnunamak/code/unity-surfaces/apps/mobile-shell/lib/connect/network_capture.dart` — bounded, provider-origin response capture available to Mobile connectors.
- `/home/tnunamak/code/unity-surfaces/apps/mobile-shell/lib/connect/connect_run.dart` — run starts PageShim with approved scopes and sends resulting JSON to the existing sink.
- `/home/tnunamak/code/unity-surfaces/apps/mobile-shell/lib/connect/connect_coordinator.dart` and `/home/tnunamak/code/unity-surfaces/apps/mobile-shell/lib/connect/connector_execution.dart` — one coordinator, ordinary and continuation arbitration, prepared execution boundary.
- `/home/tnunamak/code/unity-surfaces/apps/mobile/public/connectors/index.json` and `/home/tnunamak/code/unity-surfaces/apps/mobile/public/connectors/instagram-2.2.1.js` — currently hosted Mobile catalog and PageShim-style legacy Instagram connector.
- `/home/tnunamak/code/unity-surfaces/docs/cutover/mobile-hosted-connectors-migration.md` — accepted Mobile origin trust model, immutable prepared script requirement, compatibility boundary, physical-device proof sequence, and explicit non-goals.

**PDPP runtime and artifact verification**

- `/home/tnunamak/code/data-connectors/packages/polyfill-connectors/src/connector-runtime.ts` — Node stdio protocol and shared runtime lifecycle; browser mode uses Playwright.
- `/home/tnunamak/code/data-connectors/connectors/meta/index.ts` and `/home/tnunamak/code/data-connectors/connectors/meta/manifest.json` — current Meta implementation, API dependencies, bindings, streams, and schemas.
- `/home/tnunamak/code/data-connectors/packages/connector-installer-core/oci-catalog.mjs` and `/home/tnunamak/code/data-connectors/packages/connector-installer-core/oci-verify.mjs` — digest resolution, pinned signing identity, cosign/Sigstore/Rekor verification, catalog validation.
- `docs/research/evidence/meta.collection-profile-0.4.0.json` — retained local copy of Meta Profile 0.4.0 examined for stream/schema shape.

**Schema and ingestion split**

- `/home/tnunamak/code/unity-surfaces/apps/mobile/src/features/personal-server/owner-data-ingest.ts` — per-scope legacy Mobile write path uses `toOwnerDataBody` and the owner-data client.
- `/home/tnunamak/code/unity-surfaces/packages/app-runtime/src/sources/pdpp-collection-profile-ingest.ts` — exact manifest/declaration resolution, stream binding, schema/primary-key validation, per-record envelopes.
- `/home/tnunamak/code/unity-surfaces/apps/desktop/src/services/collectionProfilePdppIngest.ts` — Desktop reads the installed verified Profile manifest and performs `$pdpp` record ingestion.

## Verification and limits

Inspected the current Unity Mobile files (clean in the local worktree), the current `data-connectors` checkout at `a48e3b2aa9` (the inspected Meta/runtime/OCI files were clean), the existing Mobile migration plan, prior signed-artifact receipts, and the research corpus. No code tests were run; this was a read-only architecture investigation. The supplied local Meta profile copy and source checkout are evidence snapshots, not proof of a production Mobile release or store acceptance. Physical iOS/Android parity, actual Mobile `$pdpp` writes, native verification cost, and App Review outcome remain unproven.
