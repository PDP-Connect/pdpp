// TheSpecimen — the type system shown as a specimen page, in the way a foundry would.

const TheSpecimen = () => (
  <section style={{ padding: '96px 64px', borderBottom: '1px solid var(--rule)' }}>
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 48 }}>
        <div>
          <div className="gutter">§6 · SPECIMEN</div>
          <h2 className="t-section" style={{ margin: '12px 0 0', fontSize: 38 }}>
            Three faces, one voice.
          </h2>
          <p className="t-body" style={{ marginTop: 16 }}>
            A serif speaks for the protocol. A sans-serif speaks for the person. A monospace speaks for the machine. All three share a paper.
          </p>

          <div style={{ marginTop: 40, display: 'flex', flexDirection: 'column', gap: 24 }}>
            <div>
              <div className="gutter">DISPLAY</div>
              <div className="t-mono" style={{ marginTop: 4, color: 'var(--ink)' }}>Fraunces</div>
              <div className="t-mono" style={{ color: 'var(--ink-faint)' }}>opsz 144 · wght 300–500</div>
            </div>
            <div>
              <div className="gutter">TEXT</div>
              <div className="t-mono" style={{ marginTop: 4, color: 'var(--ink)' }}>Geist</div>
              <div className="t-mono" style={{ color: 'var(--ink-faint)' }}>wght 300–600</div>
            </div>
            <div>
              <div className="gutter">MACHINE</div>
              <div className="t-mono" style={{ marginTop: 4, color: 'var(--ink)' }}>JetBrains Mono</div>
              <div className="t-mono" style={{ color: 'var(--ink-faint)' }}>tnum, cv02, ss01</div>
            </div>
          </div>
        </div>

        <div>
          {/* Big letter specimen */}
          <div style={{ borderTop: '1px solid var(--rule-deep)', borderBottom: '1px solid var(--rule)', padding: '32px 0', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <span style={{ fontFamily: 'var(--font-serif)', fontSize: 200, lineHeight: 1, fontWeight: 300, letterSpacing: '-0.05em', fontVariationSettings: '"opsz" 144' }}>Aa</span>
            <span style={{ fontFamily: 'var(--font-serif)', fontSize: 200, lineHeight: 1, fontStyle: 'italic', fontWeight: 400, letterSpacing: '-0.04em', color: 'var(--human)', fontVariationSettings: '"opsz" 144' }}>Aa</span>
            <span style={{ fontFamily: 'var(--font-sans)', fontSize: 200, lineHeight: 1, fontWeight: 500, letterSpacing: '-0.05em' }}>Aa</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 160, lineHeight: 1, fontWeight: 400, color: 'var(--protocol)' }}>Aa</span>
          </div>

          {/* Pangram stack */}
          <div style={{ padding: '32px 0', borderBottom: '1px solid var(--rule)' }}>
            <div className="gutter">PANGRAM · serif / italic / sans / mono</div>
            <div style={{ fontFamily: 'var(--font-serif)', fontSize: 32, lineHeight: 1.2, marginTop: 12, fontWeight: 400, fontVariationSettings: '"opsz" 72' }}>
              The grant is the artifact, not the key.
            </div>
            <div style={{ fontFamily: 'var(--font-serif)', fontSize: 32, lineHeight: 1.2, fontStyle: 'italic', fontWeight: 300, color: 'var(--human)', fontVariationSettings: '"opsz" 72' }}>
              The holder decides what may be read, and why.
            </div>
            <div style={{ fontFamily: 'var(--font-sans)', fontSize: 22, lineHeight: 1.5, marginTop: 12, color: 'var(--ink-soft)' }}>
              Clients request named records and fields. Every response stays inside the grant.
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, lineHeight: 1.6, marginTop: 12, color: 'var(--protocol)' }}>
              GET /v1/streams/pay_statements/records &nbsp;·&nbsp; grant_id=grt_longview01 &nbsp;·&nbsp; 200 OK
            </div>
          </div>

          {/* Numerals showcase — tabular figures for the ledger */}
          <div style={{ padding: '32px 0', borderBottom: '1px solid var(--rule)' }}>
            <div className="gutter">LEDGER · tabular figures · mono + serif</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 48, marginTop: 16 }}>
              <div className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 22, lineHeight: 1.5, color: 'var(--ink)' }}>
                <div>2025-10-14  09:22:07Z</div>
                <div>2025-10-28  09:22:07Z</div>
                <div>2025-11-11  09:22:07Z</div>
                <div style={{ color: 'var(--voided)' }}>2025-11-25  14:08:02Z  ✕</div>
              </div>
              <div className="num" style={{ fontFamily: 'var(--font-serif)', fontSize: 22, lineHeight: 1.5, color: 'var(--ink)', fontVariationSettings: '"opsz" 72, "tnum"', fontFeatureSettings: '"tnum"' }}>
                <div>$4,812.50 &nbsp; gross</div>
                <div>$3,622.18 &nbsp; net</div>
                <div>$1,190.32 &nbsp; withheld</div>
                <div style={{ color: 'var(--human)', fontStyle: 'italic' }}>— every fortnight</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
);

window.TheSpecimen = TheSpecimen;
