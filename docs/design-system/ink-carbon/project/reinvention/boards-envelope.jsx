/* Direction A — SECURITY TINT — boards */
;(() => {

function EnvIdentity() {
  return (
    <div className="env">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 24 }}>
        <div className="env-indicia">
          <h1 className="env-indicia__name">PDPP</h1>
          <span className="env-indicia__line">Consent-class mail</span>
          <span className="env-indicia__line">Permit Nº 0001</span>
        </div>
        <p className="env-note" style={{ textAlign: "right" }}>
          ref — security-tint envelopes,<br />die-cut windows, permit indicia,<br />certified-mail green cards
        </p>
      </div>

      <h2 className="env-statement">
        Your data travels <span className="t">sealed</span>. The grant is the window.
      </h2>
      <p className="env-body">
        A security tint has exactly one job: keeping personal data unreadable in transit.
        A window envelope reveals exactly the named fields and nothing else.
        PDPP already works this way — the brand just admits it. <b>Granted is typed. Withheld is tinted.</b>
      </p>

      <div>
        <div className="env-cap">
          <h3 className="env-cap__name">The grammar</h3>
          <span className="env-cap__sub">one rule, applied everywhere</span>
        </div>
        <div className="env-grammar">
          <div className="env-field">
            <span className="env-field__k">granted field</span>
            <span className="env-field__window">employer: Acme Co</span>
          </div>
          <div className="env-field">
            <span className="env-field__k">granted field</span>
            <span className="env-field__window">net_pay: $3,508.12</span>
          </div>
          <div className="env-field">
            <span className="env-field__k">withheld field</span>
            <span className="env-field__bar"></span>
          </div>
        </div>
      </div>

      <div>
        <div className="env-cap">
          <h3 className="env-cap__name">House tints</h3>
          <span className="env-cap__sub">privacy, printed</span>
        </div>
        <div className="env-tints" style={{ marginTop: 14 }}>
          <div className="env-tint-card"><div className="env-tint-card__chip is-hatch"></div><span className="env-tint-card__name">tint/hatch — withheld</span></div>
          <div className="env-tint-card"><div className="env-tint-card__chip is-cross"></div><span className="env-tint-card__name">tint/cross — sealed</span></div>
          <div className="env-tint-card"><div className="env-tint-card__chip is-weave"></div><span className="env-tint-card__name">tint/weave — archive</span></div>
        </div>
      </div>

      <div>
        <div className="env-cap">
          <h3 className="env-cap__name">Palette</h3>
          <span className="env-cap__sub">postal, not pastel</span>
        </div>
        <div className="env-palette" style={{ marginTop: 14 }}>
          <div className="env-swatch"><div className="env-swatch__chip" style={{ background: "oklch(0.42 0.09 265)" }}></div><span className="env-swatch__name">tint blue</span></div>
          <div className="env-swatch"><div className="env-swatch__chip" style={{ background: "oklch(0.975 0.005 95)" }}></div><span className="env-swatch__name">paper</span></div>
          <div className="env-swatch"><div className="env-swatch__chip" style={{ background: "oklch(0.85 0.035 85)" }}></div><span className="env-swatch__name">kraft</span></div>
          <div className="env-swatch"><div className="env-swatch__chip" style={{ background: "oklch(0.55 0.09 155)" }}></div><span className="env-swatch__name">receipt green</span></div>
          <div className="env-swatch"><div className="env-swatch__chip" style={{ background: "oklch(0.52 0.17 27)" }}></div><span className="env-swatch__name">return red</span></div>
        </div>
      </div>

      <div>
        <div className="env-cap">
          <h3 className="env-cap__name">Type</h3>
          <span className="env-cap__sub">Public Sans · Courier Prime</span>
        </div>
        <div className="env-ramp" style={{ marginTop: 6 }}>
          <div className="env-ramp__row">
            <span className="env-ramp__tag">display / 700</span>
            <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em" }}>Granular access to personal data.</span>
          </div>
          <div className="env-ramp__row">
            <span className="env-ramp__tag">label / caps</span>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase" }}>Detach to revoke</span>
          </div>
          <div className="env-ramp__row">
            <span className="env-ramp__tag">data / typed</span>
            <span style={{ fontFamily: "var(--env-type)", fontSize: 15 }}>pay_statements.read — append only — 2y 1mo</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function EnvSurfaces() {
  return (
    <div className="env" style={{ gap: 24 }}>
      <div className="env-cap" style={{ borderTop: 0, paddingTop: 0 }}>
        <h3 className="env-cap__name">Consent — the envelope</h3>
        <span className="env-cap__sub">windows show exactly what Longview gets</span>
      </div>

      <div className="env-envelope">
        <div className="env-envelope__row">
          <div className="env-envelope__from">
            <span className="env-envelope__from-name">YOUR RESOURCE SERVER</span>
            <span className="env-envelope__from-sub">rs.example.com · holder: you</span>
          </div>
          <div className="env-envelope__indicia">
            PDPP<br />consent-class<br />Nº GRT-LONGVIEW01
          </div>
        </div>
        <div className="env-envelope__to">
          <span className="env-envelope__to-label">Deliver to</span>
          <span className="env-envelope__to-name">LONGVIEW PLANNING</span>
          <span className="env-envelope__to-purpose">purpose: long_term_financial_planning</span>
        </div>
        <div className="env-window">
          <div className="env-window__row">
            <span className="env-window__field">pay_statements.read</span>
            <span className="env-window__terms">append only · 2y 1mo</span>
          </div>
          <div className="env-window__row">
            <span className="env-window__field">employment.read</span>
            <span className="env-window__terms">current + 5y</span>
          </div>
          <div className="env-window__row">
            <span className="env-window__bar"></span>
            <span className="env-window__bar-tag">tax_docs — sealed</span>
          </div>
          <div className="env-window__row">
            <span className="env-window__bar" style={{ maxWidth: 220 }}></span>
            <span className="env-window__bar-tag">identity — sealed</span>
          </div>
        </div>
        <div className="env-perf">
          <span className="env-perf__hint">Detach here to revoke — takes effect at the server</span>
          <span className="env-perf__no">GRT-LONGVIEW01</span>
        </div>
      </div>

      <div className="env-cap">
        <h3 className="env-cap__name">Grant record — the green card</h3>
        <span className="env-cap__sub">proof of consent, kept by the holder</span>
      </div>

      <div className="env-receipt">
        <div className="env-receipt__head">
          <h4 className="env-receipt__title">Return receipt · consent recorded</h4>
          <span className="env-receipt__no">GRT-LONGVIEW01</span>
        </div>
        <div className="env-receipt__grid">
          <div className="env-receipt__cell"><span className="env-receipt__k">Grantee</span><span className="env-receipt__v">Longview Planning</span></div>
          <div className="env-receipt__cell"><span className="env-receipt__k">Mode</span><span className="env-receipt__v">continuous</span></div>
          <div className="env-receipt__cell"><span className="env-receipt__k">Issued</span><span className="env-receipt__v">2025-10-14 09:22Z</span></div>
          <div className="env-receipt__cell"><span className="env-receipt__k">Expires</span><span className="env-receipt__v">2025-12-14 09:22Z</span></div>
          <div className="env-receipt__cell"><span className="env-receipt__k">Scopes</span><span className="env-receipt__v">2 granted · 2 sealed</span></div>
          <div className="env-receipt__cell"><span className="env-receipt__k">Purpose</span><span className="env-receipt__v">long_term_financial_planning</span></div>
        </div>
      </div>

      <div className="env-cap">
        <h3 className="env-cap__name">Endorsements &amp; actions</h3>
        <span className="env-cap__sub">statuses are stamped, not badged</span>
      </div>

      <div className="env-endorse">
        <span className="env-tag env-tag--receipt">Active · first class</span>
        <span className="env-tag">Expires Dec 14</span>
        <span className="env-tag env-tag--tint">Sealed × 2</span>
        <span className="env-tag env-tag--return">Refused — returned to sender</span>
      </div>

      <div className="env-actions">
        <button className="env-btn" type="button">Approve &amp; seal</button>
        <button className="env-btn env-btn--ghost" type="button">Adjust windows</button>
        <button className="env-btn env-btn--return" type="button">Return to sender</button>
      </div>
    </div>
  );
}

Object.assign(window, { EnvIdentity, EnvSurfaces });
})();
