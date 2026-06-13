// TheAtlas — the spec as a visual index. Purposes, scopes, and temperatures laid out as a map.

const SCOPES_MAP = [
  { s: 'pay_statements',  fields: 6, reads: 48, axis: 0.35 },
  { s: 'employment',      fields: 4, reads: 12, axis: 0.45 },
  { s: 'tax_documents',   fields: 5, reads: 6,  axis: 0.4 },
  { s: 'identity',        fields: 3, reads: 23, axis: 0.7 },
  { s: 'transactions',    fields: 8, reads: 94, axis: 0.55 },
  { s: 'health_records',  fields: 12, reads: 2, axis: 0.25 },
  { s: 'location',        fields: 2, reads: 156, axis: 0.85 },
];

const TheAtlas = () => {
  const maxReads = Math.max(...SCOPES_MAP.map(s => s.reads));
  return (
    <section style={{ padding: '96px 64px', borderBottom: '1px solid var(--rule)' }}>
      <div style={{ maxWidth: 1200, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 40 }}>
          <div>
            <div className="gutter">§4 · THE ATLAS</div>
            <h2 className="t-section" style={{ margin: '12px 0 0' }}>
              Every stream is a <em>temperature</em>.
            </h2>
            <p className="t-body" style={{ marginTop: 10, maxWidth: 560 }}>
              Warmer streams are intimate — held close by the person who owns them. Cooler streams are transactional — issued and acknowledged by machines. The thermal axis runs under every design decision.
            </p>
          </div>
          <ThermalLegend />
        </div>

        {/* The atlas itself — a thermal bar chart */}
        <div style={{ border: '1px solid var(--rule)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ padding: '10px 20px', background: 'var(--paper-warm)', borderBottom: '1px solid var(--rule)', display: 'grid', gridTemplateColumns: '200px 80px 1fr 80px', gap: 16 }}>
            <span className="gutter">stream</span>
            <span className="gutter">fields</span>
            <span className="gutter">temperature · warmer to cooler</span>
            <span className="gutter" style={{ textAlign: 'right' }}>reads/24h</span>
          </div>
          {SCOPES_MAP.map((s, i) => {
            const color = `color-mix(in oklch, var(--human) ${(1-s.axis)*100}%, var(--protocol) ${s.axis*100}%)`;
            return (
              <div key={s.s} style={{ padding: '16px 20px', display: 'grid', gridTemplateColumns: '200px 80px 1fr 80px', gap: 16, alignItems: 'center', borderTop: i > 0 ? '1px solid var(--rule)' : 'none' }}>
                <div>
                  <span className="t-mono" style={{ color: 'var(--ink)', fontSize: 13 }}>{s.s}</span>
                </div>
                <span className="t-mono num" style={{ color: 'var(--ink-soft)' }}>{s.fields}</span>
                <div style={{ position: 'relative', height: 24, display: 'flex', alignItems: 'center' }}>
                  <div style={{ position: 'absolute', inset: 0, background: 'var(--thermal)', opacity: 0.08, borderRadius: 2 }}/>
                  <div style={{
                    position: 'absolute', left: `${s.axis * 100}%`,
                    top: 0, bottom: 0, width: 3,
                    background: color, transform: 'translateX(-50%)',
                    boxShadow: `0 0 0 3px color-mix(in oklch, ${color} 25%, transparent)`,
                  }}/>
                  {/* tick marks */}
                  {[0.25, 0.5, 0.75].map(t => (
                    <div key={t} style={{ position: 'absolute', left: `${t*100}%`, top: '50%', width: 1, height: 4, background: 'var(--rule-deep)', transform: 'translate(-50%, -50%)' }}/>
                  ))}
                </div>
                <div style={{ textAlign: 'right', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                  <div style={{ width: 40, height: 2, background: 'var(--rule-deep)', borderRadius: 999, overflow: 'hidden', position: 'relative' }}>
                    <div style={{ position: 'absolute', inset: 0, right: `${(1 - s.reads/maxReads) * 100}%`, background: color }}/>
                  </div>
                  <span className="t-mono num" style={{ color: 'var(--ink)', fontSize: 12, minWidth: 28, textAlign: 'right' }}>{s.reads}</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footnote */}
        <div style={{ marginTop: 24, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 24 }}>
          <div className="t-small" style={{ fontStyle: 'italic', fontFamily: 'var(--font-serif)', borderLeft: '2px solid var(--human)', paddingLeft: 14 }}>
            "A location stream is colder than a pay stream, because its provenance has already been abstracted by the device."
          </div>
          <div className="t-small" style={{ fontFamily: 'var(--font-serif)', textAlign: 'center' }}>
            — from the annotated spec, footnote 4.11
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="gutter">also see</div>
            <div className="t-mono" style={{ marginTop: 6, color: 'var(--protocol)' }}>§4.2 field projection</div>
            <div className="t-mono" style={{ color: 'var(--protocol)' }}>§4.3 stream modes</div>
          </div>
        </div>
      </div>
    </section>
  );
};

window.TheAtlas = TheAtlas;
