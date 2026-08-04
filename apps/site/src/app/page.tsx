// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { PdppConceptFooter } from "@/components/pdpp-concept/footer.tsx";
import { PdppConceptMasthead } from "@/components/pdpp-concept/masthead.tsx";
import { SPEC_STATUS_STAMP } from "@/components/pdpp-concept/spec-status.ts";

export default function Home() {
  return (
    <div className="pdpp-concept">
      <PdppConceptMasthead />

      <div className="pdpp-hero">
        <div className="pdpp-hero__inner">
          <p className="pdpp-eyebrow">Personal Data Portability Protocol</p>
          <h1>PDPP is an open protocol for user-controlled access to personal data.</h1>
          <p className="pdpp-hero__lede">
            An application asks for specific data. The person grants it. A resource server holds the application to
            that grant and gives it a standing read surface to query until the person revokes it.
          </p>
          <p className="pdpp-hero__lede pdpp-hero__lede--placement">
            PDPP profiles OAuth 2.0 and RFC 9396, the same pattern as SMART on FHIR and Open Banking.
          </p>
          <p className="pdpp-hero__meta">
            <span className="pdpp-stamp">{SPEC_STATUS_STAMP}</span>
            <Link href="/docs">Read the specification →</Link>
          </p>
        </div>
      </div>

      <main className="pdpp-page pdpp-page--home">
        <article className="pdpp-doc">
          {/* 01 Definition */}
          <section className="pdpp-section" id="definition">
            <div className="pdpp-section__head">
              <div className="pdpp-section__num">01</div>
              <div className="pdpp-section__title">
                <p className="pdpp-eyebrow">Definition</p>
                <h2>Two halves, one act</h2>
              </div>
            </div>
            <p>
              Consent covers how a person grants access to specific data and how a resource server enforces that
              grant. The read surface covers what a granted client can then do: filter, project, follow
              relationships, sync incrementally, and introspect the schema. Both halves are normative. For developers
              and AI agents, the read surface is where the work happens.
            </p>
            <p>
              PDPP defines the <code>authorization_details</code> type for personal data under RFC 9396.
            </p>
          </section>

          {/* 02 Position / schematic */}
          <section className="pdpp-section" id="position">
            <div className="pdpp-section__head">
              <div className="pdpp-section__num">02</div>
              <div className="pdpp-section__title">
                <p className="pdpp-eyebrow">Position</p>
                <h2>The agreement layer</h2>
              </div>
            </div>
            <p>
              PDPP separates three concerns that other systems conflate: <b>authorization</b> (what was consented to,
              by whom, under which terms), <b>disclosure</b> (what a resource server returns for a valid grant), and{" "}
              <b>collection</b> (how the data arrived). The grant and the query interface are the normative core;
              collection is a companion mechanism.
            </p>

            <figure className="pdpp-schematic">
              <svg aria-labelledby="schematic-title schematic-desc" role="img" viewBox="0 0 640 430">
                <title id="schematic-title">PDPP layer cross-section</title>
                <desc id="schematic-desc">
                  An engineering cross-section: an application or AI client sends a selection request down and
                  receives granted data up, through the PDPP consent and authorization stratum, which is transported
                  over OAuth 2.0 and RFC 9396 above the data sources, transfer, and storage stratum.
                </desc>

                <g fill="none" stroke="var(--pdpp-concept-ink)" strokeWidth="1.25">
                  <rect height="66" width="480" x="40" y="24" />
                  <rect fill="var(--pdpp-concept-teal-wash)" height="66" stroke="var(--pdpp-concept-teal)" strokeWidth="1.5" width="480" x="40" y="170" />
                  <rect height="66" width="480" x="40" y="316" />
                  <line x1="200" x2="200" y1="316" y2="382" />
                  <line x1="360" x2="360" y1="316" y2="382" />
                </g>

                <g fill="var(--pdpp-concept-ink)" fontSize="12" letterSpacing="0.06em">
                  <text textAnchor="middle" x="280" y="62">
                    APP OR AI AGENT · CLAUDE, CHATGPT (VIA MCP)
                  </text>
                  <text textAnchor="middle" x="120" y="354">
                    DATA SOURCES
                  </text>
                  <text textAnchor="middle" x="280" y="354">
                    TRANSFER · DTI
                  </text>
                  <text textAnchor="middle" x="440" y="354">
                    STORAGE · SOLID
                  </text>
                </g>
                <g fill="var(--pdpp-concept-teal-on-wash)" fontSize="12.5" fontWeight="500" letterSpacing="0.06em">
                  <text textAnchor="middle" x="280" y="209">
                    PDPP · CONSENT &amp; AUTHORIZATION
                  </text>
                </g>

                <g fill="var(--pdpp-concept-teal)" stroke="var(--pdpp-concept-teal)" strokeWidth="1.25">
                  <line x1="232" x2="232" y1="94" y2="166" />
                  <path d="M232 166 l-3.5 -8 l7 0 z" />
                  <line x1="328" x2="328" y1="166" y2="94" />
                  <path d="M328 94 l-3.5 8 l7 0 z" />
                </g>
                <g fill="var(--pdpp-concept-ink-soft)" fontSize="11" letterSpacing="0.04em">
                  <text textAnchor="end" x="222" y="134">
                    selection
                  </text>
                  <text textAnchor="end" x="222" y="147">
                    request
                  </text>
                  <text textAnchor="start" x="338" y="134">
                    granted
                  </text>
                  <text textAnchor="start" x="338" y="147">
                    data
                  </text>
                </g>

                <g stroke="var(--pdpp-concept-ink-faint)" strokeDasharray="4 3" strokeWidth="1">
                  <line x1="40" x2="520" y1="276" y2="276" />
                </g>
                <g fill="var(--pdpp-concept-ink-soft)" fontSize="11" letterSpacing="0.04em">
                  <text textAnchor="middle" x="280" y="271">
                    OAuth 2.0 + RFC 9396 transport
                  </text>
                </g>

                <g fill="var(--pdpp-concept-ink-faint)" stroke="var(--pdpp-concept-ink-faint)" strokeWidth="1">
                  <line x1="556" x2="556" y1="24" y2="90" />
                  <path d="M556 24 l-3 7 l6 0 z" />
                  <path d="M556 90 l-3 -7 l6 0 z" />
                  <line x1="520" x2="562" y1="24" y2="24" />
                  <line x1="520" x2="562" y1="90" y2="90" />
                  <line x1="556" x2="556" y1="170" y2="236" />
                  <path d="M556 170 l-3 7 l6 0 z" />
                  <path d="M556 236 l-3 -7 l6 0 z" />
                  <line x1="520" x2="562" y1="170" y2="170" />
                  <line x1="520" x2="562" y1="236" y2="236" />
                  <line x1="556" x2="556" y1="316" y2="382" />
                  <path d="M556 316 l-3 7 l6 0 z" />
                  <path d="M556 382 l-3 -7 l6 0 z" />
                  <line x1="520" x2="562" y1="316" y2="316" />
                  <line x1="520" x2="562" y1="382" y2="382" />
                </g>
                <g fill="var(--pdpp-concept-ink-faint)" fontSize="11" letterSpacing="0.04em">
                  <text textAnchor="middle" writingMode="tb" x="574" y="61">
                    client
                  </text>
                  <text textAnchor="middle" writingMode="tb" x="574" y="207">
                    protocol
                  </text>
                  <text textAnchor="middle" writingMode="tb" x="574" y="353">
                    fulfillment
                  </text>
                </g>
              </svg>
              <figcaption className="pdpp-caption">
                PDPP defines the agreement layer: what a person consented to share, with whom, under which terms, and
                how that agreement is enforced.
              </figcaption>
            </figure>
          </section>

          {/* 03 Read surface / read-loop schematic */}
          <section className="pdpp-section" id="read-surface">
            <div className="pdpp-section__head">
              <div className="pdpp-section__num">03</div>
              <div className="pdpp-section__title">
                <p className="pdpp-eyebrow">Access</p>
                <h2>The read surface</h2>
              </div>
            </div>
            <p>
              A granted client gets a standing, fine-grained read surface: filterable, projectable,
              relationship-aware, incrementally syncable, and schema-introspectable. Every request is bounded by the
              grant. The effective filter is the intersection of what the person consented to and what the client
              asked for; a request can narrow the grant but never widen it.
            </p>

            <figure className="pdpp-schematic pdpp-schematic--loop">
              <svg aria-labelledby="readloop-title readloop-desc" role="img" viewBox="0 0 680 260">
                <title id="readloop-title">PDPP read-loop signal flow</title>
                <desc id="readloop-desc">
                  A horizontal signal-flow diagram: a client or AI agent sends a selection request into the grant, an
                  immutable consent artifact; the request and the grant meet at a filter gate that computes the
                  effective filter as their intersection; the resource server returns projected records back to the
                  client.
                </desc>

                <g fill="none" stroke="var(--pdpp-concept-ink)" strokeWidth="1.25">
                  <rect height="68" width="132" x="24" y="96" />
                  <rect fill="var(--pdpp-concept-teal-wash)" height="60" stroke="var(--pdpp-concept-teal)" strokeWidth="1.5" width="150" x="256" y="30" />
                  <rect height="68" width="132" x="524" y="96" />
                </g>

                <g fill="none" stroke="var(--pdpp-concept-teal)" strokeWidth="1.5">
                  <circle cx="340" cy="188" fill="var(--pdpp-concept-paper)" r="34" />
                  <path d="M326 172 l14 16 l-14 16" />
                  <path d="M340 172 l14 16 l-14 16" />
                </g>
                <g fill="var(--pdpp-concept-teal-on-wash)" fontSize="11" fontWeight="500" letterSpacing="0.04em">
                  <text textAnchor="middle" x="340" y="240">
                    effective filter = grant ∩ request
                  </text>
                </g>

                <g fill="var(--pdpp-concept-ink)" fontSize="12" letterSpacing="0.05em">
                  <text textAnchor="middle" x="90" y="126">
                    CLIENT
                  </text>
                  <text textAnchor="middle" x="90" y="142">
                    / AI AGENT
                  </text>
                  <text textAnchor="middle" x="590" y="126">
                    RESOURCE
                  </text>
                  <text textAnchor="middle" x="590" y="142">
                    SERVER
                  </text>
                </g>
                <g fill="var(--pdpp-concept-teal-on-wash)" fontSize="12" fontWeight="500" letterSpacing="0.05em">
                  <text textAnchor="middle" x="331" y="56">
                    GRANT
                  </text>
                  <text fontSize="10" letterSpacing="0.03em" textAnchor="middle" x="331" y="72">
                    immutable consent
                  </text>
                </g>

                <g fill="var(--pdpp-concept-teal)" stroke="var(--pdpp-concept-teal)" strokeWidth="1.25">
                  <line x1="156" x2="306" y1="152" y2="182" />
                  <path d="M306 182 l-9 -1.5 l3 -6.5 z" />
                </g>
                <g fill="var(--pdpp-concept-ink-soft)" fontSize="11" letterSpacing="0.04em">
                  <text textAnchor="start" x="196" y="158">
                    selection request
                  </text>
                </g>

                <g fill="var(--pdpp-concept-teal)" stroke="var(--pdpp-concept-teal)" strokeWidth="1.25">
                  <line x1="335" x2="339" y1="90" y2="152" />
                  <path d="M339 152 l-4.5 -7.5 l7 0 z" />
                </g>

                <g fill="var(--pdpp-concept-teal)" stroke="var(--pdpp-concept-teal)" strokeWidth="1.25">
                  <line x1="374" x2="524" y1="182" y2="152" />
                  <path d="M524 152 l-9 1.5 l-1.5 -7 z" />
                </g>

                <g fill="var(--pdpp-concept-ink)" stroke="var(--pdpp-concept-ink)" strokeWidth="1.25">
                  <line x1="524" x2="156" y1="112" y2="112" />
                  <path d="M156 112 l9 -3.5 l0 7 z" />
                </g>
                <g fill="var(--pdpp-concept-ink-soft)" fontSize="11" letterSpacing="0.04em">
                  <text textAnchor="middle" x="340" y="106">
                    projected records
                  </text>
                </g>
              </svg>
              <figcaption className="pdpp-caption">
                The grant is immutable. Each request is filtered by the intersection of consent and query.
              </figcaption>
            </figure>
          </section>

          {/* 04 Doors */}
          <section className="pdpp-section" id="doors">
            <div className="pdpp-section__head">
              <div className="pdpp-section__num">04</div>
              <div className="pdpp-section__title">
                <p className="pdpp-eyebrow">Doors</p>
                <h2>Read · Run · Question · Participate</h2>
              </div>
            </div>

            <div className="pdpp-ruled-list">
              <div className="pdpp-ruled-list__item">
                <div className="pdpp-ruled-list__num">01</div>
                <div className="pdpp-ruled-list__body">
                  <h3>Read the specification</h3>
                  <p>
                    The normative protocol: record model, selection request, grant, manifest, and the resource-server
                    interface.
                  </p>
                </div>
                <Link className="pdpp-ruled-list__arrow" href="/docs">
                  Specification →
                </Link>
              </div>
              <div className="pdpp-ruled-list__item">
                <div className="pdpp-ruled-list__num">02</div>
                <div className="pdpp-ruled-list__body">
                  <h3>Run an implementation</h3>
                  <p>
                    The reference implementation proves the protocol end to end. The spec is the authority; this is
                    one realization of it.
                  </p>
                </div>
                <Link className="pdpp-ruled-list__arrow" href="/reference">
                  Implementations →
                </Link>
              </div>
              <div className="pdpp-ruled-list__item">
                <div className="pdpp-ruled-list__num">03</div>
                <div className="pdpp-ruled-list__body">
                  <h3>Question the design</h3>
                  <p>Open questions are tracked as issues on GitHub.</p>
                </div>
                <a className="pdpp-ruled-list__arrow" href="https://github.com/PDP-Connect/pdpp/issues" rel="noopener noreferrer" target="_blank">
                  GitHub Issues →
                </a>
              </div>
              <div className="pdpp-ruled-list__item">
                <div className="pdpp-ruled-list__num">04</div>
                <div className="pdpp-ruled-list__body">
                  <h3>Participate in the standard</h3>
                  <p>How the protocol changes: spec-first, public pull requests, review, and the current implementations.</p>
                </div>
                <Link className="pdpp-ruled-list__arrow" href="/participate">
                  Participate →
                </Link>
              </div>
            </div>
          </section>

          {/* 05 Status */}
          <section className="pdpp-section" id="status">
            <div className="pdpp-section__head">
              <div className="pdpp-section__num">05</div>
              <div className="pdpp-section__title">
                <p className="pdpp-eyebrow">Status</p>
                <h2>Where the draft stands</h2>
              </div>
            </div>
            <p>
              PDPP is a normative draft at v0.1.0 (dated 2026-04-06). The LFDT Labs proposal was accepted in July
              2026 and the repositories are public under the PDP-Connect organization. A community consultation on
              the open questions is the next step; nothing is settled until it completes.
            </p>
            <ul className="pdpp-updates">
              <li>
                <time dateTime="2026-07">2026 · Jul</time>
                <span>LFDT Labs proposal accepted; repositories public under the PDP-Connect organization.</span>
              </li>
              <li>
                <time dateTime="2026-04">2026 · Apr</time>
                <span>Core protocol v0.1.0 published as a normative draft alongside the forkable reference implementation.</span>
              </li>
            </ul>
          </section>
        </article>
      </main>

      <PdppConceptFooter />
    </div>
  );
}
