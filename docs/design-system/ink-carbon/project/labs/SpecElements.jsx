// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// SpecPage — the whole thing as a reimagined document.

const NightToggle = () => {
  const [night, setNight] = useState(() => localStorage.getItem("pdpp-view") === "night");
  useEffect(() => {
    document.documentElement.dataset.view = night ? "night" : "day";
    localStorage.setItem("pdpp-view", night ? "night" : "day");
  }, [night]);
  return (
    <button
      className="gutter"
      onClick={() => setNight((n) => !n)}
      style={{
        background: "none",
        border: "1px solid var(--rule-deep)",
        borderRadius: 2,
        color: "var(--ink-soft)",
        cursor: "pointer",
        fontSize: 10,
        padding: "6px 10px",
      }}
    >
      {night ? "◐ night" : "◑ day"}
    </button>
  );
};

// Typographic mark — a 'P' with a serif terminal, drawn in paper over ink
const MarkP = ({ size = 32 }) => (
  <div
    style={{
      alignItems: "center",
      background: "var(--ink)",
      color: "var(--paper)",
      display: "inline-flex",
      fontFamily: "var(--font-serif)",
      fontSize: size * 0.58,
      fontVariationSettings: '"opsz" 144',
      fontWeight: 500,
      height: size,
      justifyContent: "center",
      letterSpacing: "-0.04em",
      position: "relative",
      width: size,
    }}
  >
    P
    <span
      style={{
        background: "var(--human)",
        borderRadius: 999,
        bottom: 3,
        height: 3,
        position: "absolute",
        right: 3,
        width: 3,
      }}
    />
  </div>
);

// The gutter-numbered spec row — like a printed RFC
const SpecRow = ({ num, t, children, tone }) => (
  <div
    style={{
      borderTop: "1px solid var(--rule)",
      display: "grid",
      gap: 24,
      gridTemplateColumns: "80px 1fr",
      padding: "22px 0",
    }}
  >
    <div>
      <div
        className="gutter num"
        style={{
          color: tone === "human" ? "var(--human)" : tone === "protocol" ? "var(--protocol)" : "var(--ink-faint)",
        }}
      >
        §{num}
      </div>
    </div>
    <div>
      <div
        style={{
          color: "var(--ink)",
          fontFamily: "var(--font-serif)",
          fontSize: 22,
          letterSpacing: "-0.015em",
          lineHeight: 1.3,
        }}
      >
        {t}
      </div>
      {children && (
        <div className="t-body" style={{ marginTop: 8, maxWidth: 620 }}>
          {children}
        </div>
      )}
    </div>
  </div>
);

// The thermal legend — a compact key that shows what the two colors mean
const ThermalLegend = () => (
  <div
    style={{
      alignItems: "stretch",
      border: "1px solid var(--rule)",
      borderRadius: 2,
      display: "flex",
      overflow: "hidden",
    }}
  >
    <div
      style={{ background: "linear-gradient(90deg, var(--human-wash), transparent)", flex: 1, padding: "14px 18px" }}
    >
      <div className="gutter" style={{ color: "var(--human)" }}>
        HOLDER SIDE
      </div>
      <div className="t-mono" style={{ color: "var(--ink)", marginTop: 4 }}>
        warm · declarative · consent
      </div>
    </div>
    <div style={{ background: "var(--thermal)", opacity: 0.5, width: 1 }} />
    <div
      style={{
        background: "linear-gradient(270deg, var(--protocol-wash), transparent)",
        flex: 1,
        padding: "14px 18px",
        textAlign: "right",
      }}
    >
      <div className="gutter" style={{ color: "var(--protocol)" }}>
        ISSUER SIDE
      </div>
      <div className="t-mono" style={{ color: "var(--ink)", marginTop: 4 }}>
        cool · enforcing · precise
      </div>
    </div>
  </div>
);

// Purpose taxonomy — a visual vocabulary for why data is requested
const PURPOSES = [
  { c: "planning", gloss: "forecast futures", tone: 0.2 },
  { c: "verification", gloss: "prove a fact", tone: 0.4 },
  { c: "underwriting", gloss: "assess risk", tone: 0.55 },
  { c: "research", gloss: "learn in aggregate", tone: 0.75 },
  { c: "fulfillment", gloss: "complete a request", tone: 0.9 },
];

const PurposeTaxonomy = () => (
  <div style={{ border: "1px solid var(--rule)", display: "flex", flexDirection: "column", gap: 0 }}>
    {PURPOSES.map((p, i) => {
      const color = `color-mix(in oklch, var(--human) ${(1 - p.tone) * 100}%, var(--protocol) ${p.tone * 100}%)`;
      return (
        <div
          key={p.c}
          style={{
            alignItems: "center",
            borderTop: i > 0 ? "1px solid var(--rule)" : "none",
            display: "grid",
            gap: 16,
            gridTemplateColumns: "32px 1fr 1fr auto",
            padding: "14px 18px",
          }}
        >
          <span className="num t-mono" style={{ color: "var(--ink-whisper)" }}>
            {String(i + 1).padStart(2, "0")}
          </span>
          <span className="t-mono" style={{ color }}>
            {p.c}
          </span>
          <span className="t-body" style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 300 }}>
            "{p.gloss}"
          </span>
          <div style={{ background: color, borderRadius: 999, height: 3, width: 60 }} />
        </div>
      );
    })}
  </div>
);

// Footer — a colophon in the RFC style
const Colophon = () => (
  <div
    style={{
      borderTop: "1px solid var(--rule)",
      display: "grid",
      gap: 32,
      gridTemplateColumns: "repeat(4, 1fr)",
      padding: "48px 0 64px",
    }}
  >
    <div>
      <div className="gutter">DOCUMENT</div>
      <div className="t-mono" style={{ color: "var(--ink)", marginTop: 8 }}>
        PDPP-0.1.0 · draft 3
      </div>
      <div className="t-mono" style={{ color: "var(--ink-faint)", marginTop: 2 }}>
        2026-04-19
      </div>
    </div>
    <div>
      <div className="gutter">SET</div>
      <div className="t-mono" style={{ color: "var(--ink)", marginTop: 8 }}>
        Fraunces · Geist · JetBrains Mono
      </div>
      <div className="t-mono" style={{ color: "var(--ink-faint)", marginTop: 2 }}>
        ligatures on · tabular figures
      </div>
    </div>
    <div>
      <div className="gutter">PRINTED</div>
      <div className="t-mono" style={{ color: "var(--ink)", marginTop: 8 }}>
        paper oklch(0.985 0.005 85)
      </div>
      <div className="t-mono" style={{ color: "var(--ink-faint)", marginTop: 2 }}>
        ink oklch(0.16 0.01 60)
      </div>
    </div>
    <div style={{ textAlign: "right" }}>
      <div className="gutter">COLOPHON</div>
      <div className="t-mono" style={{ color: "var(--ink)", marginTop: 8 }}>
        vana-com/pdpp
      </div>
      <div
        className="t-mono"
        style={{ color: "var(--ink-faint)", fontFamily: "var(--font-serif)", fontStyle: "italic", marginTop: 2 }}
      >
        "the grant is the artifact"
      </div>
    </div>
  </div>
);

window.NightToggle = NightToggle;
window.MarkP = MarkP;
window.SpecRow = SpecRow;
window.ThermalLegend = ThermalLegend;
window.PurposeTaxonomy = PurposeTaxonomy;
window.Colophon = Colophon;
