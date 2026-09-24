# Mobile / PDPP connector feasibility

**Date:** 2026-09-24
**Status:** Source investigation snapshot. The inspected Mobile implementation runs hosted JavaScript through PageShim and writes owner-data scope versions. The inspected Desktop path runs Collection Profile connectors in a Node process and ingests individual `$pdpp` records. These are distinct execution and destination contracts.
**Scope:** Local Core and Collection Profile specifications, the inspected `data-connectors` revision, and Unity Mobile/Desktop implementations. Production release behavior and store acceptance were not observed.

## Summary of the inspected contracts

[PDPP Core §5](../../spec-core.md#source-declaration) defines a `SourceDeclaration` as the source identity and consent/data contract: `source.id` is authorization identity, `source.kind` is provenance metadata, `declaration_version` is an opaque exact revision, and streams define schemas, record semantics, primary keys, selection, and query capabilities. Core grants retain the accepted declaration revision and freeze authorization terms. Core does not define connector execution, runtime bindings, or collection method. Core §1 and §9 describe the protocol conformance boundary; a connector-backed source conforms by producing a valid declaration and serving data through a conformant resource server.

The [Collection Profile v0.1.0](../../spec-collection-profile.md) is explicitly informative and adds collection/runtime metadata and a reference process protocol. Its manifest `runtime_requirements.bindings` maps binding names to requirement objects, including `required: boolean` and optional binding-specific fields; it declares what a connector asks a compatible runtime to provide. The Profile runtime compares those declarations with its own capabilities and supplies descriptors for required bindings in START. The Profile contains no standard manifest field that binds a Profile artifact to a Core SourceDeclaration revision. Its text describes runtime matching and descriptors (including `browser_automation` with CDP); the Profile uses normative “must” language for implementations of that Profile runtime contract, but this does not add a Core conformance requirement. The inspected `data-connectors` implementation uses Node and its JSONL connector protocol; browser-mode connectors use Playwright. The Profile v0.1 standard browser binding is named `browser_automation`; the inspected Meta manifest names its required binding `browser`. Playwright is an implementation choice, not a Core requirement or the only collection method permitted by the Profile.

A declaration, a Profile manifest requirement, and a host capability are therefore separate data. A declaration describes what data can be consented to; a Profile requirement describes runtime services requested by an artifact; a host capability is what a particular runtime actually implements and exposes. A requirement declaration does not itself grant a capability or enforce it. In the Profile runtime model, the host compares requirements with its capabilities and supplies binding descriptors. Mobile PageShim exposes its own `page.*` API and current catalog metadata; it does not advertise or provide the Profile's CDP browser binding or a Node process environment.

The inspected Unity checkout contains seven Mobile scripts byte-identical to the corresponding legacy Desktop scripts (`chatgpt`, `spotify`, `linkedin`, `github`, `oura`, `icloud_notes`, `instagram`). This is script-copy reuse between two existing hosts. It is evidence that those particular scripts use a compatible `page` surface; it does not establish reuse of modern Collection Profile collectors. The inspected modern Meta connector uses Playwright directly and its artifact differs from the legacy Mobile Instagram script.

The companion [independent review](mobile-pdpp-connector-feasibility-review-2026-09-24.md) is a historical review of the earlier draft and is unchanged by this dossier revision.

## The seams are separate

| Concern | Current Mobile behavior | Collection Profile / signed OCI behavior | Observed boundary |
|---|---|---|---|
| Artifact delivery and trust | Index and versioned JS arrive from the selected Mobile HTTPS origin. Same-origin and size/redirect bounds are enforced. There is no independent signature verification; the current accepted trust root is the Mobile deployment. | Connector catalog resolves OCI digests. Installer code verifies cosign/Sigstore identity, signature payload digest, and Rekor evidence before installation. | The inspected Mobile trust root is its selected deployment origin. OCI signature verification establishes properties of the verified OCI artifact and identity; it does not establish which bytes a separate Mobile origin serves. |
| Execution | `PageShim` exposes navigation, evaluation, user actions, scoped HTTP fetch, capture hooks, progress and JSON result. Provider session lives in a per-owner native WebView profile. | `runConnector` uses a Node process and JSONL over stdin/stdout. Browser-mode connectors receive Playwright `Page` and `BrowserContext` objects. Runtime modules also implement lifecycle, validation hooks, and protocol handling. | These interfaces differ. OCI packaging/signing does not supply a Mobile host API. |
| Scope and declaration admission | Closed Mobile catalog rows define Mobile source id, login URL, cookie domain, supported scopes, and runtime version. The script receives the approved scopes. | Profile manifests define connector identity/version, streams, and runtime requirements. Core declarations define the authorization identity and consented stream contracts. Core `declaration_version` is opaque and unrelated to connector software version. | The inspected Mobile catalog does not itself constitute a Core SourceDeclaration or Profile-manifest binding. Matching labels alone do not establish equal identity or record semantics. |
| Data and schema ingestion | Connector result JSON is split by scope and written via `toOwnerDataBody`; Mobile ingest does not call `buildCollectionProfileEnvelopes`. | Desktop reads the installed manifest, resolves a retained declaration, checks stream fulfillment, validates/annotates each record, then posts one `$pdpp` envelope per record to Personal Server `/v1/data/:scope`. | Mobile writes encrypted owner-data scope versions through its owner-data client; Desktop posts individual records through the PDPP ingestion endpoint. The transports and stored representations differ. |

This split is grounded in `apps/mobile-shell/lib/connect/connector_catalog.dart`, `page_shim.dart`, `connect_run.dart`, `export_sink.dart`, `apps/mobile/src/features/personal-server/owner-data-ingest.ts`, `apps/desktop/src/services/collectionProfilePdppIngest.ts`, `packages/app-runtime/src/sources/pdpp-collection-profile-ingest.ts`, and `/home/tnunamak/code/data-connectors/packages/polyfill-connectors/src/connector-runtime.ts`.

## Profile data and Mobile implementation status

This table separates Profile metadata and contracts from Mobile behavior observed in the inspected implementation.

| Profile information or runtime contract | Current Mobile status |
|---|---|
| Connector identity, software version, display name, stream names and summaries | Mobile catalog has its own source identifiers, metadata, scopes, and `runtimeVersion`. The inspected catalog has no Core declaration revision binding. |
| Stream schemas, primary keys, `semantics`, required/optional status, labels, and query affordances | Present in Profile manifests; the Mobile owner-data write path does not call the Profile `$pdpp` validator/annotator. |
| Core SourceDeclaration revision and `$pdpp` provenance | These are Core authorization/data provenance concepts. They are absent from the inspected Mobile owner-data writer. The Profile v0.1 manifest does not standardize their association with a connector artifact. |
| `human_interaction: manual_action` and Profile INTERACTION protocol | Mobile has a manual login path. That UI is not, by itself, a Profile INTERACTION/INTERACTION_RESPONSE protocol bridge. |
| Profile `network` and `browser_automation` bindings | Mobile exposes PageShim operations and provider-origin network/capture behavior. It does not expose the Profile CDP WebSocket descriptor or declare a corresponding binding capability. |
| Node runtime, Node imports, `process`, filesystem, executable entrypoints | Not provided by the inspected PageShim execution environment. |
| Playwright `Page`, `BrowserContext`, cookie APIs, locators, request/response lifecycle | Not the Mobile PageShim API. PageShim has overlapping browser actions and bounded capture hooks; it does not expose the full Playwright context or response-wait interface. |
| Credentials and auth strategies (`static_secret`, provider authorization, environment injection) | The inspected Mobile connector JS receives no host credentials or process environment; provider login resides in the owner WebView session. |
| `STATE`, checkpoints, refresh modes, coverage and terminal outcomes | The Profile defines these in its process protocol. The inspected Mobile output contract returns JSON scope results and does not implement the Profile state/checkpoint protocol. |
| Filesystem/manual-upload setup | The inspected PageShim contract has no local filesystem or file-picker binding. |

The current Meta (Instagram) artifact exposes these differences in one source: its Profile declares network and browser requirements and five streams. The collector uses Playwright browser context for session cookies and waits for responses matching profile and timeline GraphQL calls. The older Mobile Instagram script is PageShim-style JavaScript, but is not the same source or current collector. The inspected sources do not establish code reuse or output equivalence between them.

Evidence: `/home/tnunamak/code/data-connectors/connectors/meta/manifest.json`, `/home/tnunamak/code/data-connectors/connectors/meta/index.ts`, `/home/tnunamak/code/data-connectors/connectors/meta/schemas.ts`, and `/home/tnunamak/code/data-connectors/packages/polyfill-connectors/src/connector-runtime.ts`; Mobile precedent: `/home/tnunamak/code/unity-surfaces/apps/mobile/public/connectors/instagram-2.2.1.js`, `/home/tnunamak/code/unity-surfaces/apps/mobile/public/connectors/index.json`, and `/home/tnunamak/code/unity-surfaces/apps/mobile-shell/lib/connect/page_shim.dart`.

## Current implementation details

### Seven legacy scripts

The Mobile catalog lists `chatgpt`, `spotify`, `linkedin`, `github`, `oura`, `icloud_notes`, and `instagram`. In the inspected Unity checkout, each listed script is byte-identical to the corresponding legacy Desktop script. Mobile evaluates these scripts using PageShim; this does not make the scripts a shared package, nor does it bind them to a Collection Profile manifest or Core declaration.

### Meta / Instagram artifacts

The inspected `data-connectors` checkout is at `a48e3b2aa9`; its Meta manifest is version `0.3.3`, has `network` and `browser` required bindings, declares `manual_action`, and contains five streams: `profile`, `posts`, `post_likes`, `following`, and `ads`. Its collector uses Playwright context/session behavior and provider response handling. The dossier's retained local Profile evidence file is version `0.4.0`, so it is a separate snapshot from that checkout.

Unity's retained local Instagram declaration is identified by `https://registry.pdpp.dev/connectors/instagram`, revision `0.1.0-local`, and has `profile` and `posts` streams. In that declaration, `posts` is one snapshot record containing a `posts` array. Meta's Profile uses `https://registry.pdpp.dev/connectors/meta`; its `posts` stream describes per-post records and the Profile has additional streams. Unity's local ingestion adapter resolves `manifest.connectorId` to a retained declaration source id, compares the manifest software `version` with the version stored alongside that local declaration, then checks stream membership. This is a Unity-local mapping; the Profile v0.1 specification does not define it. The Profile specifications do not define display-name or stream-label equality as an identity or compatibility rule.

Evidence: `/home/tnunamak/code/data-connectors/connectors/meta/manifest.json`, `/home/tnunamak/code/data-connectors/connectors/meta/index.ts`, `/home/tnunamak/code/data-connectors/connectors/meta/schemas.ts`, `/home/tnunamak/code/data-connectors/packages/polyfill-connectors/src/connector-runtime.ts`; Unity declaration and ingest: `/home/tnunamak/code/unity-surfaces/packages/app-runtime/src/sources/pdpp-source-declarations.ts` and `pdpp-collection-profile-ingest.ts`.

### Destination contracts

The Mobile path in `apps/mobile/src/features/personal-server/owner-data-ingest.ts` converts each non-empty scope to an owner-data request. `owner-data-client.ts` creates an encrypted data-file envelope, publishes it to storage, and advances an on-chain scope version. The Desktop path in `apps/desktop/src/services/collectionProfilePdppIngest.ts` posts each validated `$pdpp` record to Personal Server `/v1/data/:scope`. A `$pdpp` block added to the Mobile owner-data body would not, by itself, demonstrate that the Personal Server PDPP endpoint accepted or validated that record. Calling the owner-data write once per record would also differ from the inspected current per-scope write behavior.

### OCI distribution and trust

The Data Connectors installer resolves catalog entries to OCI digests and verifies configured cosign/Sigstore identity, signature payload digest, and Rekor evidence before install. The installed OCI artifact is a signed distribution object. The Desktop runner supplies its execution environment. Neither the OCI signature nor the Profile runtime declaration makes Node, Playwright, filesystem, or CDP capabilities available in a different host. Mobile's current hosted script flow accepts its selected deployment origin as the executable-code trust root and snapshots fetched bytes for a run; it does not verify OCI signatures on-device. Off-device verification of an OCI input and subsequent publication of a Mobile bundle would attest to the upstream verification/build process only to the degree that build and publication receipts bind the exact input and output digests; the device would still trust its configured origin unless it verifies an independently signed release artifact.

## Unresolved questions

These questions were not answered by the inspected specifications and source code:

- Which exact retained SourceDeclaration revisions, if any, are associated with current Data Connectors artifacts, and how is that association represented in the deployed manifest/catalog?
- What are the precise mapping rules between a Mobile catalog source/scope and a Core `source.id` plus declaration stream, including existing grants and stored records?
- What Personal Server endpoint and stored representation would accept Mobile-originated declaration-backed `$pdpp` records, and what acknowledgement, idempotency, retry, partial-write, and read-back behavior would it expose?
- How does the inspected Meta manifest binding name `browser` relate to the Profile v0.1 standard binding name `browser_automation` in the data-connectors runtime and release artifacts?
- Which Mobile host operations correspond to each Profile binding and capability, and which declared requirements have no Mobile equivalent? How is any mapping enforced at the execution boundary?
- What exact transformed or bundled artifact would be distributed to Mobile, and what receipt would bind its source OCI digest, build inputs, output digest, signer identity, catalog entry, and prepared run bytes?
- What store-policy outcome would apply to the concrete Mobile distribution and execution design, and what evidence would reviewers require?
- Which connector operations, if any, are shared as source code between the current Profile collector and the PageShim script, beyond the seven identical legacy script pairs?
- What output equivalence criteria apply when comparing a modern Profile connector with a legacy Mobile collector, including pagination, empty and partial results, authentication, and errors?
- How do Mobile ordinary-connect completion and Direct continuation acknowledgement relate to destination-confirmed delivery of every approved scope?

## Policy and security boundary

The existing hosted-Mobile plan knowingly accepts the Mobile origin as the executable-code trust root and already lists store-review risk. Current Apple Guideline 2.5.2 says apps may not download or execute code that adds or changes app features or functionality; Apple's Developer Program Agreement permits some interpreted code under purpose/security constraints, while separately restricting additional features. Google Play explicitly exempts interpreted JavaScript in a WebView from its executable-bytecode download restriction, but runtime-loaded interpreted code must still comply with policy and its abuse examples include a WebView JavaScript interface loading untrusted content or unverified URLs. These texts do not establish guaranteed approval or rejection for this product. The outcome of store review for a concrete hosted-connector design remains unresolved.

Signatures provide publisher-identity and artifact-integrity evidence for the signed object. They do not establish runtime safety, constrain native-bridge authority, or resolve store-policy treatment of a particular update. The inspected design uses a host-owned native bridge, same-origin artifact selection, and per-owner provider profiles.

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
