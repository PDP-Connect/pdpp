// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The two additional hero moments — the overture and the manifesto

// ThermalField — an atmospheric opening. The thermal gradient as page-sized presence.
const ThermalField = () => (
  <section style={{
    position: 'relative',
    padding: '44px 64px 72px',
    borderBottom: '1px solid var(--rule)',
    overflow: 'hidden',
  }}>
    {/* The field itself — a painted atmosphere behind the type */}
    <div style={{
      position: 'absolute', inset: 0, pointerEvents: 'none',
      background: `
        radial-gradient(ellipse 900px 400px at 20% 30%, var(--human-wash), transparent 60%),
        radial-gradient(ellipse 1000px 500px at 85% 70%, var(--protocol-wash), transparent 60%)
      `,
    }}/>

    {/* Top bar — the masthead */}
    <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'relative', zIndex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <MarkP size={28} />
        <div>
          <div style={{ fontFamily: 'var(--font-serif)', fontSize: 17, letterSpacing: '-0.015em', lineHeight: 1 }}>
            Personal Data Portability Protocol
          </div>
          <div className="gutter" style={{ marginTop: 3 }}>v0.1.0 · draft 3 · 2026-04-19</div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <a href="#" className="gutter" style={{ color: 'var(--ink-soft)', textDecoration: 'none' }}>spec</a>
        <a href="#" className="gutter" style={{ color: 'var(--ink-soft)', textDecoration: 'none' }}>reference</a>
        <a href="#" className="gutter" style={{ color: 'var(--ink-soft)', textDecoration: 'none' }}>errata</a>
        <span style={{ width: 1, height: 14, background: 'var(--rule-deep)', margin: '0 4px' }}/>
        <NightToggle />
      </div>
    </header>

    {/* The thesis block — masthead markers flank the display line, no stretched void */}
    <div style={{
      display: 'grid', gridTemplateColumns: '180px 1fr 180px',
      alignItems: 'center', gap: 40, position: 'relative', zIndex: 1,
      marginTop: 72,
    }}>
      <div style={{ borderLeft: '2px solid var(--human)', paddingLeft: 16 }}>
        <div className="gutter" style={{ color: 'var(--human)' }}>HOLDER</div>
        <div className="t-mono" style={{ marginTop: 6, color: 'var(--ink)' }}>you</div>
        <div className="t-small" style={{ marginTop: 2, fontStyle: 'italic', fontFamily: 'var(--font-serif)' }}>your data, your terms</div>
      </div>

      <h1 className="t-display" style={{ margin: 0, textAlign: 'center' }}>
        The grant is the <em>artifact,</em><br/>
        not the <span style={{ color: 'var(--protocol)' }}>key</span>.
      </h1>

      <div style={{ borderRight: '2px solid var(--protocol)', paddingRight: 16, textAlign: 'right' }}>
        <div className="gutter" style={{ color: 'var(--protocol)' }}>ISSUER</div>
        <div className="t-mono" style={{ marginTop: 6, color: 'var(--ink)' }}>the server</div>
        <div className="t-small" style={{ marginTop: 2, fontStyle: 'italic', fontFamily: 'var(--font-serif)' }}>boundary, not barrier</div>
      </div>
    </div>

    {/* A thermal rule — the painted horizon */}
    <div style={{ marginTop: 56, height: 1, background: 'var(--thermal)', opacity: 0.5, position: 'relative', zIndex: 1 }}/>

    {/* Bottom — the lede and affordances */}
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'end', gap: 48, marginTop: 40, position: 'relative', zIndex: 1 }}>
      <p className="t-lede" style={{ margin: 0, maxWidth: 620 }}>
        An open specification for how personal user data flows through the digital economy
        under <span style={{ color: 'var(--ink)' }}>authorization-first, purpose-bound</span> access.
        Clients request named records and fields. Every response stays inside the grant.
      </p>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button className="btn btn-ink">Read the spec →</button>
        <button className="btn btn-paper">Reference implementation</button>
      </div>
    </div>
  </section>
);

window.ThermalField = ThermalField;
