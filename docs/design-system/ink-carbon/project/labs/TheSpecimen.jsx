// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// TheSpecimen — the type system shown as a specimen page, in the way a foundry would.

const TheSpecimen = () => (
  <section style={{ borderBottom: "1px solid var(--rule)", padding: "96px 64px" }}>
    <div style={{ margin: "0 auto", maxWidth: 1200 }}>
      <div style={{ display: "grid", gap: 48, gridTemplateColumns: "280px 1fr" }}>
        <div>
          <div className="gutter">§6 · SPECIMEN</div>
          <h2 className="t-section" style={{ fontSize: 38, margin: "12px 0 0" }}>
            Three faces, one voice.
          </h2>
          <p className="t-body" style={{ marginTop: 16 }}>
            A serif speaks for the protocol. A sans-serif speaks for the person. A monospace speaks for the machine. All
            three share a paper.
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: 24, marginTop: 40 }}>
            <div>
              <div className="gutter">DISPLAY</div>
              <div className="t-mono" style={{ color: "var(--ink)", marginTop: 4 }}>
                Fraunces
              </div>
              <div className="t-mono" style={{ color: "var(--ink-faint)" }}>
                opsz 144 · wght 300–500
              </div>
            </div>
            <div>
              <div className="gutter">TEXT</div>
              <div className="t-mono" style={{ color: "var(--ink)", marginTop: 4 }}>
                Geist
              </div>
              <div className="t-mono" style={{ color: "var(--ink-faint)" }}>
                wght 300–600
              </div>
            </div>
            <div>
              <div className="gutter">MACHINE</div>
              <div className="t-mono" style={{ color: "var(--ink)", marginTop: 4 }}>
                JetBrains Mono
              </div>
              <div className="t-mono" style={{ color: "var(--ink-faint)" }}>
                tnum, cv02, ss01
              </div>
            </div>
          </div>
        </div>

        <div>
          {/* Big letter specimen */}
          <div
            style={{
              alignItems: "baseline",
              borderBottom: "1px solid var(--rule)",
              borderTop: "1px solid var(--rule-deep)",
              display: "flex",
              justifyContent: "space-between",
              padding: "32px 0",
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-serif)",
                fontSize: 200,
                fontVariationSettings: '"opsz" 144',
                fontWeight: 300,
                letterSpacing: "-0.05em",
                lineHeight: 1,
              }}
            >
              Aa
            </span>
            <span
              style={{
                color: "var(--human)",
                fontFamily: "var(--font-serif)",
                fontSize: 200,
                fontStyle: "italic",
                fontVariationSettings: '"opsz" 144',
                fontWeight: 400,
                letterSpacing: "-0.04em",
                lineHeight: 1,
              }}
            >
              Aa
            </span>
            <span
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: 200,
                fontWeight: 500,
                letterSpacing: "-0.05em",
                lineHeight: 1,
              }}
            >
              Aa
            </span>
            <span
              style={{
                color: "var(--protocol)",
                fontFamily: "var(--font-mono)",
                fontSize: 160,
                fontWeight: 400,
                lineHeight: 1,
              }}
            >
              Aa
            </span>
          </div>

          {/* Pangram stack */}
          <div style={{ borderBottom: "1px solid var(--rule)", padding: "32px 0" }}>
            <div className="gutter">PANGRAM · serif / italic / sans / mono</div>
            <div
              style={{
                fontFamily: "var(--font-serif)",
                fontSize: 32,
                fontVariationSettings: '"opsz" 72',
                fontWeight: 400,
                lineHeight: 1.2,
                marginTop: 12,
              }}
            >
              The grant is the artifact, not the key.
            </div>
            <div
              style={{
                color: "var(--human)",
                fontFamily: "var(--font-serif)",
                fontSize: 32,
                fontStyle: "italic",
                fontVariationSettings: '"opsz" 72',
                fontWeight: 300,
                lineHeight: 1.2,
              }}
            >
              The holder decides what may be read, and why.
            </div>
            <div
              style={{
                color: "var(--ink-soft)",
                fontFamily: "var(--font-sans)",
                fontSize: 22,
                lineHeight: 1.5,
                marginTop: 12,
              }}
            >
              Clients request named records and fields. Every response stays inside the grant.
            </div>
            <div
              style={{
                color: "var(--protocol)",
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                lineHeight: 1.6,
                marginTop: 12,
              }}
            >
              GET /v1/streams/pay_statements/records &nbsp;·&nbsp; grant_id=grt_longview01 &nbsp;·&nbsp; 200 OK
            </div>
          </div>

          {/* Numerals showcase — tabular figures for the ledger */}
          <div style={{ borderBottom: "1px solid var(--rule)", padding: "32px 0" }}>
            <div className="gutter">LEDGER · tabular figures · mono + serif</div>
            <div style={{ display: "grid", gap: 48, gridTemplateColumns: "1fr 1fr", marginTop: 16 }}>
              <div
                className="num"
                style={{ color: "var(--ink)", fontFamily: "var(--font-mono)", fontSize: 22, lineHeight: 1.5 }}
              >
                <div>2025-10-14 09:22:07Z</div>
                <div>2025-10-28 09:22:07Z</div>
                <div>2025-11-11 09:22:07Z</div>
                <div style={{ color: "var(--voided)" }}>2025-11-25 14:08:02Z ✕</div>
              </div>
              <div
                className="num"
                style={{
                  color: "var(--ink)",
                  fontFamily: "var(--font-serif)",
                  fontFeatureSettings: '"tnum"',
                  fontSize: 22,
                  fontVariationSettings: '"opsz" 72, "tnum"',
                  lineHeight: 1.5,
                }}
              >
                <div>$4,812.50 &nbsp; gross</div>
                <div>$3,622.18 &nbsp; net</div>
                <div>$1,190.32 &nbsp; withheld</div>
                <div style={{ color: "var(--human)", fontStyle: "italic" }}>— every fortnight</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
);

window.TheSpecimen = TheSpecimen;
