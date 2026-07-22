// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// TheAtlas — the spec as a visual index. Purposes, scopes, and temperatures laid out as a map.

const SCOPES_MAP = [
  { axis: 0.35, fields: 6, reads: 48, s: "pay_statements" },
  { axis: 0.45, fields: 4, reads: 12, s: "employment" },
  { axis: 0.4, fields: 5, reads: 6, s: "tax_documents" },
  { axis: 0.7, fields: 3, reads: 23, s: "identity" },
  { axis: 0.55, fields: 8, reads: 94, s: "transactions" },
  { axis: 0.25, fields: 12, reads: 2, s: "health_records" },
  { axis: 0.85, fields: 2, reads: 156, s: "location" },
];

const TheAtlas = () => {
  const maxReads = Math.max(...SCOPES_MAP.map((s) => s.reads));
  return (
    <section style={{ borderBottom: "1px solid var(--rule)", padding: "96px 64px" }}>
      <div style={{ margin: "0 auto", maxWidth: 1200 }}>
        <div style={{ alignItems: "baseline", display: "flex", justifyContent: "space-between", marginBottom: 40 }}>
          <div>
            <div className="gutter">§4 · THE ATLAS</div>
            <h2 className="t-section" style={{ margin: "12px 0 0" }}>
              Every stream is a <em>temperature</em>.
            </h2>
            <p className="t-body" style={{ marginTop: 10, maxWidth: 560 }}>
              Warmer streams are intimate — held close by the person who owns them. Cooler streams are transactional —
              issued and acknowledged by machines. The thermal axis runs under every design decision.
            </p>
          </div>
          <ThermalLegend />
        </div>

        {/* The atlas itself — a thermal bar chart */}
        <div style={{ border: "1px solid var(--rule)", borderRadius: 2, overflow: "hidden" }}>
          <div
            style={{
              background: "var(--paper-warm)",
              borderBottom: "1px solid var(--rule)",
              display: "grid",
              gap: 16,
              gridTemplateColumns: "200px 80px 1fr 80px",
              padding: "10px 20px",
            }}
          >
            <span className="gutter">stream</span>
            <span className="gutter">fields</span>
            <span className="gutter">temperature · warmer to cooler</span>
            <span className="gutter" style={{ textAlign: "right" }}>
              reads/24h
            </span>
          </div>
          {SCOPES_MAP.map((s, i) => {
            const color = `color-mix(in oklch, var(--human) ${(1 - s.axis) * 100}%, var(--protocol) ${s.axis * 100}%)`;
            return (
              <div
                key={s.s}
                style={{
                  alignItems: "center",
                  borderTop: i > 0 ? "1px solid var(--rule)" : "none",
                  display: "grid",
                  gap: 16,
                  gridTemplateColumns: "200px 80px 1fr 80px",
                  padding: "16px 20px",
                }}
              >
                <div>
                  <span className="t-mono" style={{ color: "var(--ink)", fontSize: 13 }}>
                    {s.s}
                  </span>
                </div>
                <span className="t-mono num" style={{ color: "var(--ink-soft)" }}>
                  {s.fields}
                </span>
                <div style={{ alignItems: "center", display: "flex", height: 24, position: "relative" }}>
                  <div
                    style={{
                      background: "var(--thermal)",
                      borderRadius: 2,
                      inset: 0,
                      opacity: 0.08,
                      position: "absolute",
                    }}
                  />
                  <div
                    style={{
                      background: color,
                      bottom: 0,
                      boxShadow: `0 0 0 3px color-mix(in oklch, ${color} 25%, transparent)`,
                      left: `${s.axis * 100}%`,
                      position: "absolute",
                      top: 0,
                      transform: "translateX(-50%)",
                      width: 3,
                    }}
                  />
                  {/* tick marks */}
                  {[0.25, 0.5, 0.75].map((t) => (
                    <div
                      key={t}
                      style={{
                        background: "var(--rule-deep)",
                        height: 4,
                        left: `${t * 100}%`,
                        position: "absolute",
                        top: "50%",
                        transform: "translate(-50%, -50%)",
                        width: 1,
                      }}
                    />
                  ))}
                </div>
                <div
                  style={{
                    alignItems: "center",
                    display: "flex",
                    gap: 8,
                    justifyContent: "flex-end",
                    textAlign: "right",
                  }}
                >
                  <div
                    style={{
                      background: "var(--rule-deep)",
                      borderRadius: 999,
                      height: 2,
                      overflow: "hidden",
                      position: "relative",
                      width: 40,
                    }}
                  >
                    <div
                      style={{
                        background: color,
                        inset: 0,
                        position: "absolute",
                        right: `${(1 - s.reads / maxReads) * 100}%`,
                      }}
                    />
                  </div>
                  <span
                    className="t-mono num"
                    style={{ color: "var(--ink)", fontSize: 12, minWidth: 28, textAlign: "right" }}
                  >
                    {s.reads}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footnote */}
        <div style={{ display: "grid", gap: 24, gridTemplateColumns: "1fr 1fr 1fr", marginTop: 24 }}>
          <div
            className="t-small"
            style={{
              borderLeft: "2px solid var(--human)",
              fontFamily: "var(--font-serif)",
              fontStyle: "italic",
              paddingLeft: 14,
            }}
          >
            "A location stream is colder than a pay stream, because its provenance has already been abstracted by the
            device."
          </div>
          <div className="t-small" style={{ fontFamily: "var(--font-serif)", textAlign: "center" }}>
            — from the annotated spec, footnote 4.11
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="gutter">also see</div>
            <div className="t-mono" style={{ color: "var(--protocol)", marginTop: 6 }}>
              §4.2 field projection
            </div>
            <div className="t-mono" style={{ color: "var(--protocol)" }}>
              §4.3 stream modes
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

window.TheAtlas = TheAtlas;
