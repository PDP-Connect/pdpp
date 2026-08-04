// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import Link from "next/link";
import { PdppConceptFooter } from "@/components/pdpp-concept/footer.tsx";
import { SPEC_EDITORS, SPEC_STATUS_STAMP } from "@/components/pdpp-concept/spec-status.ts";

export const metadata: Metadata = {
  description: "How the PDPP standard changes, its implementations, maintainers, and licensing.",
  title: "Participate - PDPP",
};

const changeSteps = [
  {
    body: "A non-trivial protocol, contract, or architecture change is written as an OpenSpec change (why, what changes, what it impacts) before any code. Design and code land together and stay in lockstep.",
    title: "Spec-first",
  },
  {
    body: "All changes to protocol text, the reference implementation, and the site go through public PRs. Commits follow Conventional Commits; breaking-change markers are reserved for the intentional 1.0 milestone.",
    title: "Public pull requests",
  },
  {
    body: "Maintainers act as editors for the current draft. A change must pass the CI merge gate; new behavior comes with tests that exercise the observable contract.",
    title: "Review",
  },
  {
    body: "Open questions move through a public consultation opening after the LFDT Labs review, before the durable contract is pinned.",
    title: "Consultation period",
  },
] as const;

const implementations = [
  {
    href: "https://github.com/PDP-Connect/pdpp/tree/main/reference-implementation",
    linkLabel: "Source",
    name: "Reference implementation",
    status: "Draft v0.1.0 · proving",
    type: "Forkable AS/RS substrate",
  },
  {
    href: "https://dtinit.org/",
    linkLabel: "DTI",
    name: "Data Connect",
    status: "Complementary · composes",
    type: "Portability & transfer interface",
  },
  {
    href: "https://vana.org/",
    linkLabel: "Vana",
    name: "Vana network",
    status: "Independent adopter",
    type: "Deployed personal-data network",
  },
] as const;

const maintainers = [
  { name: "Art Abal", scope: "Specification and repository governance" },
  { name: "Anna Kaz", scope: "Specification and repository governance" },
  { name: "Tim Nunamaker", scope: "Specification, reference implementation, repository governance" },
] as const;

const licenses = [
  { artifact: "Reference implementation (code)", license: "Apache-2.0" },
  { artifact: "Specification text", license: "Community Specification License 1.0 (CSL-1.0)" },
  { artifact: "Documentation", license: "CC-BY-4.0" },
] as const;

export default function ParticipatePage() {
  return (
    <>
      <main className="pdpp-page">
        <aside aria-label="Document apparatus" className="pdpp-rail">
          <div className="pdpp-rail__block">
            <span className="pdpp-stamp">{SPEC_STATUS_STAMP}</span>
          </div>
        </aside>

        <article className="pdpp-doc">
          <p className="pdpp-eyebrow">Participate</p>
          <h1>Participate</h1>
          <p className="pdpp-lede">PDPP changes through public pull requests, spec-first.</p>

          <section
            className="pdpp-section"
            id="how-it-changes"
            style={{ borderTop: "none", marginTop: 56, paddingTop: 0 }}
          >
            <h2>How the standard changes</h2>
            <p>
              The repository holds a strict authority order: the root <code>spec-*.md</code> files define normative
              protocol semantics; code and tests define what the reference actually does; OpenSpec changes under{" "}
              <code>openspec/</code> record architecture decisions. Web spec pages are downstream copies.
            </p>
            <div className="pdpp-ruled-list">
              {changeSteps.map((step, i) => (
                <div className="pdpp-ruled-list__item" key={step.title}>
                  <div className="pdpp-ruled-list__num">{String(i + 1).padStart(2, "0")}</div>
                  <div className="pdpp-ruled-list__body">
                    <h3>{step.title}</h3>
                    <p>{step.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="pdpp-section" id="raise-a-question">
            <h2>Raising a question</h2>
            <p>Open questions about the draft are tracked as issues on GitHub, the only list we keep.</p>
            <p>
              Read the open issues before filing. Open a new issue with the part of the specification the question
              applies to and what a reader cannot currently decide from the text. Questions about governance,
              adoption, and conformance are in scope alongside protocol questions.
            </p>
            <p>
              Maintainers respond in the issue. Where a question changes normative text, the resolution arrives as a
              pull request against the <code>spec-*.md</code> files, following the process above. The public
              consultation after the LFDT Labs review will be conducted in the tracker.
            </p>
            <p>
              <a href="https://github.com/PDP-Connect/pdpp/issues" rel="noopener noreferrer" target="_blank">
                Open issues on GitHub →
              </a>
            </p>
          </section>

          <section className="pdpp-section" id="implementations">
            <div className="pdpp-section__head">
              <div className="pdpp-section__num">◇</div>
              <div className="pdpp-section__title">
                <p className="pdpp-eyebrow">Ecosystem</p>
                <h2>Implementations</h2>
              </div>
            </div>
            <p>Distinct realizations of the protocol, each listed on identical terms. The specification is the authority.</p>
            <table className="pdpp-impl-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {implementations.map((impl) => (
                  <tr key={impl.name}>
                    <td>{impl.name}</td>
                    <td>{impl.type}</td>
                    <td className="pdpp-status">{impl.status}</td>
                    <td>
                      <a href={impl.href} rel="noopener noreferrer" target="_blank">
                        {impl.linkLabel} →
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="pdpp-small">Each entry realizes or composes with the protocol at a different point.</p>
          </section>

          <section className="pdpp-section" id="maintainers">
            <div className="pdpp-section__head">
              <div className="pdpp-section__num">§</div>
              <div className="pdpp-section__title">
                <p className="pdpp-eyebrow">Governance</p>
                <h2>Maintainers</h2>
              </div>
            </div>
            <p>
              For the root protocol specifications, active maintainers act as editors for the current draft.
              Maintainer changes are proposed through pull request.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Scope</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {SPEC_EDITORS.map((name) => {
                  const entry = maintainers.find((m) => m.name === name);
                  return (
                    <tr key={name}>
                      <td>{name}</td>
                      <td>{entry?.scope}</td>
                      <td className="pdpp-status">Active</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <section className="pdpp-section" id="license">
            <div className="pdpp-section__head">
              <div className="pdpp-section__num">©</div>
              <div className="pdpp-section__title">
                <p className="pdpp-eyebrow">Terms</p>
                <h2>License &amp; governance</h2>
              </div>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Artifact</th>
                  <th>License</th>
                </tr>
              </thead>
              <tbody>
                {licenses.map((row) => (
                  <tr key={row.artifact}>
                    <td>{row.artifact}</td>
                    <td>{row.license}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p>
              PDPP is developed under PDP-Connect, an LF Decentralized Trust Lab, so the specification's governance
              sits with a neutral, multi-stakeholder foundation. The reference implementation and connectors remain
              open source and forkable under that umbrella.
            </p>
            <p>
              <Link href="/docs">Read the specification →</Link>
            </p>
          </section>
        </article>
      </main>

      <PdppConceptFooter />
    </>
  );
}
