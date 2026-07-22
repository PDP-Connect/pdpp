// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// TheContract — a typographic manifesto. Big serif, set like a declaration, with mono annotations in the margin.

const TheContract = () => (
  <section style={{ borderBottom: "1px solid var(--rule)", padding: "120px 64px", position: "relative" }}>
    <div style={{ display: "grid", gap: 48, gridTemplateColumns: "140px 1fr 140px", margin: "0 auto", maxWidth: 1200 }}>
      {/* Left gutter — the annotations */}
      <aside style={{ paddingTop: 32 }}>
        <div className="gutter" style={{ color: "var(--ink-faint)" }}>
          §1.1 — §1.4
        </div>
        <div
          className="t-small"
          style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 300, marginTop: 8 }}
        >
          Read aloud. Every clause matters.
        </div>
      </aside>

      {/* The contract */}
      <div>
        <div className="gutter" style={{ color: "var(--ink-faint)" }}>
          THE FOUR COMMITMENTS
        </div>
        <div
          style={{
            fontFamily: "var(--font-serif)",
            fontSize: "clamp(36px, 4.2vw, 56px)",
            fontWeight: 300,
            letterSpacing: "-0.02em",
            lineHeight: 1.2,
            marginTop: 16,
          }}
        >
          <div style={{ marginBottom: 28 }}>
            <span
              className="num"
              style={{
                color: "var(--human)",
                fontFamily: "var(--font-mono)",
                fontSize: 14,
                letterSpacing: "0.05em",
                marginRight: 14,
                verticalAlign: "top",
              }}
            >
              I.
            </span>
            The <em style={{ color: "var(--human)", fontStyle: "italic" }}>holder</em> decides what may be read, for how
            long, and why.
          </div>
          <div style={{ marginBottom: 28 }}>
            <span
              className="num"
              style={{
                color: "var(--protocol)",
                fontFamily: "var(--font-mono)",
                fontSize: 14,
                letterSpacing: "0.05em",
                marginRight: 14,
                verticalAlign: "top",
              }}
            >
              II.
            </span>
            The <em style={{ color: "var(--protocol)", fontStyle: "italic" }}>issuer</em> drops every field not named in
            the grant.
          </div>
          <div style={{ marginBottom: 28 }}>
            <span
              className="num"
              style={{
                color: "var(--ink-soft)",
                fontFamily: "var(--font-mono)",
                fontSize: 14,
                letterSpacing: "0.05em",
                marginRight: 14,
                verticalAlign: "top",
              }}
            >
              III.
            </span>
            The <em style={{ fontStyle: "italic" }}>client</em> states a purpose. The purpose becomes part of the
            record.
          </div>
          <div>
            <span
              className="num"
              style={{
                color: "var(--voided)",
                fontFamily: "var(--font-mono)",
                fontSize: 14,
                letterSpacing: "0.05em",
                marginRight: 14,
                verticalAlign: "top",
              }}
            >
              IV.
            </span>
            <em style={{ color: "var(--voided)", fontStyle: "italic" }}>Revocation</em> is a hard stop. Authoritative at
            the issuer. No appeals.
          </div>
        </div>

        <div style={{ alignItems: "center", display: "flex", gap: 18, marginTop: 60 }}>
          <div style={{ background: "var(--rule)", flex: 1, height: 1 }} />
          <div className="gutter">so that</div>
          <div style={{ background: "var(--rule)", flex: 1, height: 1 }} />
        </div>

        <div
          style={{
            color: "var(--ink-soft)",
            fontFamily: "var(--font-serif)",
            fontSize: "clamp(28px, 3.2vw, 42px)",
            fontStyle: "italic",
            fontWeight: 400,
            letterSpacing: "-0.015em",
            lineHeight: 1.3,
            marginTop: 60,
          }}
        >
          Consent becomes{" "}
          <span
            style={{
              background: "var(--paper-warm)",
              borderBottom: "2px solid var(--human)",
              color: "var(--ink)",
              fontFamily: "var(--font-mono)",
              fontSize: "0.78em",
              fontStyle: "normal",
              letterSpacing: "-0.01em",
              padding: "2px 10px",
            }}
          >
            portable
          </span>
          , access becomes{" "}
          <span
            style={{
              background: "var(--paper-warm)",
              borderBottom: "2px solid var(--protocol)",
              color: "var(--ink)",
              fontFamily: "var(--font-mono)",
              fontSize: "0.78em",
              fontStyle: "normal",
              letterSpacing: "-0.01em",
              padding: "2px 10px",
            }}
          >
            granular
          </span>
          , and data stops being a key to steal.
        </div>
      </div>

      {/* Right gutter — the counterweight */}
      <aside style={{ paddingTop: 32, textAlign: "right" }}>
        <div className="gutter" style={{ color: "var(--ink-faint)" }}>
          RATIFIED
        </div>
        <div className="t-mono" style={{ color: "var(--ink)", marginTop: 8 }}>
          2026-04-19
        </div>
        <div style={{ display: "inline-block", marginTop: 12 }}>
          <svg height="40" style={{ display: "block", marginLeft: "auto" }} viewBox="0 0 80 40" width="80">
            <path
              d="M4 30 C 12 10, 24 10, 30 26 S 52 34, 58 14 S 72 20, 76 28"
              fill="none"
              opacity="0.55"
              stroke="var(--ink)"
              strokeLinecap="round"
              strokeWidth="1.2"
            />
          </svg>
        </div>
        <div className="t-small" style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", marginTop: 6 }}>
          the committee
        </div>
      </aside>
    </div>
  </section>
);

window.TheContract = TheContract;
