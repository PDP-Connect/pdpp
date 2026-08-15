// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
 * Design source: docs/design-system/ink-carbon/project/recordroom/rr-overview.jsx.
 */
import { Endorse, Eyebrow, IcTimestamp, Monogram } from "@pdpp/brand-react";
import "@pdpp/brand-react/components.css";
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

function BearerBlock({
  bearers,
  bearersOverflow,
  tokensHref,
}: {
  bearers: StandingData["bearers"];
  bearersOverflow: number;
  tokensHref: string;
}) {
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
                {/* Same field, same primitive as the tokens page: the
                    registration timestamp renders through IcTimestamp, so the
                    two owner surfaces speak one timestamp voice. The label word
                    degrades to "first issued" when the client has >1 token. */}
                <span className="rr-bearer__how">
                  {b.how} · {b.issuedLabel} <IcTimestamp value={b.issuedAt} />
                </span>
                {/* NAV, not a mutation. This opens the owner-tokens page; the
                    actual revoke ceremony lives there. It previously read
                    "revoke" in a `rr-rel__revoke` slot — destructive wording and
                    destructive chrome on a link that only navigates. The name
                    now matches what the click does. */}
                <a className="rr-rel__revoke rr-rel__manage" href={b.revokeHref}>
                  Manage →
                </a>
              </div>
            );
          })}
          {bearersOverflow > 0 ? (
            <a className="rr-link rr-bearer__more" href={tokensHref}>
              +{bearersOverflow} more owner {bearersOverflow === 1 ? "credential" : "credentials"} →
            </a>
          ) : null}
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
  grantPackages,
}: {
  relationships: StandingData["relationships"];
  grantsHref: string;
  grantPackages: StandingData["grantPackages"];
}) {
  return (
    <section className="rr-stand-block">
      <div className="rr-stand-block__head">
        <h2 className="rr-stand-block__title">Who can read parts of you</h2>
        <span className="rr-stand-block__links">
          {grantPackages ? (
            <a className="rr-link" href={grantPackages.href}>
              {grantPackages.count === 1 ? "grant package" : `${grantPackages.count} grant packages`} →
            </a>
          ) : null}
          <a className="rr-link" href={grantsHref}>
            all grants →
          </a>
        </span>
      </div>
      {relationships.length > 0 ? (
        <div className="rr-rel-list">
          {relationships.map((r) => (
            <div className="rr-rel" key={r.clientId}>
              <span className="rr-rel__who">
                <Monogram name={r.who} />
                <span>
                  <span title={r.who}>{r.who}</span>
                  {r.showClientId ? (
                    <span className="rr-bearer__client" title={r.clientId}>
                      {r.clientId}
                    </span>
                  ) : null}
                </span>
              </span>
              <span className="rr-rel__reads">
                {r.reads} · <Endorse status={r.status} />
              </span>
              <span className="rr-rel__meta">{r.terms}</span>
              {/* NAV, not a mutation: opens the grant (or the filtered grants
                  list when the group has no single subject). The label is
                  supplied by the view-model and already carries the arrow. */}
              <a className="rr-rel__revoke rr-rel__manage" href={r.actionHref}>
                {r.actionLabel}
              </a>
            </div>
          ))}
        </div>
      ) : (
        <p className="rr-stand-empty">No grants are active. No connected app can read this instance yet.</p>
      )}
    </section>
  );
}

