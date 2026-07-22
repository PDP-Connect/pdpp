// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// LivingGrant — the centerpiece. A grant as a breathing thermal object,
// with real records flowing through it in real time.

const { useState, useEffect, useRef } = React;

// A small deterministic fake record stream
const RECORD_STREAM = [
  { e: 'Acme Co', p: '2025-09-16→30', g: '$4,812.50', n: '$3,622.18' },
  { e: 'Acme Co', p: '2025-09-01→15', g: '$4,812.50', n: '$3,622.18' },
  { e: 'Acme Co', p: '2025-08-16→31', g: '$4,812.50', n: '$3,624.42' },
  { e: 'Acme Co', p: '2025-08-01→15', g: '$4,812.50', n: '$3,624.42' },
  { e: 'Acme Co', p: '2025-07-16→31', g: '$4,812.50', n: '$3,624.42' },
  { e: 'Acme Co', p: '2025-07-01→15', g: '$4,756.00', n: '$3,580.12' },
  { e: 'Acme Co', p: '2025-06-16→30', g: '$4,756.00', n: '$3,580.12' },
  { e: 'Acme Co', p: '2025-06-01→15', g: '$4,756.00', n: '$3,580.12' },
];

const LivingGrant = () => {
  const [cursor, setCursor] = useState(0);
  const [paused, setPaused] = useState(false);
  const [thermal, setThermal] = useState(0.62); // 0 = pure human, 1 = pure protocol

  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => setCursor(c => (c + 1) % RECORD_STREAM.length), 1800);
    return () => clearInterval(t);
  }, [paused]);

  const thermalColor = `color-mix(in oklch, var(--human) ${(1-thermal)*100}%, var(--protocol) ${thermal*100}%)`;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0, border: '1px solid var(--rule)', background: 'var(--paper)', position: 'relative', overflow: 'hidden' }}>
      {/* The thermal rule across the top */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: 'var(--thermal)', opacity: 0.8 }}/>

      {/* LEFT: Human side — the holder's view */}
      <div style={{ padding: '40px 36px', borderRight: '1px solid var(--rule)', position: 'relative', background: `linear-gradient(135deg, var(--human-wash), transparent 65%)` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span className="gutter" style={{ color: 'var(--human)' }}>§2 · HOLDER</span>
          <span className="gutter num">you</span>
        </div>
        <div className="t-section" style={{ marginTop: 18, maxWidth: 340 }}>
          <em>Longview</em> is reading your <span style={{ color: 'var(--human)' }}>pay statements</span>.
        </div>
        <div className="t-body" style={{ marginTop: 14, maxWidth: 360 }}>
          Every other Friday since <span className="num" style={{ color: 'var(--ink)' }}>Oct 14</span>. They see the employer, period, and gross and net pay. They cannot see your bank, address, or anything else.
        </div>
        <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {['pay_statements.read', 'employment.read'].map(s => (
            <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--live)', animation: 'pulse-dot 1.6s ease-in-out infinite' }}/>
              <span className="t-mono" style={{ color: 'var(--ink)' }}>{s}</span>
              <span className="t-mono" style={{ color: 'var(--ink-faint)', marginLeft: 'auto' }}>live</span>
            </div>
          ))}
          {['tax_docs.read', 'identity.read', 'transactions.read'].map(s => (
            <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 10, opacity: 0.35 }}>
              <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--ink-whisper)' }}/>
              <span className="t-mono" style={{ color: 'var(--ink-faint)' }}>{s}</span>
              <span className="t-mono" style={{ color: 'var(--ink-faint)', marginLeft: 'auto' }}>—</span>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 32, display: 'flex', gap: 10 }}>
          <button className="btn btn-paper" style={{ height: 36, fontSize: 13 }}>Revoke grant</button>
          <button className="btn btn-ghost" style={{ height: 36, fontSize: 13 }}>Adjust scope →</button>
        </div>
      </div>

      {/* RIGHT: Protocol side — the machine's view */}
      <div style={{ padding: '40px 36px', position: 'relative', background: `linear-gradient(225deg, var(--protocol-wash), transparent 65%)` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span className="gutter num">grt_longview01</span>
          <span className="gutter" style={{ color: 'var(--protocol)' }}>ISSUER · §5</span>
        </div>
        <div className="t-section" style={{ marginTop: 18, maxWidth: 340, textAlign: 'right', marginLeft: 'auto' }}>
          <em>Longview</em> holds a <span style={{ color: 'var(--protocol)' }}>grant</span>, not a key.
        </div>

        {/* The live stream pane */}
        <div style={{
          marginTop: 24, border: '1px solid var(--rule)', borderRadius: 2, overflow: 'hidden',
          background: 'var(--paper-warm)',
        }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr 0.8fr 0.8fr',
            padding: '6px 12px',
            background: 'var(--paper)',
            borderBottom: '1px solid var(--rule)',
          }}>
            {['employer', 'pay_period', 'gross', 'net'].map(h => (
              <span key={h} className="gutter" style={{ fontSize: 9.5 }}>{h}</span>
            ))}
          </div>
          <div style={{ height: 140, position: 'relative', overflow: 'hidden' }}>
            {RECORD_STREAM.map((r, i) => {
              const offset = (i - cursor + RECORD_STREAM.length) % RECORD_STREAM.length;
              const y = offset * 20 - 10;
              const opacity = offset === 0 ? 1 : offset < 4 ? 0.8 - offset * 0.15 : 0;
              return (
                <div key={i} style={{
                  position: 'absolute', top: y, left: 0, right: 0,
                  display: 'grid', gridTemplateColumns: '1fr 1fr 0.8fr 0.8fr',
                  padding: '2px 12px', opacity,
                  transition: 'top 400ms var(--ease-read), opacity 400ms',
                }}>
                  <span className="t-mono" style={{ color: 'var(--ink)', fontSize: 11.5 }}>{r.e}</span>
                  <span className="t-mono num" style={{ color: 'var(--ink-soft)', fontSize: 11.5 }}>{r.p}</span>
                  <span className="t-mono num" style={{ color: 'var(--ink-soft)', fontSize: 11.5 }}>{r.g}</span>
                  <span className="t-mono num" style={{ color: 'var(--ink)', fontSize: 11.5 }}>{r.n}</span>
                </div>
              );
            })}
            {/* Bottom fade */}
            <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 40, background: 'linear-gradient(transparent, var(--paper-warm))', pointerEvents: 'none' }}/>
          </div>
          <div style={{ padding: '6px 12px', borderTop: '1px solid var(--rule)', display: 'flex', justifyContent: 'space-between', background: 'var(--paper)' }}>
            <span className="gutter" style={{ fontSize: 9.5 }}>cursor: {String(cursor).padStart(3,'0')} / ∞</span>
            <button onClick={() => setPaused(p => !p)} className="gutter" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 9.5, color: 'var(--protocol)' }}>
              {paused ? '▸ resume' : '‖ pause'}
            </button>
          </div>
        </div>

        <div className="t-small" style={{ marginTop: 16 }}>
          The resource server drops any field not named in the grant. Purpose is declared, not enforced. Revocation is authoritative at the issuer.
        </div>
      </div>

      {/* The thermal slider across the bottom — the metaphor made interactive */}
      <div style={{ gridColumn: '1 / -1', padding: '20px 36px', borderTop: '1px solid var(--rule)', display: 'flex', alignItems: 'center', gap: 20, background: 'var(--paper-warm)' }}>
        <span className="gutter">thermal →</span>
        <div style={{ flex: 1, position: 'relative', height: 2, background: 'var(--thermal)', borderRadius: 999, cursor: 'pointer' }}
             onClick={(e) => {
               const rect = e.currentTarget.getBoundingClientRect();
               setThermal(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
             }}>
          <div style={{
            position: 'absolute', top: '50%', left: `${thermal * 100}%`,
            width: 14, height: 14, borderRadius: 999,
            background: thermalColor, transform: 'translate(-50%, -50%)',
            border: '2px solid var(--paper)', boxShadow: '0 0 0 1px ' + thermalColor,
          }}/>
        </div>
        <span className="gutter num" style={{ color: thermalColor, minWidth: 70, textAlign: 'right' }}>
          {thermal < 0.35 ? 'HOLDER' : thermal > 0.65 ? 'ISSUER' : 'BOUNDARY'} · {Math.round(thermal * 100)}°
        </span>
      </div>
    </div>
  );
};

window.LivingGrant = LivingGrant;
