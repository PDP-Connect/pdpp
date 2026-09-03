# Claude Code build prompt — pdpp.dev four-intent site + interim Supporter signing

Paste everything below into Claude Code, run from the pdpp repo root.

---

Implement the new pdpp.dev site and the interim Supporter signing system in this repo, on a branch off main once #267 has merged. Two sources: the Claude Design export at design_handoff_pdpp_site/PDPP Site.dc.html is the visual source of truth; design_handoff_pdpp_site/pdpp-dev-prototype-v3.html is the source of truth for structure and copy, to be carried over verbatim, EXCEPT for the copy deltas listed under "Copy deltas" below, which supersede the prototype. Where the two sources disagree on words, the prototype (as amended by the deltas) wins; on appearance, the design wins. No em-dashes anywhere.

Routes and navigation. /, /principles, /specification, /build, /participate, /review, /privacy. /governance keeps working and lands on the governance anchor of /specification. Nav is four items: Principles, Specification, Build, Participate, with a Specification dropdown holding "The specification" and "Review, until 1 Oct". A full-width banner under the header links to /review. The dropdown entry and banner are behind one config flag, reviewOpen. Nothing outside /review and the reader's version strip references the review period.

Content from the repo. /specification renders spec-core.md in the reader, with a contents rail listing Core §1 to §9, the three informative documents under "Implementer guidance, informative", and Appendix A. The governance section renders root GOVERNANCE.md as today. /principles renders root PRINCIPLES.md for the preamble and the six principles. Do not duplicate that text in site source.

Principles edit. In PRINCIPLES.md, after "rarely reversible in practice." insert: "The party relying on the information carries the same uncertainty, since it holds no reliable record of what was consented to, for what purpose, or by whom." Nothing else changes.

Pages. Build every page and section as in the prototype, including the OAuth-versus-grant comparison on the home page and the governance diagram on /specification as components rather than images. Fix the wordmark typo "Portabilty". Remove any page, route, component or copy the prototype does not have, including the old How it works page and standalone governance page, and any reference to Official Source, Steward or a recognition route. Grep the built site for "§" outside the reader and /review and remove section citations from site copy.

Supporter signing, interim architecture. All behind config flag signingLive, default off.

Private store. Create a private GitHub repository PDP-Connect/supporters-private. Access is restricted to the maintainers listed in MAINTAINERS.md and to one deploy key. Enable branch protection on main, require signed commits, disable forking, and turn on secret scanning. Add a README.md stating that the repo holds personal data under the interim arrangement, who may access it, and the handover and deletion procedure. Nothing in this repo is ever mirrored, cached or copied to the public site repo except through the publish script below.

Endpoint. A Vercel serverless function at /api/sign. It validates against a strict schema, rate-limits by IP, rejects organisation submissions whose email is not at the organisation's domain, and rejects anything else. It writes a pending record to a short-lived store (Vercel KV or equivalent) and sends one confirmation email through a transactional provider set in config, containing a signed single-use link that expires in 48 hours. No other email is ever sent by this system.

Confirmation. On a valid link, the function writes one JSON file per signatory to the private repo via the deploy key, path signatories/<yyyy>/<id>.json, fields: display name as entered, computed public name (first name and last initial for individuals, organisation name for organisations), organisation, signatory name and role, email, country, type, the four consent flags, Principles version, confirmed-at timestamp. The commit is made by a bot identity with a clear message. The deploy key has write access to this repo only and is stored as a Vercel secret, never in the site repo.

Withdrawal. The confirmation email carries a signed withdraw link. It deletes the signatory's file and appends the date only to withdrawn.log. Withdrawal takes effect on the public site at the next publish.

Publish. scripts/publish-supporters.mjs, run by a scheduled GitHub Action in the private repo, reads signatories/, writes /principles/supporters.json containing only public name, type, country, date signed and Principles version, and commits that single file directly to main of the public site repo as a bot. No PR, no other files touched. Ship the public JSON as an empty array.