function LatelyBlock({ lately, tracesHref }: { lately: StandingData["lately"]; tracesHref: string }) {
  return (
    <section className="rr-stand-block">
      <div className="rr-stand-block__head">
        <h2 className="rr-stand-block__title">What's been read</h2>
        {/* Honest CTA: the overview shows a grouped preview of recent reads and
            the link lands on the Audit log (itself grouped, with a
            per-event drill one click further). "audit log →" names the
            destination; the old "every read →" implied this preview was the
            exhaustive log, which it is not. */}
        <a className="rr-link" href={tracesHref}>
          audit log →
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

/**
 * Source attention is projected once by the shared source-work model. The
 * overview shows each row's owner-safe label and next step, while Syncs stays
 * the deeper recovery surface.
 */
function AttentionBlock({
  sections,
  fleetHealth,
  healthySourceCount,
  syncsHref,
}: {
  sections: StandingData["sourceWorkSections"];
  fleetHealth: StandingData["fleetHealth"];
  healthySourceCount: StandingData["healthySourceCount"];
  syncsHref: string;
}) {
  const rowCount = sections.reduce((sum, section) => sum + section.rows.length, 0);
  return (
    <section className="rr-stand-block">
      <h2 className="rr-stand-block__title">Source attention</h2>
      {healthySourceCount !== null && healthySourceCount > 0 ? (
        <p className="rr-stand-empty">
          {healthySourceCount} {healthySourceCount === 1 ? "source is" : "sources are"} healthy and need no action.
        </p>
      ) : null}
      {rowCount > 0 ? (
        <div className="rr-attn" data-row-count={rowCount}>
          {sections.map((section) => (
            <div className="rr-attn__section" key={section.id}>
              <div className={["rr-attn__section-summary", `is-${section.tone}`].join(" ")}>
                <span className="rr-attn__section-title">{section.title}</span>
                <span className="rr-attn__section-count">{section.countLabel}</span>
              </div>
              {section.rows.map((row) => (
                <div className={["rr-attn__row", `is-${section.tone}`].join(" ")} key={row.id}>
                  <a className="rr-attn__what" href={row.href}>
                    {row.what}
                  </a>
                  <span className="rr-attn__why">{row.why}</span>
                </div>
              ))}
            </div>
          ))}
          <a className="rr-link rr-attn__syncs-link" href={syncsHref}>
            Review in Syncs →
          </a>
        </div>
      ) : (
        <div className="rr-allclear">
          <span className="rr-allclear__text">
            {fleetHealth?.state === "healthy"
              ? "All assessed sources are healthy."
              : "No source rows need review here. Source health is still being checked."}
          </span>
        </div>
      )}
    </section>
  );
}

const NOTIFICATIONS_SETUP_COPY: Readonly<Record<StandingData["notificationsSetup"], string>> = {
  configured:
    "At least one device is enrolled for alerts on source reconnects, syncs waiting on you, and other owner-action events.",
  not_configured:
    "No device is enrolled yet. Enable browser or installed-app alerts for source reconnects, syncs waiting on you, and other owner-action events.",
  unknown: "Could not check whether any device is enrolled for alerts right now.",
};

function NotificationsBlock({ href, setup }: { href: string; setup: StandingData["notificationsSetup"] }) {
  return (
    <section className="rr-stand-block">
      <div className="rr-stand-block__head">
        <h2 className="rr-stand-block__title">Notifications</h2>
        <a className="rr-link" href={href}>
          {setup === "configured" ? "manage →" : "setup →"}
        </a>
      </div>
      <p className="rr-stand-empty">{NOTIFICATIONS_SETUP_COPY[setup]}</p>
    </section>
  );
}

export interface StandingOverviewProps {
  data: StandingData;
  grantsHref: string;
  /** Optional banner above the view (e.g. seeded-demo notice). */
  notice?: string;
  notificationsHref: string;
  /** Where "Review in Syncs →" points — the one place attention items are listed in full. */
  syncsHref: string;
  tokensHref: string;
  tracesHref: string;
}

export function StandingOverview({
  data,
  grantsHref,
  notificationsHref,
  syncsHref,
  tokensHref,
  tracesHref,
  notice,
}: StandingOverviewProps) {
  return (
    <div className="rr-stand">
      {notice ? (
        <div style={{ marginBottom: 4 }}>
          <Eyebrow>{notice}</Eyebrow>
        </div>
      ) : null}
      <Hero hero={data.hero} />
      <BearerBlock bearers={data.bearers} bearersOverflow={data.bearersOverflow} tokensHref={tokensHref} />
      <div className="rr-stand-grid">
        <RelationshipsBlock
          grantPackages={data.grantPackages}
          grantsHref={grantsHref}
          relationships={data.relationships}
        />
        <LatelyBlock lately={data.lately} tracesHref={tracesHref} />
      </div>
      <AttentionBlock
        fleetHealth={data.fleetHealth}
        healthySourceCount={data.healthySourceCount}
        sections={data.sourceWorkSections}
        syncsHref={syncsHref}
      />
      <NotificationsBlock href={notificationsHref} setup={data.notificationsSetup} />
    </div>
  );
}
