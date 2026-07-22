// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// TheContract — a typographic manifesto. Big serif, set like a declaration, with mono annotations in the margin.

const TheContract = () => (
  <section style={{ padding: "120px 64px", position: "relative", borderBottom: "1px solid var(--rule)" }}>
    <div style={{ maxWidth: 1200, margin: "0 auto", display: "grid", gridTemplateColumns: "140px 1fr 140px", gap: 48 }}>
      {/* Left gutter — the annotations */}
      <aside style={{ paddingTop: 32 }}>
        <div className="gutter" style={{ color: "var(--ink-faint)" }}>
          §1.1 — §1.4
        </div>
        <div
          className="t-small"
          style={{ marginTop: 8, fontStyle: "italic", fontFamily: "var(--font-serif)", fontWeight: 300 }}
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
            marginTop: 16,
            fontFamily: "var(--font-serif)",
            fontWeight: 300,
            fontSize: "clamp(36px, 4.2vw, 56px)",
            lineHeight: 1.2,
            letterSpacing: "-0.02em",
          }}
        >
          <div style={{ marginBottom: 28 }}>
            <span
              className="num"
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 14,
                color: "var(--human)",
                verticalAlign: "top",
                marginRight: 14,
                letterSpacing: "0.05em",
              }}
            >
              I.
            </span>
            The <em style={{ fontStyle: "italic", color: "var(--human)" }}>holder</em> decides what may be read, for how
            long, and why.
          </div>
          <div style={{ marginBottom: 28 }}>
            <span
              className="num"
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 14,
                color: "var(--protocol)",
                verticalAlign: "top",
                marginRight: 14,
                letterSpacing: "0.05em",
              }}
            >
              II.
            </span>
            The <em style={{ fontStyle: "italic", color: "var(--protocol)" }}>issuer</em> drops every field not named in
            the grant.
          </div>
          <div style={{ marginBottom: 28 }}>
            <span
              className="num"
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 14,
                color: "var(--ink-soft)",
                verticalAlign: "top",
                marginRight: 14,
                letterSpacing: "0.05em",
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
                fontFamily: "var(--font-mono)",
                fontSize: 14,
                color: "var(--voided)",
                verticalAlign: "top",
                marginRight: 14,
                letterSpacing: "0.05em",
              }}
            >
              IV.
            </span>
            <em style={{ fontStyle: "italic", color: "var(--voided)" }}>Revocation</em> is a hard stop. Authoritative at
            the issuer. No appeals.
          </div>
        </div>

        <div style={{ marginTop: 60, display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ flex: 1, height: 1, background: "var(--rule)" }} />
          <div className="gutter">so that</div>
          <div style={{ flex: 1, height: 1, background: "var(--rule)" }} />
        </div>

        <div
          style={{
            marginTop: 60,
            fontFamily: "var(--font-serif)",
            fontWeight: 400,
            fontStyle: "italic",
            fontSize: "clamp(28px, 3.2vw, 42px)",
            lineHeight: 1.3,
            letterSpacing: "-0.015em",
            color: "var(--ink-soft)",
          }}
        >
          Consent becomes{" "}
          <span
            style={{
              color: "var(--ink)",
              fontStyle: "normal",
              fontFamily: "var(--font-mono)",
              fontSize: "0.78em",
              padding: "2px 10px",
              background: "var(--paper-warm)",
              borderBottom: "2px solid var(--human)",
              letterSpacing: "-0.01em",
            }}
          >
            portable
          </span>
          , access becomes{" "}
          <span
            style={{
              color: "var(--ink)",
              fontStyle: "normal",
              fontFamily: "var(--font-mono)",
              fontSize: "0.78em",
              padding: "2px 10px",
              background: "var(--paper-warm)",
              borderBottom: "2px solid var(--protocol)",
              letterSpacing: "-0.01em",
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
        <div className="t-mono" style={{ marginTop: 8, color: "var(--ink)" }}>
          2026-04-19
        </div>
        <div style={{ marginTop: 12, display: "inline-block" }}>
          <svg width="80" height="40" viewBox="0 0 80 40" style={{ display: "block", marginLeft: "auto" }}>
            <path
              d="M4 30 C 12 10, 24 10, 30 26 S 52 34, 58 14 S 72 20, 76 28"
              stroke="var(--ink)"
              strokeWidth="1.2"
              fill="none"
              strokeLinecap="round"
              opacity="0.55"
            />
          </svg>
        </div>
        <div className="t-small" style={{ marginTop: 6, fontStyle: "italic", fontFamily: "var(--font-serif)" }}>
          the committee
        </div>
      </aside>
    </div>
  </section>
);

window.TheContract = TheContract;
