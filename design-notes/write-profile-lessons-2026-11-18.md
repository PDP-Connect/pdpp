# Writes in PDPP: lessons from a first real use case, and prior art

**Status:** notes for later, written 18 November 2026. Not normative. A companion to the [draft write profile](../spec-write-profile.md) on this branch. A deployment that wanted apps to write health data into owners' stores tested the draft's ideas against a concrete product plan. These notes keep what that taught about PDPP itself, plus a wider survey of how other systems handle app writes. Nothing here is a decision.

## Summary

1. The party that authors a source's declaration is that source's authority. If an operator authors an app's declaration at first and the app takes over later, the `source.id` or the source kind can change at the handoff, and every existing read grant then names a source that no longer matches. The app should be the authority for its own source from the start. An operator can still review and approve the declaration, because [Declaration acceptance](../spec-core.md#declaration-acceptance) already allows acceptance "through explicit owner or operator onboarding" without the operator authoring anything.
2. App-authored content needs its own source kind. `provider_native` requires that `source.id` equal a protected-resource identifier that the authorization server already accepted, and an app writing into an owner's store is not serving its own protected resource. The draft's `provider_push` covers a platform pushing its users' data, which is a different case. [Source kinds](../spec-core.md#source-kinds) lets a profile add one.
3. Type and source are separate questions. Any app may write any type of data, but only into its own source. A record under another party's source claims that the other party wrote it. Apple HealthKit and Android Health Connect make the same split.
4. Interoperability is the job of the app that defines the schemas, not of the protocol. PDPP carries whatever schemas a source declares. A schema gives field names and types, but two valid schemas for the same lab test still need a hand-written mapping between them. Shared vocabularies (LOINC for lab tests, UCUM for units) close that gap. The profile could make them easy to declare without requiring them.
5. An implementation should not route app writes through its collector ingest path. Collector ingest checks a registered acquisition method, so it either refuses app writes or, if an app is registered as a collector, labels app data as collected data. Writes need their own path, with server-stamped attribution.
6. An authorization server that keeps one grant per owner–client pair cannot give an app separate read and write grants with separate lifetimes, purposes and revocation. PDPP's per-purpose read grants already need grant objects that are separate from the owner–client relationship; writes need the same.
7. The draft is weaker than PDPP's rules for reads in seven places, listed below. Close them before proposing the profile.

## 1. Source authority, and why it must not move

