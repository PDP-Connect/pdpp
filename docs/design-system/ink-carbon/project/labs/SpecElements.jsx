// SpecPage — the whole thing as a reimagined document.

const NightToggle = () => {
  const [night, setNight] = useState(() => localStorage.getItem('pdpp-view') === 'night');
  useEffect(() => {
    document.documentElement.dataset.view = night ? 'night' : 'day';
    localStorage.setItem('pdpp-view', night ? 'night' : 'day');
  }, [night]);
  return (
    <button onClick={() => setNight(n => !n)} className="gutter"
      style={{ background: 'none', border: '1px solid var(--rule-deep)', padding: '6px 10px', cursor: 'pointer', color: 'var(--ink-soft)', fontSize: 10, borderRadius: 2 }}>
      {night ? '◐ night' : '◑ day'}
    </button>
  );
};

// Typographic mark — a 'P' with a serif terminal, drawn in paper over ink
const MarkP = ({ size = 32 }) => (
  <div style={{
    width: size, height: size, background: 'var(--ink)', color: 'var(--paper)',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: 'var(--font-serif)', fontWeight: 500, fontSize: size * 0.58,
    letterSpacing: '-0.04em', position: 'relative', fontVariationSettings: '"opsz" 144',
  }}>
    P
    <span style={{ position: 'absolute', bottom: 3, right: 3, width: 3, height: 3, background: 'var(--human)', borderRadius: 999 }}/>
  </div>
);

// The gutter-numbered spec row — like a printed RFC
const SpecRow = ({ num, t, children, tone }) => (
  <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: 24, padding: '22px 0', borderTop: '1px solid var(--rule)' }}>
    <div>
      <div className="gutter num" style={{ color: tone === 'human' ? 'var(--human)' : tone === 'protocol' ? 'var(--protocol)' : 'var(--ink-faint)' }}>§{num}</div>
    </div>
    <div>
      <div style={{ fontFamily: 'var(--font-serif)', fontSize: 22, lineHeight: 1.3, letterSpacing: '-0.015em', color: 'var(--ink)' }}>{t}</div>
      {children && <div className="t-body" style={{ marginTop: 8, maxWidth: 620 }}>{children}</div>}
    </div>
  </div>
);

// The thermal legend — a compact key that shows what the two colors mean
const ThermalLegend = () => (
  <div style={{ display: 'flex', alignItems: 'stretch', border: '1px solid var(--rule)', borderRadius: 2, overflow: 'hidden' }}>
    <div style={{ flex: 1, padding: '14px 18px', background: 'linear-gradient(90deg, var(--human-wash), transparent)' }}>
      <div className="gutter" style={{ color: 'var(--human)' }}>HOLDER SIDE</div>
      <div className="t-mono" style={{ marginTop: 4, color: 'var(--ink)' }}>warm · declarative · consent</div>
    </div>
    <div style={{ width: 1, background: 'var(--thermal)', opacity: 0.5 }}/>
    <div style={{ flex: 1, padding: '14px 18px', background: 'linear-gradient(270deg, var(--protocol-wash), transparent)', textAlign: 'right' }}>
      <div className="gutter" style={{ color: 'var(--protocol)' }}>ISSUER SIDE</div>
      <div className="t-mono" style={{ marginTop: 4, color: 'var(--ink)' }}>cool · enforcing · precise</div>
    </div>
  </div>
);

// Purpose taxonomy — a visual vocabulary for why data is requested
const PURPOSES = [
  { c: 'planning',       gloss: 'forecast futures',     tone: 0.2 },
  { c: 'verification',   gloss: 'prove a fact',         tone: 0.4 },
  { c: 'underwriting',   gloss: 'assess risk',          tone: 0.55 },
  { c: 'research',       gloss: 'learn in aggregate',   tone: 0.75 },
  { c: 'fulfillment',    gloss: 'complete a request',   tone: 0.9 },
];

const PurposeTaxonomy = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 0, border: '1px solid var(--rule)' }}>
    {PURPOSES.map((p, i) => {
      const color = `color-mix(in oklch, var(--human) ${(1-p.tone)*100}%, var(--protocol) ${p.tone*100}%)`;
      return (
        <div key={p.c} style={{ display: 'grid', gridTemplateColumns: '32px 1fr 1fr auto', alignItems: 'center', padding: '14px 18px', borderTop: i > 0 ? '1px solid var(--rule)' : 'none', gap: 16 }}>
          <span className="num t-mono" style={{ color: 'var(--ink-whisper)' }}>{String(i+1).padStart(2,'0')}</span>
          <span className="t-mono" style={{ color }}>{p.c}</span>
          <span className="t-body" style={{ fontStyle: 'italic', fontFamily: 'var(--font-serif)', fontWeight: 300 }}>"{p.gloss}"</span>
          <div style={{ width: 60, height: 3, background: color, borderRadius: 999 }}/>
        </div>
      );
    })}
  </div>
);

// Footer — a colophon in the RFC style
const Colophon = () => (
  <div style={{ padding: '48px 0 64px', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 32, borderTop: '1px solid var(--rule)' }}>
    <div>
      <div className="gutter">DOCUMENT</div>
      <div className="t-mono" style={{ marginTop: 8, color: 'var(--ink)' }}>PDPP-0.1.0 · draft 3</div>
      <div className="t-mono" style={{ color: 'var(--ink-faint)', marginTop: 2 }}>2026-04-19</div>
    </div>
    <div>
      <div className="gutter">SET</div>
      <div className="t-mono" style={{ marginTop: 8, color: 'var(--ink)' }}>Fraunces · Geist · JetBrains Mono</div>
      <div className="t-mono" style={{ color: 'var(--ink-faint)', marginTop: 2 }}>ligatures on · tabular figures</div>
    </div>
    <div>
      <div className="gutter">PRINTED</div>
      <div className="t-mono" style={{ marginTop: 8, color: 'var(--ink)' }}>paper oklch(0.985 0.005 85)</div>
      <div className="t-mono" style={{ color: 'var(--ink-faint)', marginTop: 2 }}>ink oklch(0.16 0.01 60)</div>
    </div>
    <div style={{ textAlign: 'right' }}>
      <div className="gutter">COLOPHON</div>
      <div className="t-mono" style={{ marginTop: 8, color: 'var(--ink)' }}>vana-com/pdpp</div>
      <div className="t-mono" style={{ color: 'var(--ink-faint)', marginTop: 2, fontStyle: 'italic', fontFamily: 'var(--font-serif)' }}>"the grant is the artifact"</div>
    </div>
  </div>
);

window.NightToggle = NightToggle;
window.MarkP = MarkP;
window.SpecRow = SpecRow;
window.ThermalLegend = ThermalLegend;
window.PurposeTaxonomy = PurposeTaxonomy;
window.Colophon = Colophon;
