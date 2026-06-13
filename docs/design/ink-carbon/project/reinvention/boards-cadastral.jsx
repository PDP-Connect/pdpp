/* Direction B — PLAT — boards */
;(() => {

function PlatIdentity() {
  return (
    <div className="plat">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 24 }}>
        <div className="plat-titleblock">
          <h1 className="plat-titleblock__name">PDPP</h1>
          <div className="plat-titleblock__rows">
            <div className="plat-titleblock__row"><span>Personal data</span><b>sheet 1 of 1</b></div>
            <div className="plat-titleblock__row"><span>Portability protocol</span><b>rev 0.1.0</b></div>
            <div className="plat-titleblock__row"><span>Office of the holder</span><b>rec. 2025-10-14</b></div>
          </div>
        </div>
        <p className="plat-note" style={{ textAlign: "right" }}>
          ref — county plat maps,<br />Sanborn atlases, recorded<br />easements, title blocks
        </p>
      </div>

      <h2 className="plat-statement">
        Every field has a <span className="r">boundary</span>.
      </h2>
      <p className="plat-body">
        Grant, field, record — PDPP already speaks the language of land records.
        Purpose-bound access <b>is</b> an easement: a recorded right to cross someone
        else's property, for a stated purpose, that can be <i>vacated</i>. Scopes are
        parcels. Withheld parcels carry the surveyor's own mark: <b>N.A.P. — Not A Part.</b>
      </p>

      <div>
        <div className="plat-cap">
          <h3 className="plat-cap__name">The plat</h3>
          <span className="plat-cap__sub">one grant, drawn to scale</span>
        </div>
        <div className="plat-map" style={{ marginTop: 14 }}>
          <div className="plat-map__parcel is-pink">
            <span className="plat-map__lot">1</span>
            <span className="plat-map__bearing">N 89°42′ E · 2Y 1MO</span>
            <span className="plat-map__pname">pay_statements</span>
          </div>
          <div className="plat-map__parcel is-yellow">
            <span className="plat-map__lot">2</span>
            <span className="plat-map__bearing">CUR + 5Y</span>
            <span className="plat-map__pname">employment</span>
          </div>
          <div className="plat-map__parcel is-nap" style={{ gridColumn: "1 / -1" }}>
            <span className="plat-map__nap-label">N.A.P. — tax_docs · identity · transactions</span>
          </div>
          <div className="plat-map__easement"></div>
          <span className="plat-map__easement-label">easement of purpose — longview planning</span>
        </div>
      </div>

      <div>
        <div className="plat-cap">
          <h3 className="plat-cap__name">Parcel fills</h3>
          <span className="plat-cap__sub">after the Sanborn key</span>
        </div>
        <div className="plat-fills" style={{ marginTop: 14 }}>
          <div className="plat-fill"><div className="plat-fill__chip is-pink"></div><span className="plat-fill__name">granted / human</span></div>
          <div className="plat-fill"><div className="plat-fill__chip is-yellow"></div><span className="plat-fill__name">granted / machine</span></div>
          <div className="plat-fill"><div className="plat-fill__chip is-hatch"></div><span className="plat-fill__name">easement / purpose</span></div>
          <div className="plat-fill"><div className="plat-fill__chip is-paper"></div><span className="plat-fill__name">n.a.p. / withheld</span></div>
          <div className="plat-fill"><div className="plat-fill__chip is-ink"></div><span className="plat-fill__name">ink</span></div>
        </div>
      </div>

      <div>
        <div className="plat-cap">
          <h3 className="plat-cap__name">Type</h3>
          <span className="plat-cap__sub">Barlow Condensed · Barlow · Spline Sans Mono</span>
        </div>
        <div className="plat-ramp" style={{ marginTop: 6 }}>
          <div className="plat-ramp__row">
            <span className="plat-ramp__tag">display / cond 600</span>
            <span style={{ fontFamily: "var(--plat-cond)", fontSize: 30, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.02em" }}>Granular access to personal data</span>
          </div>
          <div className="plat-ramp__row">
            <span className="plat-ramp__tag">body / barlow 400</span>
            <span style={{ fontSize: 15 }}>The resource server enforces the boundary. Only the granted parcels come back.</span>
          </div>
          <div className="plat-ramp__row">
            <span className="plat-ramp__tag">data / mono</span>
            <span style={{ fontFamily: "var(--plat-mono)", fontSize: 13 }}>pay_statements.read · append_only · exp 2025-12-14</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function PlatSurfaces() {
  return (
    <div className="plat" style={{ gap: 24 }}>
      <div className="plat-cap" style={{ borderTop: 0, paddingTop: 0 }}>
        <h3 className="plat-cap__name">Consent — grant of easement</h3>
        <span className="plat-cap__sub">the parcel schedule says exactly what crosses</span>
      </div>

      <div className="plat-inst">
        <div className="plat-inst__head">
          <h4 className="plat-inst__kind">Grant of easement</h4>
          <span className="plat-inst__no">inst. nº GRT-LONGVIEW01</span>
        </div>
        <div className="plat-inst__grantee">
          <span className="plat-inst__grantee-k">Grantee</span>
          <span className="plat-inst__grantee-v">Longview Planning</span>
          <span className="plat-inst__purpose">easement of purpose: long_term_financial_planning</span>
        </div>
        <div className="plat-sched">
          <div className="plat-srow">
            <span className="plat-srow__lot">1</span>
            <span className="plat-srow__fill is-pink"></span>
            <span className="plat-srow__what">
              <span className="plat-srow__name">pay_statements.read</span>
              <span className="plat-srow__desc">employer, period, gross &amp; net pay</span>
            </span>
            <span className="plat-srow__terms">APPEND ONLY · 2Y 1MO</span>
          </div>
          <div className="plat-srow">
            <span className="plat-srow__lot">2</span>
            <span className="plat-srow__fill is-yellow"></span>
            <span className="plat-srow__what">
              <span className="plat-srow__name">employment.read</span>
              <span className="plat-srow__desc">current and previous employers, with dates</span>
            </span>
            <span className="plat-srow__terms">CURRENT + 5Y</span>
          </div>
          <div className="plat-srow plat-srow--nap">
            <span className="plat-srow__lot">3</span>
            <span className="plat-srow__fill is-nap"></span>
            <span className="plat-srow__what">
              <span className="plat-srow__name">tax_docs.read</span>
              <span className="plat-srow__desc">not a part of this grant</span>
            </span>
            <span className="plat-srow__terms">N.A.P.</span>
          </div>
        </div>
        <div className="plat-inst__foot">
          <div className="plat-stamp">
            <span>Recorded — office of the holder</span>
            <b>2025 OCT 14 · 09:22Z</b>
          </div>
          <div className="plat-actions">
            <button className="plat-btn" type="button">Record grant</button>
            <button className="plat-btn plat-btn--vacate" type="button">Vacate</button>
          </div>
        </div>
      </div>

      <div className="plat-cap">
        <h3 className="plat-cap__name">Recorded grant</h3>
        <span className="plat-cap__sub">the index card in the recorder's office</span>
      </div>

      <div className="plat-record">
        <span className="plat-record__edge">Recorded</span>
        <div className="plat-record__grid">
          <div className="plat-record__cell"><span className="plat-record__k">Instrument</span><span className="plat-record__v">GRT-LONGVIEW01</span></div>
          <div className="plat-record__cell"><span className="plat-record__k">Grantee</span><span className="plat-record__v">longview</span></div>
          <div className="plat-record__cell"><span className="plat-record__k">Mode</span><span className="plat-record__v">continuous</span></div>
          <div className="plat-record__cell"><span className="plat-record__k">Parcels</span><span className="plat-record__v">2 granted · 1 n.a.p.</span></div>
          <div className="plat-record__cell"><span className="plat-record__k">Recorded</span><span className="plat-record__v">2025-10-14</span></div>
          <div className="plat-record__cell"><span className="plat-record__k">Expires</span><span className="plat-record__v">2025-12-14</span></div>
        </div>
      </div>

      <div className="plat-cap">
        <h3 className="plat-cap__name">Statuses &amp; actions</h3>
        <span className="plat-cap__sub">the recorder's language, verbatim</span>
      </div>

      <div className="plat-tags">
        <span className="plat-tag plat-tag--recorded">Recorded</span>
        <span className="plat-tag">Expires Dec 14</span>
        <span className="plat-tag plat-tag--expiring">Hatched — expiring</span>
        <span className="plat-tag plat-tag--vacated">Vacated</span>
      </div>

      <div className="plat-actions">
        <button className="plat-btn" type="button">Record</button>
        <button className="plat-btn plat-btn--ghost" type="button">Survey parcels</button>
        <button className="plat-btn plat-btn--vacate" type="button">Vacate easement</button>
      </div>
    </div>
  );
}

Object.assign(window, { PlatIdentity, PlatSurfaces });
})();
