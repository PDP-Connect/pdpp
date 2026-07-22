// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/* PDPP — Vibe studies round 2: six personalities, same content */
;(() => {

const SCOPES = [
  { name: "pay_statements.read", terms: "append only · 2y 1mo" },
  { name: "employment.read", terms: "current + 5y" },
];

function Chips({ items, labelStyle }) {
  return (
    <div className="vs-chips">
      {items.map(([c, n]) => (
        <div className="vs-chip" key={n} style={{ background: c, boxShadow: "inset 0 0 0 1px rgb(0 0 0 / 0.12)" }}>
          <span style={labelStyle}>{n}</span>
        </div>
      ))}
    </div>
  );
}

/* ── 1 · CARBON COPY ── */
function VCarbon() {
  return (
    <div className="vs cc">
      <div className="vs-row">
        <div className="cc-lockup">
          <h1 className="cc-lockup__name">PD<em>PP</em></h1>
          <span className="cc-lockup__sub">File copy — holder</span>
        </div>
        <span className="cc-mono" style={{ fontSize: 9.5, color: "oklch(0.55 0.01 270)", textAlign: "right" }}>ref — carbon paper,<br />the duplicate you keep</span>
      </div>
      <h2 className="cc-statement">Every grant writes <em>two copies</em>. Yours is the original.</h2>
      <div className="cc-dupe">
        <div className="cc-card">
          <div className="cc-card__head">
            <span className="cc-card__client">Longview Planning</span>
            <span className="cc-card__purpose">long_term_financial_planning</span>
          </div>
          {SCOPES.map((s) => (
            <div className="cc-scope" key={s.name}>
              <span className="cc-scope__name">{s.name}</span>
              <span className="cc-scope__terms">{s.terms}</span>
            </div>
          ))}
          <div className="cc-card__foot">
            <span className="cc-copytag">Carbon · grt-longview01</span>
            <div className="vs-actions">
              <button className="cc-btn" type="button">Approve</button>
              <button className="cc-btn cc-btn--ghost" type="button">Refuse</button>
            </div>
          </div>
        </div>
      </div>
      <div className="vs-tags">
        <span className="cc-tag cc-tag--vio">Recorded</span>
        <span className="cc-tag">Expires Dec 14</span>
        <span className="cc-tag" style={{ textDecoration: "line-through" }}>Revoked</span>
      </div>
      <Chips
        items={[["oklch(0.99 0.003 250)", "paper"], ["oklch(0.21 0.012 270)", "ink"], ["oklch(0.46 0.15 295)", "carbon"], ["oklch(0.46 0.15 295 / 0.12)", "impression"]]}
        labelStyle={{ fontFamily: '"Fragment Mono", monospace', color: "oklch(0.5 0.01 270)" }}
      />
    </div>
  );
}

/* ── 2 · TWO-COLOR RIBBON ── */
function VRibbon() {
  return (
    <div className="vs rb">
      <div className="vs-row">
        <div>
          <h1 className="rb-lockup__name">PDPP</h1>
          <span className="rb-lockup__sub">black for the record · red for refusal</span>
        </div>
        <span style={{ fontSize: 9.5, color: "oklch(0.55 0.02 75)", textAlign: "right" }}>ref — two-color<br />typewriter ribbon</span>
      </div>
      <h2 className="rb-statement">The record is typed in black. <b>No is typed in red.</b></h2>
      <div className="rb-h">Consent</div>
      <div className="rb-card">
        <div className="rb-line"><span className="rb-line__k">grantee</span><span>Longview Planning</span></div>
        <div className="rb-line"><span className="rb-line__k">purpose</span><span>long_term_financial_planning</span></div>
        {SCOPES.map((s) => (
          <div className="rb-line rb-line--scope" key={s.name}><span>{s.name}</span><span className="rb-line__k">{s.terms}</span></div>
        ))}
        <div className="rb-line rb-line--scope"><span className="rb-revoked">browsing.read</span><span className="rb-tag--red rb-tag">refused</span></div>
      </div>
      <div className="vs-tags">
        <span className="rb-tag">[RECORDED]</span>
        <span className="rb-tag">[EXPIRES 12-14]</span>
        <span className="rb-tag rb-tag--red">[REVOKED]</span>
      </div>
      <div className="vs-actions">
        <button className="rb-btn" type="button">Record</button>
        <button className="rb-btn rb-btn--red" type="button">Refuse</button>
      </div>
      <Chips
        items={[["oklch(0.962 0.01 92)", "paper"], ["oklch(0.25 0.015 75)", "ink"], ["oklch(0.54 0.19 27)", "ribbon red"]]}
        labelStyle={{ color: "oklch(0.55 0.02 75)" }}
      />
    </div>
  );
}

/* ── 3 · CLARENDON LEDGER ── */
function VClarendon() {
  return (
    <div className="vs cl">
      <div className="cl-frame">
        <div className="vs-row" style={{ alignItems: "baseline" }}>
          <h1 className="cl-lockup__name">PDPP</h1>
          <span className="cl-lockup__sub">est. rev 0.1.0</span>
        </div>
      </div>
      <h2 className="cl-statement">Consent, <b>recorded</b> — with the gravity of a ledger and none of the dust.</h2>
      <div className="cl-card">
        <div className="cl-card__head">
          <span className="cl-card__client">Longview Planning</span>
          <span className="cl-card__no">grt-longview01</span>
        </div>
        {SCOPES.map((s, i) => (
          <div className="cl-scope" key={s.name}>
            <span className="cl-scope__no">{String(i + 1).padStart(2, "0")}</span>
            <span className="cl-scope__name">{s.name}</span>
            <span className="cl-scope__terms">{s.terms}</span>
          </div>
        ))}
        <div className="vs-actions" style={{ marginTop: 4 }}>
          <button className="cl-btn" type="button">Record grant</button>
          <button className="cl-btn cl-btn--ghost" type="button">Decline</button>
        </div>
      </div>
      <div className="vs-tags">
        <span className="cl-tag cl-tag--green">Recorded</span>
        <span className="cl-tag">Expires Dec 14</span>
        <span className="cl-tag">Vacated</span>
      </div>
      <Chips
        items={[["oklch(0.972 0.009 85)", "paper"], ["oklch(0.24 0.02 60)", "ink"], ["oklch(0.43 0.07 165)", "banknote"]]}
        labelStyle={{ fontFamily: '"Spline Sans Mono", monospace', color: "oklch(0.55 0.02 60)" }}
      />
    </div>
  );
}

/* ── 4 · PUNCH COLUMN ── */
function VPunch() {
  return (
    <div className="vs pc">
      <div className="vs-row">
        <div>
          <h1 className="pc-lockup__name">PDPP</h1>
          <span className="pc-lockup__sub">col 01–80 · personal data</span>
        </div>
        <span className="pc-mono" style={{ fontSize: 8.5, color: "oklch(0.5 0.04 75)", textAlign: "right" }}>ref — tabulating cards,<br />a hole is a grant</span>
      </div>
      <h2 className="pc-statement">A field is granted the way a card is punched: precisely, or not at all.</h2>
      <div className="pc-card">
        <div className="pc-card__head">
          <span className="pc-card__client">Longview Planning</span>
          <span className="pc-card__purpose">long_term_financial_planning</span>
        </div>
        {SCOPES.map((s) => (
          <div className="pc-scope" key={s.name}>
            <span className="pc-slot pc-slot--punched"></span>
            <span className="pc-scope__name">{s.name}</span>
            <span className="pc-scope__terms">{s.terms}</span>
          </div>
        ))}
        <div className="pc-scope">
          <span className="pc-slot"></span>
          <span className="pc-scope__name" style={{ color: "oklch(0.55 0.04 75)", fontWeight: 400 }}>tax_docs.read</span>
          <span className="pc-scope__terms">not punched</span>
        </div>
        <div className="pc-index"><span>0 1 2 3 4 5 6 7 8 9</span><span>col 12–18</span></div>
      </div>
      <div className="vs-tags">
        <span className="pc-tag pc-tag--punched">Punched</span>
        <span className="pc-tag">Expires Dec 14</span>
        <span className="pc-tag">Void</span>
      </div>
      <div className="vs-actions">
        <button className="pc-btn" type="button">Punch grant</button>
        <button className="pc-btn pc-btn--ghost" type="button">Leave blank</button>
      </div>
      <Chips
        items={[["oklch(0.93 0.028 92)", "card buff"], ["oklch(0.27 0.02 75)", "ink"], ["oklch(0.6 0.1 40)", "column rule"]]}
        labelStyle={{ fontFamily: '"Martian Mono", monospace', fontSize: 8, color: "oklch(0.5 0.04 75)" }}
      />
    </div>
  );
}

/* ── 5 · CIVIC BOLD ── */
function VCivic() {
  return (
    <div className="vs cb">
      <div className="vs-row">
        <div>
          <h1 className="cb-lockup__name">PDPP</h1>
          <span className="cb-lockup__sub">protocol, in public</span>
        </div>
        <span className="cb-mono" style={{ fontSize: 9.5, color: "oklch(0.45 0 0)", textAlign: "right" }}>ref — civic signage,<br />public notices</span>
      </div>
      <h2 className="cb-statement">Your data. <b>Your terms.</b> In writing.</h2>
      <div className="cb-card">
        <div className="cb-card__head">
          <span className="cb-card__client">Longview Planning</span>
          <span className="cb-card__purpose">long_term_financial_planning</span>
        </div>
        {SCOPES.map((s) => (
          <div className="cb-scope" key={s.name}>
            <span className="cb-scope__name">{s.name}</span>
            <span className="cb-scope__terms">{s.terms}</span>
          </div>
        ))}
        <div className="vs-actions" style={{ marginTop: 4 }}>
          <button className="cb-btn" type="button">Approve</button>
          <button className="cb-btn cb-btn--ghost" type="button">Refuse</button>
        </div>
      </div>
      <div className="vs-tags">
        <span className="cb-tag cb-tag--blue">Recorded</span>
        <span className="cb-tag cb-tag--ghost">Expires Dec 14</span>
        <span className="cb-tag">Revoked</span>
      </div>
      <Chips
        items={[["oklch(0.985 0.002 95)", "paper"], ["oklch(0.16 0 0)", "ink"], ["oklch(0.45 0.12 262)", "stamp blue"]]}
        labelStyle={{ fontFamily: '"Fragment Mono", monospace', color: "oklch(0.45 0 0)" }}
      />
    </div>
  );
}

/* ── 6 · GREENBAR ── */
function VGreenbar() {
  return (
    <div className="vs gb" style={{ paddingLeft: 30, paddingRight: 30, position: "relative" }}>
      <div className="gb-sprockets gb-sprockets--l"></div>
      <div className="gb-sprockets gb-sprockets--r"></div>
      <div className="vs-row">
        <div>
          <h1 className="gb-lockup__name">PDPP</h1>
          <span className="gb-lockup__sub">continuous form · holder's printout</span>
        </div>
        <span style={{ fontSize: 9, color: "oklch(0.5 0.02 250)", textAlign: "right" }}>ref — greenbar paper,<br />tractor-feed printouts</span>
      </div>
      <h2 className="gb-statement">The server prints what crossed. <b>Every band, accounted for.</b></h2>
      <div className="gb-card">
        <div className="gb-card__head">
          <span className="gb-card__client">Longview Planning</span>
          <span className="gb-card__purpose">long_term_financial_planning</span>
        </div>
        {SCOPES.map((s) => (
          <div className="gb-row" key={s.name}><span>{s.name}</span><span className="gb-row__terms">{s.terms}</span></div>
        ))}
        <div className="gb-row"><span>queries this cycle</span><span className="gb-row__terms">14 · all inside grant</span></div>
        <div className="gb-row"><span>last sync</span><span className="gb-row__terms">2025-11-04 11:05Z</span></div>
      </div>
      <div className="vs-tags">
        <span className="gb-tag gb-tag--solid">Recorded</span>
        <span className="gb-tag">Expires Dec 14</span>
        <span className="gb-tag gb-tag--red">Revoked</span>
      </div>
      <div className="vs-actions">
        <button className="gb-btn" type="button">Approve</button>
        <button className="gb-btn gb-btn--ghost" type="button">Refuse</button>
      </div>
      <Chips
        items={[["oklch(0.99 0.004 140)", "paper"], ["oklch(0.945 0.028 162)", "band"], ["oklch(0.24 0.012 250)", "ink"], ["oklch(0.42 0.06 165)", "print green"]]}
        labelStyle={{ color: "oklch(0.5 0.02 250)" }}
      />
    </div>
  );
}

Object.assign(window, { VCarbon, VRibbon, VClarendon, VPunch, VCivic, VGreenbar });
})();
