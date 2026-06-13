/**
 * StandingOverview — the Ink Carbon "Standing" (Overview) presentation.
 *
 * Answers the owner's three questions calmly:
 *   1. What can act as you   — bearer (owner) tokens, "reads everything".
 *   2. Who can read parts of you — scoped grants, humanized.
 *   3. What's been read       — recent traces, humanized.
 * Plus "Anything wrong" — attention list, or an all-clear reassurance panel.
 *
 * Pure presentation: it takes a fully-derived `StandingData` (see
 * standing-view-model.ts) and renders kit primitives. No data fetching, no
 * tone logic here — that lives in the view-model so it stays testable.
 *
 * Design source: docs/design/ink-carbon/project/recordroom/rr-overview.jsx.
 */
import { Endorse, Eyebrow, Monogram } from "@/components/ink-carbon/index.ts";
import "@/components/ink-carbon/components.css";
import type { StandingData } from "./standing-view-model.ts";

function HeroLine({ line }: { line: StandingData["hero"]["line"] }) {
  return (
    <h1 className="rr-stand-hero__line">
      {line.text}
      {line.emphasis ? <em>{line.emphasis}</em> : null}
      {line.tail ?? null}
    </h1>
  );
}

function Hero({ hero }: { hero: StandingData["hero"] }) {
  return (
    <section className={["rr-stand-hero", `is-${hero.tone}`].join(" ")}>
      <span className="rr-stand-hero__kicker">{hero.kicker}</span>
      <HeroLine line={hero.line} />
      <p className="rr-stand-hero__sub">{hero.sub}</p>
      {hero.cta ? (
        <div className="rr-stand-hero__foot">
          <a className={hero.cta.human ? "pdpp-btn pdpp-btn--human" : "pdpp-btn pdpp-btn--sm"} href={hero.cta.href}>
            {hero.cta.label}
          </a>
        </div>
      ) : null}
    </section>
  );
}

function BearerBlock({ bearers, tokensHref }: { bearers: StandingData["bearers"]; tokensHref: string }) {
  return (
    <section className="rr-stand-block">
      <div className="rr-stand-block__head">
        <h2 className="rr-stand-block__title">What can act as you</h2>
        <a className="rr-link" href={tokensHref}>
          owner tokens →
        </a>
      </div>
      {bearers.length > 0 ? (
        <div className="rr-bearer">
          {bearers.map((b) => {
            // When the client carries a human name, `who` is that name and the
            // raw machine `clientId` is shown beneath it as a secondary, muted,
            // truncated mono line. When there is no name, `who === clientId`, so
            // we show it once (the id IS the identity) and let it truncate.
            const hasDistinctId = b.clientId !== b.who;
            return (
              <div className="rr-bearer__row" key={b.clientId}>
                <span className="rr-bearer__id">
                  <span className="rr-bearer__who" title={b.who}>
                    {b.who}
                  </span>
                  {hasDistinctId ? (
                    <span className="rr-bearer__client" title={b.clientId}>
                      {b.clientId}
                    </span>
                  ) : null}
                </span>
                <span className="rr-bearer__tag">reads everything</span>
                <span className="rr-bearer__how">{b.how}</span>
                <a className="rr-rel__revoke" href={b.revokeHref}>
                  revoke
                </a>
              </div>
            );
          })}
          <p className="rr-bearer__note">
            An owner token reads everything — every source, every field, exactly what you see. Keep the list short;
            revoke anytime.
          </p>
        </div>
      ) : (
        <p className="rr-stand-empty">
          No token can act as you. Nothing has full access — only your signed-in owner session reads everything here.
        </p>
      )}
    </section>
  );
}

function RelationshipsBlock({
  relationships,
  grantsHref,
}: {
  relationships: StandingData["relationships"];
  grantsHref: string;
}) {
  return (
    <section className="rr-stand-block">
      <div className="rr-stand-block__head">
        <h2 className="rr-stand-block__title">Who can read parts of you</h2>
        <a className="rr-link" href={grantsHref}>
          all grants →
        </a>
      </div>
      {relationships.length > 0 ? (
        <div className="rr-rel-list">
          {relationships.map((r) => (
            <div className="rr-rel" key={`${r.who}:${r.revokeHref}`}>
              <span className="rr-rel__who">
                <Monogram name={r.who} /> {r.who}
              </span>
              <span className="rr-rel__reads">
                {r.reads} · <Endorse status={r.status} />
              </span>
              <span className="rr-rel__meta">{r.terms}</span>
              <a className="rr-rel__revoke" href={r.revokeHref}>
                revoke
              </a>
            </div>
          ))}
        </div>
      ) : (
        <p className="rr-stand-empty">
          No grant is out. Nothing is shared — only you and what you've given a token read this server.
        </p>
      )}
    </section>
  );
}

function LatelyBlock({ lately, tracesHref }: { lately: StandingData["lately"]; tracesHref: string }) {
  return (
    <section className="rr-stand-block">
      <div className="rr-stand-block__head">
        <h2 className="rr-stand-block__title">What's been read</h2>
        <a className="rr-link" href={tracesHref}>
          every read →
        </a>
      </div>
      {lately.length > 0 ? (
        <div className="rr-lately">
          {lately.map((e) => (
            <div className={["rr-lately__row", e.deny ? "is-deny" : null].filter(Boolean).join(" ")} key={e.id}>
              <span className="rr-lately__text">
                <b>{e.text.who}</b> {e.text.rest}
              </span>
              <span className="rr-lately__when">{e.when}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="rr-stand-empty">Nothing has been read yet. When an app reads a record, it shows up here.</p>
      )}
    </section>
  );
}

function AttentionBlock({ attention }: { attention: StandingData["attention"] }) {
  return (
    <section className="rr-stand-block">
      <h2 className="rr-stand-block__title">Anything wrong</h2>
      {attention.length > 0 ? (
        <div className="rr-attn">
          {attention.map((a) => (
            <a className="rr-attn__row" href={a.href} key={a.id}>
              <span className="rr-attn__what">{a.what}</span>
              <span className="rr-rel__meta">look →</span>
              <span className="rr-attn__why">{a.why}</span>
            </a>
          ))}
        </div>
      ) : (
        <div className="rr-allclear">
          <span className="rr-allclear__text">
            Nothing needs you. Grants are within their limits, backups are on, and everything's syncing.
          </span>
        </div>
      )}
    </section>
  );
}

export interface StandingOverviewProps {
  data: StandingData;
  grantsHref: string;
  /** Optional banner above the view (e.g. seeded-demo notice). */
  notice?: string;
  tokensHref: string;
  tracesHref: string;
}

export function StandingOverview({ data, grantsHref, tokensHref, tracesHref, notice }: StandingOverviewProps) {
  return (
    <div className="rr-stand">
      {notice ? (
        <div style={{ marginBottom: 4 }}>
          <Eyebrow>{notice}</Eyebrow>
        </div>
      ) : null}
      <Hero hero={data.hero} />
      <BearerBlock bearers={data.bearers} tokensHref={tokensHref} />
      <div className="rr-stand-grid">
        <RelationshipsBlock grantsHref={grantsHref} relationships={data.relationships} />
        <LatelyBlock lately={data.lately} tracesHref={tracesHref} />
      </div>
      <AttentionBlock attention={data.attention} />
    </div>
  );
}
