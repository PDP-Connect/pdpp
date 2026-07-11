// Hero — the cross-quadrant layout from apps/web. Copper left rule on content column.

const Hero = () => (
  <section style={{ padding: '80px 48px 96px', maxWidth: 'var(--content-wide-width)', margin: '0 auto' }}>
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'var(--pdpp-sidebar-width) 1fr',
      gap: 48,
    }}>
      <div /> {/* empty quadrant aligned with sidebar */}
      <div style={{
        borderLeft: '2px solid var(--human)',
        paddingLeft: 32,
      }}>
        <div className="pdpp-eyebrow" style={{ marginBottom: 14 }}>PDPP · v0.1.0 draft</div>
        <h1 className="pdpp-display-lg" style={{ margin: 0, maxWidth: 880 }}>
          Granular access to <span style={{ color: 'var(--primary)' }}>personal data.</span>
        </h1>
        <p className="pdpp-body-lg" style={{
          margin: '20px 0 32px', maxWidth: 640, color: 'var(--muted-foreground)',
        }}>
          An open specification for how personal user data flows through the digital economy.
          Clients request named records and fields. Every response stays inside the grant.
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="pdpp-btn pdpp-btn-primary" style={{ height: 40, padding: '0 18px', fontSize: 14 }}>
            Read the spec
          </button>
          <button className="pdpp-btn pdpp-btn-outline" style={{ height: 40, padding: '0 16px', fontSize: 14 }}>
            View on GitHub ›
          </button>
          <span style={{ marginLeft: 12, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--muted-foreground)' }}>
            RFC status · draft 3
          </span>
        </div>
        <div style={{ marginTop: 56, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 32, borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }}>
          {[
            { k: 'GRANT', t: 'The portable artifact', b: 'A grant names resources, fields, purpose, duration, and mode.' },
            { k: 'STREAM', t: 'Named data shapes', b: 'Pay statements, employment, tax docs — declared, typed, versioned.' },
            { k: 'ENFORCE', t: 'Server-side boundary', b: 'Only the granted fields come back. Purpose is declared, not enforced.' },
          ].map((c, i) => (
            <div key={i} style={{ padding: '24px 0', borderRight: i < 2 ? '1px solid var(--border)' : 'none', paddingRight: i < 2 ? 32 : 0, minWidth: 0 }}>
              <div className="pdpp-eyebrow" style={{ color: 'var(--primary)' }}>{c.k}</div>
              <div className="pdpp-heading" style={{ marginTop: 6 }}>{c.t}</div>
              <p className="pdpp-body" style={{ margin: '6px 0 0', color: 'var(--muted-foreground)' }}>{c.b}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  </section>
);

window.Hero = Hero;
