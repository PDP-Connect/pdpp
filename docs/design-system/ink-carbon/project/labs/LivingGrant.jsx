// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// LivingGrant — the centerpiece. A grant as a breathing thermal object,
// with real records flowing through it in real time.

const { useState, useEffect, useRef } = React;

// A small deterministic fake record stream
const RECORD_STREAM = [
  { e: "Acme Co", g: "$4,812.50", n: "$3,622.18", p: "2025-09-16→30" },
  { e: "Acme Co", g: "$4,812.50", n: "$3,622.18", p: "2025-09-01→15" },
  { e: "Acme Co", g: "$4,812.50", n: "$3,624.42", p: "2025-08-16→31" },
  { e: "Acme Co", g: "$4,812.50", n: "$3,624.42", p: "2025-08-01→15" },
  { e: "Acme Co", g: "$4,812.50", n: "$3,624.42", p: "2025-07-16→31" },
  { e: "Acme Co", g: "$4,756.00", n: "$3,580.12", p: "2025-07-01→15" },
  { e: "Acme Co", g: "$4,756.00", n: "$3,580.12", p: "2025-06-16→30" },
  { e: "Acme Co", g: "$4,756.00", n: "$3,580.12", p: "2025-06-01→15" },
];

const LivingGrant = () => {
  const [cursor, setCursor] = useState(0);
  const [paused, setPaused] = useState(false);
  const [thermal, setThermal] = useState(0.62); // 0 = pure human, 1 = pure protocol

  useEffect(() => {
    if (paused) {
      return;
    }
    const t = setInterval(() => setCursor((c) => (c + 1) % RECORD_STREAM.length), 1800);
    return () => clearInterval(t);
  }, [paused]);

  const thermalColor = `color-mix(in oklch, var(--human) ${(1 - thermal) * 100}%, var(--protocol) ${thermal * 100}%)`;

  return (
    <div
      style={{
        background: "var(--paper)",
        border: "1px solid var(--rule)",
        display: "grid",
        gap: 0,
        gridTemplateColumns: "1fr 1fr",
        overflow: "hidden",
        position: "relative",
      }}
    >
      {/* The thermal rule across the top */}
      <div
        style={{
          background: "var(--thermal)",
          height: 2,
          left: 0,
          opacity: 0.8,
          position: "absolute",
          right: 0,
          top: 0,
        }}
      />

      {/* LEFT: Human side — the holder's view */}
      <div
        style={{
          background: "linear-gradient(135deg, var(--human-wash), transparent 65%)",
          borderRight: "1px solid var(--rule)",
          padding: "40px 36px",
          position: "relative",
        }}
      >
        <div style={{ alignItems: "baseline", display: "flex", justifyContent: "space-between" }}>
          <span className="gutter" style={{ color: "var(--human)" }}>
            §2 · HOLDER
          </span>
          <span className="gutter num">you</span>
        </div>
        <div className="t-section" style={{ marginTop: 18, maxWidth: 340 }}>
          <em>Longview</em> is reading your <span style={{ color: "var(--human)" }}>pay statements</span>.
        </div>
        <div className="t-body" style={{ marginTop: 14, maxWidth: 360 }}>
          Every other Friday since{" "}
          <span className="num" style={{ color: "var(--ink)" }}>
            Oct 14
          </span>
          . They see the employer, period, and gross and net pay. They cannot see your bank, address, or anything else.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 24 }}>
          {["pay_statements.read", "employment.read"].map((s) => (
            <div key={s} style={{ alignItems: "center", display: "flex", gap: 10 }}>
              <span
                style={{
                  animation: "pulse-dot 1.6s ease-in-out infinite",
                  background: "var(--live)",
                  borderRadius: 999,
                  height: 6,
                  width: 6,
                }}
              />
              <span className="t-mono" style={{ color: "var(--ink)" }}>
                {s}
              </span>
              <span className="t-mono" style={{ color: "var(--ink-faint)", marginLeft: "auto" }}>
                live
              </span>
            </div>
          ))}
          {["tax_docs.read", "identity.read", "transactions.read"].map((s) => (
            <div key={s} style={{ alignItems: "center", display: "flex", gap: 10, opacity: 0.35 }}>
              <span style={{ background: "var(--ink-whisper)", borderRadius: 999, height: 6, width: 6 }} />
              <span className="t-mono" style={{ color: "var(--ink-faint)" }}>
                {s}
              </span>
              <span className="t-mono" style={{ color: "var(--ink-faint)", marginLeft: "auto" }}>
                —
              </span>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 32 }}>
          <button className="btn btn-paper" style={{ fontSize: 13, height: 36 }}>
            Revoke grant
          </button>
          <button className="btn btn-ghost" style={{ fontSize: 13, height: 36 }}>
            Adjust scope →
          </button>
        </div>
      </div>

      {/* RIGHT: Protocol side — the machine's view */}
      <div
        style={{
          background: "linear-gradient(225deg, var(--protocol-wash), transparent 65%)",
          padding: "40px 36px",
          position: "relative",
        }}
      >
        <div style={{ alignItems: "baseline", display: "flex", justifyContent: "space-between" }}>
          <span className="gutter num">grt_longview01</span>
          <span className="gutter" style={{ color: "var(--protocol)" }}>
            ISSUER · §5
          </span>
        </div>
        <div className="t-section" style={{ marginLeft: "auto", marginTop: 18, maxWidth: 340, textAlign: "right" }}>
          <em>Longview</em> holds a <span style={{ color: "var(--protocol)" }}>grant</span>, not a key.
        </div>

        {/* The live stream pane */}
        <div
          style={{
            background: "var(--paper-warm)",
            border: "1px solid var(--rule)",
            borderRadius: 2,
            marginTop: 24,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              background: "var(--paper)",
              borderBottom: "1px solid var(--rule)",
              display: "grid",
              gridTemplateColumns: "1fr 1fr 0.8fr 0.8fr",
              padding: "6px 12px",
            }}
          >
            {["employer", "pay_period", "gross", "net"].map((h) => (
              <span className="gutter" key={h} style={{ fontSize: 9.5 }}>
                {h}
              </span>
            ))}
          </div>
          <div style={{ height: 140, overflow: "hidden", position: "relative" }}>
            {RECORD_STREAM.map((r, i) => {
              const offset = (i - cursor + RECORD_STREAM.length) % RECORD_STREAM.length;
              const y = offset * 20 - 10;
              const opacity = offset === 0 ? 1 : offset < 4 ? 0.8 - offset * 0.15 : 0;
              return (
                <div
                  key={i}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr 0.8fr 0.8fr",
                    left: 0,
                    opacity,
                    padding: "2px 12px",
                    position: "absolute",
                    right: 0,
                    top: y,
                    transition: "top 400ms var(--ease-read), opacity 400ms",
                  }}
                >
                  <span className="t-mono" style={{ color: "var(--ink)", fontSize: 11.5 }}>
                    {r.e}
                  </span>
                  <span className="t-mono num" style={{ color: "var(--ink-soft)", fontSize: 11.5 }}>
                    {r.p}
                  </span>
                  <span className="t-mono num" style={{ color: "var(--ink-soft)", fontSize: 11.5 }}>
                    {r.g}
                  </span>
                  <span className="t-mono num" style={{ color: "var(--ink)", fontSize: 11.5 }}>
                    {r.n}
                  </span>
                </div>
              );
            })}
            {/* Bottom fade */}
            <div
              style={{
                background: "linear-gradient(transparent, var(--paper-warm))",
                bottom: 0,
                height: 40,
                left: 0,
                pointerEvents: "none",
                position: "absolute",
                right: 0,
              }}
            />
          </div>
          <div
            style={{
              background: "var(--paper)",
              borderTop: "1px solid var(--rule)",
              display: "flex",
              justifyContent: "space-between",
              padding: "6px 12px",
            }}
          >
            <span className="gutter" style={{ fontSize: 9.5 }}>
              cursor: {String(cursor).padStart(3, "0")} / ∞
            </span>
            <button
              className="gutter"
              onClick={() => setPaused((p) => !p)}
              style={{ background: "none", border: "none", color: "var(--protocol)", cursor: "pointer", fontSize: 9.5 }}
            >
              {paused ? "▸ resume" : "‖ pause"}
            </button>
          </div>
        </div>

        <div className="t-small" style={{ marginTop: 16 }}>
          The resource server drops any field not named in the grant. Purpose is declared, not enforced. Revocation is
          authoritative at the issuer.
        </div>
      </div>

      {/* The thermal slider across the bottom — the metaphor made interactive */}
      <div
        style={{
          alignItems: "center",
          background: "var(--paper-warm)",
          borderTop: "1px solid var(--rule)",
          display: "flex",
          gap: 20,
          gridColumn: "1 / -1",
          padding: "20px 36px",
        }}
      >
        <span className="gutter">thermal →</span>
        <div
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setThermal(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
          }}
          style={{
            background: "var(--thermal)",
            borderRadius: 999,
            cursor: "pointer",
            flex: 1,
            height: 2,
            position: "relative",
          }}
        >
          <div
            style={{
              background: thermalColor,
              border: "2px solid var(--paper)",
              borderRadius: 999,
              boxShadow: "0 0 0 1px " + thermalColor,
              height: 14,
              left: `${thermal * 100}%`,
              position: "absolute",
              top: "50%",
              transform: "translate(-50%, -50%)",
              width: 14,
            }}
          />
        </div>
        <span className="gutter num" style={{ color: thermalColor, minWidth: 70, textAlign: "right" }}>
          {thermal < 0.35 ? "HOLDER" : thermal > 0.65 ? "ISSUER" : "BOUNDARY"} · {Math.round(thermal * 100)}°
        </span>
      </div>
    </div>
  );
};

window.LivingGrant = LivingGrant;
