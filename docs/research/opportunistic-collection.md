Memo: PDPP Collection Layer, Orchestrator Boundary, and Grant Semantics

This memo captures the design thinking we converged on across the recent PDPP review work. It is not a spec proposal. It is a steering memo: what the architecture appears to be, what the strongest version of it is, what should stay normative, what should stay in the reference runtime, and what should remain deferred. It builds on the current status map, the collection-layer boundary note, the collection prior-art deep dive, the boundary experiments, and the conformance-suite discussion.    

1. The main architectural conclusion

PDPP now has a coherent split:

Core spec defines the consent, grant, disclosure, and resource-server semantics.

Collection Profile is a separate normative companion that defines one specific fulfillment mechanism: a bounded connector run with START, RECORD, STATE, INTERACTION, and DONE.

Reference runtime / orchestrator is allowed to grow beyond that profile, but only as reference architecture unless a real wire-level interoperability need emerges.  


That split is already reflected in the repo classification work: only spec-core.md and spec-collection-profile.md are currently normative; the rest are informational, experimental, reference, or implementation detail. The status-map work was valuable because it made that explicit instead of leaving it implicit in sidebar layout or author memory.  

2. What the Collection Profile really is

The current Collection Profile is best understood as a Run Profile.

Its load-bearing properties are:

bounded lifecycle

explicit START

explicit terminal DONE

STATE only committed on successful completion

binding matching before spawn

connector-side scope limits

runtime/RS backstop for enforcement

explicit INTERACTION support for credentials / OTP / manual steps

explicit SKIP_RESULT rather than silent omission.  


That model is not arbitrary. It is the part of PDPP’s collection design that is unusually well matched to collection from systems the user does not control, especially when browser automation and interactive login are involved. The prior-art review found support for both split-profile and unified-ingestion designs, but the strongest fit for PDPP today was to keep the bounded-run model primary and avoid collapsing it into a generic collector framework. 

3. What is shared across collection modes

The most important design insight from the boundary work is that some semantics are broader than the Run Profile and should remain stable regardless of collection mode:

RECORD envelope

stream semantics

tombstones

grant-related scope semantics

semantic classes for consent surface rendering

state/checkpoint semantics

ingest endpoint. 


Those are the pieces that should survive future profiles or runtime evolution. If PDPP later adds a push/subscription mode, import mode, or something else, those modes should reuse this substrate rather than redefining it. The collection-layer note explicitly treats these as shared semantics housed in Core today. 

4. Protocol specs versus reference-runtime architecture

One of the biggest clarifications we landed on is that not everything the reference implementation does needs to become spec surface.

The right test is:

> Does this affect wire-level interoperability between independently built implementations?



If yes, it likely needs a spec or profile.
If no, it is runtime/orchestrator architecture and can remain implementation-local. 

This matters because there was a real temptation to assume “everything important we build should eventually get a spec.” The status map and boundary note both argue against that. The cleaner principle is: everything should have a clear status, but only interoperable contracts should become normative.  

The current best layer split is:

Core: normative protocol semantics

Collection Profile: normative bounded-run collection contract

Shared semantics: stable concepts reused across profiles

Reference runtime / orchestrator: scheduling, retries, buffering, secret handling, coordination, browser lifecycle, etc.

Implementation detail / product UX: concrete technology choices and visual design.  


5. Prior art: what it really supported

The prior-art deep dive found support for two broad strategies:

1. Split by lifecycle / delivery mode


2. Unify under a general collector framework 



The strongest evidence for split profiles came from SET, SSF, WebSub, SCIM, and the modular OAuth ecosystem. These all support keeping a stable message or management layer while allowing different delivery/lifecycle contracts where needed. The memo’s bottom-line recommendation favored keeping the bounded-run profile primary and adding thin sibling profiles only when actual demand materializes.  

The strongest evidence for unified frameworks came from OpenTelemetry Collector, Kafka Connect, Airbyte, Debezium, NiFi, and log/event collectors. But the deep dive’s judgment was that these are most elegant when the operator controls both sides of the pipeline, whereas PDPP often operates against non-cooperating platforms and needs strong consent-coupled boundaries. That made the current run model a better immediate fit.  

My own synthesis after that research is:

At the spec layer, profiles are cleaner than turning PDPP into a generalized orchestrator standard.

At the reference-implementation layer, building a richer orchestrator is entirely fair, and probably desirable. The orchestrator can be more general than the spec surface it proves.  


6. The orchestrator question

We explicitly separated two questions that had been getting blurred:

Should PDPP standardize a general ingestion/orchestration runtime?

Should the reference implementation grow into one?


The answer we landed on is:

No, PDPP should not currently standardize the orchestrator.

Yes, the reference implementation can and probably should become a stronger orchestrator. 


That distinction is important. The orchestrator may end up being a more powerful and elegant system than the current Collection Profile, but that does not mean the orchestrator itself should become the normative center of the project. Otherwise PDPP stops being mainly a protocol with auditable consent boundaries and starts becoming a platform specification. The current architecture avoids that by keeping the orchestrator in the reference layer unless and until a true interoperability contract emerges.  