Every PDPP record belongs to a source, and every read grant names the source by `source.id`. A grant also records the declaration version that the owner approved ([version layering](../spec-core.md#version-layering)), and the resource server enforces the grant without fetching the declaration again.

One plausible rollout lets an operator author declarations for the first apps that write data, and lets apps publish their own declarations later. That plan moves source authority from the operator to the app at the second step. If the identifier or the source kind changes then, existing read grants break. If the identifier stays but authority moves, the old declaration versions were authored by a party that is no longer the authority, and it is unclear who may revise them.

The safer pattern:

1. The app is the authority for its own source from the first write. The `source.id` derives from the app's identity.
2. The app authors every declaration version for that source.
3. An operator may review and approve declarations through Declaration acceptance. Approval is a gate, not authorship.
4. Moving from operator-delivered declarations to app-published declarations then changes only the delivery channel. Identifiers, records and grants stay the same.

Open: how a `source.id` derives from an app's identity in a way that is stable across key rotation, and what a declaration from an app looks like when the app has no protected resource of its own.

## 2. A source kind for app-authored content

Core's source kinds today are `connector` (a collector fetches data from a platform) and `provider_native` (a platform serves its own data as a resource server). The draft adds `provider_push` for a platform that pushes its users' data into each owner's store. None of these fits an app that creates content, or computes results, and writes them into the owner's store.

A profile-defined kind for app-authored content would say:

1. The authority is the app, bound to the app's client identity at the authorization server.
2. The source holds only what the app wrote. Collectors never write into it.
3. Attribution is always server-stamped, and signatures are optional.
4. Derived results point back to the records they came from, through the derived-sources lineage pointer, if that draft lands.

Name candidates: `app_authored`, `client_authored`. The name should not suggest that the data is less trustworthy than collected data, only that its origin is an app.

## 3. Any type, own source

Platforms that let third-party apps write personal data converge on one rule: the writer is recorded by the platform and cannot be faked, and each app is confined to what it wrote.

1. Apple HealthKit records each sample's source in an [`HKSourceRevision`](https://developer.apple.com/documentation/healthkit/hksourcerevision) that the platform assigns. An app deletes only objects it saved.
2. Android Health Connect fills [`DataOrigin.packageName`](https://developer.android.com/reference/androidx/health/connect/client/records/metadata/DataOrigin) "at insertion time". Its data types are a [closed list](https://developer.android.com/health-and-fitness/health-connect/data-types).
3. Android Contacts keeps one raw contact per account and computes the merged view. An app should "change data only for those raw contacts that you own" ([Contacts Provider](https://developer.android.com/guide/topics/providers/contacts-provider)). Apps may add their own data kinds.
4. Google Fit let apps define [custom data types](https://developers.google.com/fit/datatypes/custom), but "only the app that defines the data type can read and write data of this type". Private types gave confinement and no interoperability.
5. The Hub of All Things gives each app its own namespace, and other namespaces need a [data debit](https://docs.dataswyft.com/build/dataswyft-one-apis/data-api/data-debits).
6. Google Drive's [`appDataFolder`](https://developers.google.com/workspace/drive/api/guides/appdata) and Dropbox's app folder confine an app to its own area. Drive also separates `properties`, "visible to all applications", from `appProperties`, "restricted to your app" ([properties](https://developers.google.com/workspace/drive/api/guides/properties)).
7. Counterexamples: Microsoft Graph `Calendars.ReadWrite` covers every event in the user's calendars ([permissions](https://learn.microsoft.com/en-us/graph/permissions-reference)). Solid WAC grants write per resource "regardless of creator identity" ([WAC](https://solidproject.org/TR/wac)). SMART on FHIR leaves cross-app writes to server policy ([scopes](https://hl7.org/fhir/smart-app-launch/scopes-and-launch-context.html)).
8. AT Protocol names record types with DNS-rooted identifiers ([Lexicon](https://atproto.com/specs/lexicon)) and scopes OAuth to a collection, with optional create, update and delete actions ([permissions](https://atproto.com/specs/permission)). Its repositories are public, so it is a reference for naming and scoping, not for privacy.

PDPP fits the HealthKit and Health Connect pattern: a source per app gives confinement, and declared schemas give readability. The question PDPP adds is how a reader finds and trusts an app's declaration.

## 4. Interoperability belongs to the schema author

A schema gives a reader field names and types. It does not say that two fields mean the same thing. One app writes `{"hb": 13.2, "unit": "g/dL"}`, and another writes `{"hemoglobin_g_per_l": 132}`. Both are valid, and a third app that charts haemoglobin still needs a hand-written mapping and a unit conversion for each writer. Ten writers and ten readers need up to a hundred mappings; with a shared code per concept, each side maps once.

PDPP should not require shared vocabularies: the protocol carries data, and each app chooses schemas that work for the apps it wants to reach. The profile could still help:

1. A declaration could annotate a field with a concept identifier, such as a LOINC code or a UCUM unit, without changing its schema. Readers that understand the annotation use it, and others ignore it.
2. Operator review at Declaration acceptance is a natural place to ask for shared codes in a domain where they exist.

Evidence on how hard shared codes are:

1. FHIR R4 binds `Observation.code` to LOINC only at "Example" strength ([Observation](https://hl7.org/fhir/R4/observation.html)). The US Core lab profile says "A LOINC SHALL be used if the concept is present in LOINC" and takes units from UCUM ([US Core lab](https://hl7.org/fhir/us/core/StructureDefinition-us-core-observation-lab.html)).
2. An audit of 179,537,986 lab results in the PCORnet network found a 4.6% LOINC mapping error rate; chemistry 0.4%, hematology 7.5% ([JAMIA 2023](https://academic.oup.com/jamia/article/30/2/301/6809034)).
3. Mapping at read time with a language model is weaker: a GPT-4 retrieval pipeline picked the correct LOINC code first for 74.2% of about 2,000 local lab names ([arXiv 2502.08547](https://arxiv.org/abs/2502.08547)). General schema matching scores lower ([SMAT](https://arxiv.org/html/2205.09911v2), [Schemora](https://arxiv.org/pdf/2507.14376)).
4. Translating between schema versions at read time, as Cambria proposes, is unmeasured: "We have not yet measured Cambria's performance in any formal way" ([Cambria](https://www.inkandswitch.com/cambria/)).
5. Shared-schema efforts in personal data stores have mostly stalled. An implementer reports "in practice I haven't seen others that are interoperable out of the box" ([PDS Interop](https://pdsinterop.org/practice/)). A Solid shape-versioning issue has been open since 2021 ([issue 206](https://github.com/solid/data-interoperability-panel/issues/206)). remoteStorage deprecated its shared modules ([modules](https://github.com/remotestorage/modules)).
6. Open mHealth deprecates a schema in place with `supersededBy` ([schemas](https://github.com/openmhealth/schemas)). Event-schema registries such as Snowplow validate at write time and divert failures ([failed events](https://docs.snowplow.io/docs/understanding-your-pipeline/failed-events/)).
7. A registry that keeps the first schema for a name permanently, with no versions, blocks evolution. PDPP's versioned declarations avoid that.

## 5. Write path, attribution and mechanics

The draft's mechanics hold up against prior art. Additions and corrections from the survey:

1. Idempotency keys: Stripe accepts keys up to 255 characters and may prune them after 24 hours ([Stripe](https://docs.stripe.com/api/idempotent_requests)). Retention elsewhere ranges from 10 minutes (Azure Service Bus default) to 45 days (PayPal). No vendor documents what happens to keys when access is revoked; the profile should.
2. The IETF Idempotency-Key draft has not expired: [version 08](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/08/) is dated 22 October 2026 and expires 25 April 2027. It answers 409 for a concurrent request with the same key and 422 for a different payload. The draft's section 11 says otherwise and needs fixing.
3. Batches: Microsoft Graph returns 200 for a batch whose inner requests failed ([JSON batching](https://learn.microsoft.com/en-us/graph/json-batching)); DynamoDB returns `UnprocessedItems` ([BatchWriteItem](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_BatchWriteItem.html)). Per-record results, as the draft has, are the norm.
4. Revocation races in-flight writes. Zanzibar-style systems use a consistency token so a check is at least as fresh as a given write ([SpiceDB](https://authzed.com/docs/spicedb/concepts/consistency)). Google Cloud IAM changes take "typically 2 minutes, potentially 7 minutes or longer" ([propagation](https://docs.cloud.google.com/iam/docs/access-change-propagation)). The draft's 60-second bound plus "each accepted write commits or fails" is a clear contract; the profile should say which moment counts as acceptance.
5. Local-first systems can stop only future writes after revocation ([UCAN](https://ucan.xyz/revocation/), [Keyhive](https://www.inkandswitch.com/keyhive/notebook/), [Willow](https://willowprotocol.org/specs/meadowcap/index.html)). That matches "revocation erases nothing".
6. Open write channels attract abuse. Calendar invitations became a spam channel, and a 2024 report found "about 300 organizations with more than 4,000 emails sent over four weeks" through calendar notifications ([Check Point](https://blog.checkpoint.com/securing-user-and-access/google-calendar-notifications-bypassing-email-security-policies/)). Email answered with sender authentication and graduated policy (DKIM, DMARC). Owner-granted writes avoid the open channel, but per-writer quotas and rate limits still matter.
7. Bulk removal by writer is the main recovery tool in shared stores: OpenStreetMap reverts whole changesets ([Changeset](https://wiki.openstreetmap.org/wiki/Changeset)); Wikipedia offers rollback of one editor's latest edits ([Reverting](https://en.wikipedia.org/wiki/Help:Reverting)). Server-stamped attribution makes "remove everything this app wrote" possible.
8. Platforms change write APIs. Facebook cut publishing for "roughly 60,000 apps" in 2018 ([Facebook](https://developers.facebook.com/blog/post/2018/07/31/platform-update-publish-permission/)); Google Fit's REST API is deprecated with "no alternative" ([FAQ](https://developer.android.com/health-and-fitness/health-connect/migration/fit/faq)). An owner's store that accepts writes under the owner's grant does not depend on one platform's policy.

## 6. Privacy, agents and law

1. Attribution can leak. If every reader sees the writer's client ID and grant ID, one app learns which other apps the owner uses. PDPP reads avoid stable cross-app identifiers. The profile should hide or pair-wise the writer identity by default, and let a read grant ask for it.
2. Written content is untrusted input for an AI agent that reads it. The Model Context Protocol says "clients MUST consider tool annotations to be untrusted unless they come from trusted servers" ([MCP tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)). Defenses sit in the reading agent ([Spotlighting](https://arxiv.org/abs/2403.14720), [CaMeL](https://arxiv.org/abs/2503.18813)). Attribution says who wrote a record, not that it is safe to follow.
3. Law is starting to name a right to write. The European Health Data Space regulation, Article 5, lets a person insert information into their health record, labelled as patient-inserted and unable to alter clinician data ([Regulation (EU) 2025/327](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32025R0327)). A PDPP write profile is a natural carrier for that right.
4. Correction and erasure: GDPR Articles 16 and 17 give rights to rectification and erasure. Append-only stores need a deletion story; crypto-shredding (destroy the key, not the data) is one pattern ([EDPB Guidelines 02/2025](https://www.edpb.europa.eu/documents/guideline/guidelines-022025-on-processing-of-personal-data-through-blockchain_en)). No standard surveyed defines what happens to derived data after an input is erased.
5. Where written data is stored, and which data-residency laws apply, is a deployment question, not a protocol one. Deployments serving health data in some jurisdictions will need to answer it before accepting writes.

## 7. Where the draft is weaker than PDPP's rules for reads

1. Reads have consent-rendering rules. The draft has none for write requests.
2. A read grant is fixed to the declaration version that the owner approved. The draft does not say which version a write grant is fixed to, so a new version could widen what an app may write.
3. The attribution example exposes the writer's `client_id` and `grant_id` to every reader, with no default limit (see section 6).
4. Read grants carry a purpose. Write grants carry none.
5. No server metadata, error catalogue, versioning, conformance cases or test vectors.
6. No source kind for app-authored content (section 2).
7. Section 11 calls the IETF Idempotency-Key draft expired (section 5, item 2).

## 8. Ideas to explore later

1. App-authored source kind, with authority bound to the client identity (section 2).
2. Operator approval of app-authored declarations through Declaration acceptance, as the standard onboarding path (section 1).
3. Optional concept annotations on declared fields, for shared vocabularies without mandates (section 4).
4. Grant objects separate from the owner–client relationship: one per read purpose and one per write target, each revocable alone.
5. Pair-wise or hidden writer identity by default in attribution (section 6).
6. A read-only outcome lookup after revocation, so a writer learns whether an in-flight request committed.
7. Per-writer quotas, and the unit question already in the draft's open questions.
8. A write profile as the carrier for patient-inserted data under laws like EHDS Article 5.

## 9. Open questions added by this review

1. How does an app's `source.id` derive from its identity, stably across key rotation?
2. Is operator approval of an app's declaration a Core concept (Declaration acceptance) or a profile concept?
3. Should concept annotations be part of the write profile, or a separate schema-annotation profile that reads can use too?
4. What is the moment of acceptance for a write, relative to the 60-second revocation bound?
5. What does a reader see about a record's writer by default?

## How confident to be

The survey quotes were read from the linked primary pages on 18 November 2026, some through page summaries, so a few may differ slightly from the source text.
