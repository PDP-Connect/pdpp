/* Direction C — STRIP BAY — boards */
;(() => {

function StrIdentity() {
  return (
    <div className="str">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 24 }}>
        <div className="str-lockup">
          <span className="str-lockup__band"></span>
          <div className="str-lockup__body">
            <h1 className="str-lockup__name">PDPP</h1>
            <span className="str-lockup__sub">sector — personal data</span>
          </div>
        </div>
        <p className="str-note" style={{ textAlign: "right" }}>
          ref — flight progress strips,<br />strip bays, cocked strips ·<br />type: B612 (Airbus cockpit)
        </p>
      </div>

      <h2 className="str-statement">
        One strip per grant. <span className="a">Pull it</span> to revoke.
      </h2>
      <p className="str-body">
        Flight progress strips are the most battle-tested paper UI ever designed:
        one strip per flight, fixed columns, nothing decorative. A strip cocked
        sideways demands attention. A pulled strip is <b>gone</b> — revocation you
        can feel. Live data deserves an operations room, not a dashboard.
      </p>

      <div>
        <div className="str-cap">
          <h3 className="str-cap__name">Strip anatomy</h3>
          <span className="str-cap__sub">fixed columns, every surface</span>
        </div>
        <div className="str-anatomy" style={{ marginTop: 12 }}>
          <div className="str-anatomy__labels">
            <span className="str-anatomy__label"></span>
            <span className="str-anatomy__label">designator</span>
            <span className="str-anatomy__label">payload</span>
            <span className="str-anatomy__label">terms</span>
            <span className="str-anatomy__label">time</span>
          </div>
          <div className="str-strip">
            <span className="str-strip__band is-amber"></span>
            <div className="str-strip__cell">
              <span className="str-strip__designator">LNGVW01</span>
              <span className="str-strip__type">grant · cont</span>
            </div>
            <div className="str-strip__cell">
              <span className="str-strip__main">Longview Planning</span>
              <span className="str-strip__sub">pay_statements + employment</span>
            </div>
            <div className="str-strip__terms">
              <span>APPEND ONLY</span>
              <span>2Y 1MO</span>
            </div>
            <div className="str-strip__cell str-strip__cell--time">
              <span className="str-strip__clock">09:22Z</span>
              <span className="str-strip__date">EXP DEC 14</span>
            </div>
          </div>
        </div>
      </div>

      <div>
        <div className="str-cap">
          <h3 className="str-cap__name">Palette</h3>
          <span className="str-cap__sub">paper on the rack — amber is the holder, blue is the machine</span>
        </div>
        <div className="str-palette" style={{ marginTop: 14 }}>
          <div className="str-swatch"><div className="str-swatch__chip" style={{ background: "var(--str-rack)", boxShadow: "inset 0 0 0 1px var(--str-rail)" }}></div><span className="str-swatch__name">rack</span></div>
          <div className="str-swatch"><div className="str-swatch__chip" style={{ background: "var(--str-strip)" }}></div><span className="str-swatch__name">strip buff</span></div>
          <div className="str-swatch"><div className="str-swatch__chip" style={{ background: "var(--str-amber)" }}></div><span className="str-swatch__name">amber / holder</span></div>
          <div className="str-swatch"><div className="str-swatch__chip" style={{ background: "var(--str-blue)" }}></div><span className="str-swatch__name">blue / machine</span></div>
          <div className="str-swatch"><div className="str-swatch__chip" style={{ background: "var(--str-red)" }}></div><span className="str-swatch__name">red / time-critical</span></div>
        </div>
      </div>

      <div>
        <div className="str-cap">
          <h3 className="str-cap__name">Type</h3>
          <span className="str-cap__sub">B612 · B612 Mono — commissioned for cockpit legibility</span>
        </div>
        <div className="str-ramp" style={{ marginTop: 6 }}>
          <div className="str-ramp__row">
            <span className="str-ramp__tag">display / 700</span>
            <span style={{ fontSize: 26, fontWeight: 700 }}>Granular access to personal data.</span>
          </div>
          <div className="str-ramp__row">
            <span className="str-ramp__tag">body / 400</span>
            <span style={{ fontSize: 14, color: "var(--str-light)" }}>The resource server enforces the boundary. Only granted fields come back.</span>
          </div>
          <div className="str-ramp__row">
            <span className="str-ramp__tag">data / mono 700</span>
            <span style={{ fontFamily: "var(--str-mono)", fontSize: 14, fontWeight: 700 }}>LNGVW01 · PAY_STMT · EXP 1214</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function StrSurfaces() {
  return (
    <div className="str" style={{ gap: 24 }}>
      <div className="str-cap" style={{ borderTop: 0, paddingTop: 0 }}>
        <h3 className="str-cap__name">The bay — active grants</h3>
        <span className="str-cap__sub">consent as an operations room</span>
      </div>

      <div className="str-bay">
        <div className="str-bay__rail">
          <span className="str-bay__sector">Bay 1 — grants in effect</span>
          <span className="str-bay__count">3 strips · 1 pulled</span>
        </div>

        <div className="str-strip">
          <span className="str-strip__band is-amber"></span>
          <div className="str-strip__cell">
            <span className="str-strip__designator">LNGVW01</span>
            <span className="str-strip__type">grant · cont</span>
          </div>
          <div className="str-strip__cell">
            <span className="str-strip__main">Longview Planning</span>
            <span className="str-strip__sub">pay_statements.read + employment.read</span>
          </div>
          <div className="str-strip__terms">
            <span>APPEND ONLY</span>
            <span>2Y 1MO</span>
          </div>
          <div className="str-strip__cell str-strip__cell--time">
            <span className="str-strip__clock">09:22Z</span>
            <span className="str-strip__date">EXP DEC 14</span>
          </div>
        </div>

        <div className="str-strip str-strip--blue">
          <span className="str-strip__band"></span>
          <div className="str-strip__cell">
            <span className="str-strip__designator">CHASE03</span>
            <span className="str-strip__type">stream · sync</span>
          </div>
          <div className="str-strip__cell">
            <span className="str-strip__main">transactions.read</span>
            <span className="str-strip__sub">last sync 41 records · cursor ok</span>
          </div>
          <div className="str-strip__terms">
            <span>READ ONLY</span>
            <span>90D WINDOW</span>
          </div>
          <div className="str-strip__cell str-strip__cell--time">
            <span className="str-strip__clock">11:05Z</span>
            <span className="str-strip__date">CONTINUOUS</span>
          </div>
        </div>

        <div className="str-strip str-strip--cocked">
          <span className="str-strip__band is-red"></span>
          <div className="str-strip__cell">
            <span className="str-strip__designator">TAXPR02</span>
            <span className="str-strip__type">grant · single</span>
          </div>
          <div className="str-strip__cell">
            <span className="str-strip__main">TaxPrep Co</span>
            <span className="str-strip__sub">tax_docs.read — single use</span>
          </div>
          <div className="str-strip__terms">
            <span>ONE QUERY</span>
            <span>THEN CLOSES</span>
          </div>
          <div className="str-strip__cell str-strip__cell--time">
            <span className="str-strip__clock is-red">-26H</span>
            <span className="str-strip__date">EXPIRING</span>
          </div>
        </div>

        <div className="str-bay__gap"></div>

        <div className="str-pulled">
          <div className="str-strip">
            <span className="str-strip__band"></span>
            <div className="str-strip__cell">
              <span className="str-strip__designator">ADTECH09</span>
              <span className="str-strip__type">grant · cont</span>
            </div>
            <div className="str-strip__cell">
              <span className="str-strip__main">Crosswise Ads</span>
              <span className="str-strip__sub">browsing.read — denied renewal</span>
            </div>
            <div className="str-strip__terms">
              <span>—</span>
            </div>
            <div className="str-strip__cell str-strip__cell--time">
              <span className="str-strip__clock">14:40Z</span>
              <span className="str-strip__date">PULLED NOV 02</span>
            </div>
          </div>
          <span className="str-pulled__caption">pulled — revocation is authoritative at the issuer</span>
        </div>
      </div>

      <div className="str-cap">
        <h3 className="str-cap__name">Statuses &amp; actions</h3>
        <span className="str-cap__sub">a strip out of line is the alert</span>
      </div>

      <div className="str-tags">
        <span className="str-tag str-tag--active"><span className="str-tag__dot"></span>Active</span>
        <span className="str-tag str-tag--cont"><span className="str-tag__dot"></span>Continuous</span>
        <span className="str-tag str-tag--exp"><span className="str-tag__dot"></span>Expiring -26h</span>
        <span className="str-tag str-tag--pulled"><span className="str-tag__dot"></span>Pulled</span>
      </div>

      <div className="str-actions">
        <button className="str-btn" type="button">File strip</button>
        <button className="str-btn str-btn--ghost" type="button">Cock for review</button>
        <button className="str-btn str-btn--pull" type="button">Pull strip</button>
      </div>
    </div>
  );
}

Object.assign(window, { StrIdentity, StrSurfaces });
})();