7. What the boundary experiments proved

The three runtime experiments were:

webhook-to-pull adapter

file import tool

scheduler / orchestration module.  


The important result was not “these are universally solved.” It was narrower:

> none of these experiments introduced a new interoperable wire-level contract.



The webhook adapter and file import tool both just transform input into RECORDs and use the existing POST /v1/ingest/{stream} path with owner-token auth. The scheduler wraps the existing run machinery rather than extending the Collection Profile itself. That is strong evidence that push-like ingestion, import, and orchestration can remain runtime concerns for now. 

The right summary is therefore:

the experiments support the current boundary,

but they do not prove that no future profile will ever be needed,

they only show that no new profile is justified yet.  


8. Push profile versus runtime adaptation

We considered whether push/webhook delivery should already become a new companion spec.

The current best answer is no, not yet.

The boundary note gave a good standard: a Push/Subscription Profile should be created only when there is a real interoperable sender/receiver contract to define. Until then, webhook ingestion can remain a runtime-local adaptation that writes through the existing ingest path. 

This keeps the project disciplined:

do not write speculative specs,

do not multiply profiles prematurely,

and do not pretend runtime conveniences are yet cross-implementation contracts. 


9. Import profile versus runtime import

We also considered whether file/archive import should become its own companion profile.

My current recommendation is more conservative than some of the draft notes:

import is clearly outside the current Run Profile,

but it does not yet deserve its own normative profile just because it exists. 


The better rule is:

keep import runtime-local for now,

pressure-test it through reference implementation and real formats,

and only specify an Import Profile if repeated interoperability pain appears around archive validation, mapping, or ingest contracts. 


So import is a valid collection mode, but not yet proven to need a separate spec.

10. The conformance-suite lesson

The conformance discussion surfaced an important discipline:

derive tests from the spec text, not from current implementation habit

let the implementation prove the claims, not redefine them. 


The current conformance work is valuable precisely because it closes the “truth gap” between nice prose and observable behavior. But it should be described honestly: the suite is a real start, not yet a full validation story, especially while any infrastructure issues keep parts of it from running cleanly end-to-end. 

The deeper point is that Collection Profile value is not academic. It becomes materially valuable when its load-bearing claims are:

normative in the spec,

reflected in the runtime,

and mechanically checked by the suite.  


11. Grant semantics, owner archive, and opportunistic collection

This was the most subtle part of the discussion.

We explored whether a personal server should be allowed to collect more than a client grant needs, if the extra collection is for the user’s own archive and the client still only sees the granted subset.

The stricter position

The stricter spec position is:

grant-driven collection scope should stay narrow and derived from the grant,

broader archival should sit on a separate owner-directed basis,

and the client grant should not be treated as authorizing both. 


This is the strongest spec design because it keeps the grant maximally legible and preserves a clean future architecture even if the polyfill problem fades and native APIs become normal.

The personal-server correction

But we also recognized that a personal server is the user’s agent, not just another third-party backend. That changes the practical judgment.

The strongest revised position is:

a personal server may legitimately maintain a broader archive than any one client may access,

and it may be reasonable to exploit the same authenticated session or collection pass for both client fulfillment and owner-directed archival,

but the system should still preserve a separate logical basis for those two purposes.


The critical distinction is not necessarily separate physical runs. It is separate logical accounting:

what was collected to satisfy the app right now,

versus what was collected for the user’s archive.


That means:

narrow app disclosure remains strict,

broader archive may exist,

but the semantics should not blur so much that a narrow client grant appears to explain both.


So the net result is:

For the spec, keep the stricter semantics.

For the runtime, allow more operational flexibility if useful, as long as the distinction remains explicit and the client’s access never broadens.  


I think that is the strongest long-term answer because it separates normative semantics from personal-server optimization.

12. What still needs doing

At this point, the remaining work is mostly not more theory. It is:

1. finish and deepen the Collection Profile conformance suite


2. continue building the orchestrator as reference architecture


3. improve landing/reference clarity around acquisition modes and user value


4. keep the Collection Profile narrow until new interop pressure actually appears


5. only then consider second-wave additions like connector trust/provenance or data_class.   



13. Final recommendation

The strongest design position we reached is this:

Core stays the normative center for consent, grants, and disclosure.

Collection Profile stays the normative bounded-run companion for connector-driven acquisition.

Shared collection semantics remain stable across future modes.

Reference runtime/orchestrator is free to grow more powerful, but should not silently become spec surface.

Push/import/scheduler behavior remain runtime-local until they create real interoperability contracts.

Client grants stay narrow in the spec.

Broader owner-directed archival may be allowed in the runtime, but only as a distinct logical basis, never by broadening the client’s access.


That is, in my judgment, the cleanest version of the architecture that is both honest today and extensible later.   