Mailing list. The "email me about new versions" checkbox stores a flag only. Ship scripts/export-list-optins.mjs in the private repo, runnable by a maintainer, that outputs opted-in addresses once for a future subscribe to the LFDT list. Do not build any sending.

Disclosure. Under the form, from config: "Your details are held by [controller] on behalf of PDP-Connect until LF Decentralized Trust hosting is confirmed, and will be transferred then. We never publish your email." /privacy states controller, purposes, what is stored, what is published, retention until withdrawal or transfer, the confirmation and withdrawal mechanism, and a contact address, all from config.

Handover. docs/registers.md in the public repo documents the three stores (private signatory repo, public supporters JSON, external mailing list), the data flow, who has access, and the step-by-step procedure to export the private repo to a successor controller, rotate the deploy key, and delete the repo.

Conformance register. /register/index.json shipped as an empty array and /register/trust-registries.json with one entry, the Data Transfer Initiative's Data Trust Registry, both rendered on /participate. Both are PR-driven and hold no personal data. Create issue templates apply-source.md, apply-accessor.md, apply-operator.md under .github/ISSUE_TEMPLATE/, each listing what to attach per GOVERNANCE.md Appendix A. The Operator apply button stays disabled with its date until config flag operatorApplications is on.

Config. All of the following come from environment or a single config file, with visible placeholders in the UI until set: form endpoint, email provider, controller name, general contact address, Discord URL, mailing list URL, reviewOpen, signingLive, operatorApplications. Reports link to pdpp-dev-reports@lfdecentralizedtrust.org.

## Additions from the design session

Brand assets. The wordmark in the design export's header and footer is a plain-text placeholder. Use the existing pdpp logo assets and font loading from this repo (packages/pdpp-brand/ and the site's next/font setup). Never redraw, approximate or substitute the logo. Fonts follow the repo, not the design export's Google Fonts links.

Theme. Light and dark modes using the repo's existing azure scheme tokens, with a moon/sun toggle at the right of the nav, persisted (localStorage, key pdpp-theme). In dark mode the footer flips to the light-blue panel with dark ink, as on the current live site.

Review banner. The full-width banner is an animated marquee ticker on the accent ground: the message plus "Review it now →" repeating, separated by a "/" glyph with wide gaps (~120px), one slow continuous loop (~55s), the whole bar one link to /review. Respect prefers-reduced-motion by pausing it. Behind reviewOpen like the rest.

Home hero. Right of the hero text, reuse the current site's scrolling data-columns animation component (three mono columns: sleep records, artist plays, chat threads) rather than rebuilding it from the design export's approximation. Masked fade top and bottom.

Copy deltas (supersede the prototype file):
1. Delete the "Working sessions / In person" comment channel on /review, and every other mention of working sessions ("Discord, mailing list, working sessions, comments." becomes "Discord, mailing list, comments."; "Channels and sessions" becomes "Channels and contacts").
2. On /review, replace "Every comment is logged and answered: accepted, declined with a reason, or parked. All answers are published in one log." with "Every comment is logged in one public log. Substantive comments are answered: accepted, declined with a reason, or parked, and the answers are published there too." Also change "we may hold further sessions or one-to-one conversations" to "we may hold one-to-one conversations with commenters."
3. Delete the sentence "It is one document of nine sections, about an hour to read, and every comment gets a published answer." from the /review lede.
4. Section headings carry no ordinal numbering (no "01", "02" prefixes). Numbers that are content stay: the six principles, Step 1-4, Level 1-3, spec § numerals inside the reader.
5. The footer General contact is its own address (config: general contact), never the reports address.

Verify. Run pnpm spec:check and confirm prebuild passes. Confirm that a grep of the public repo and the built site finds no email addresses other than the reports mailbox and no contents of the private repo. Open a PR titled "Site: four-intent structure, interim Supporter signing, Participate and registers, temporary Review page" with a summary of each route, a description of the signing data flow, and a checklist of config values still needing real settings.
