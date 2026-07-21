// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// StreamInventory — a list of declared streams with their shapes and access mode.

const STREAMS = [
  { id: 'pay_statements', title: 'Pay statements', mode: 'append only', fields: 6, recent: '2 days ago', granted: 3 },
  { id: 'employment',     title: 'Employment',     mode: 'mutable state', fields: 4, recent: '1 month ago', granted: 2 },
  { id: 'tax_docs',       title: 'Tax documents',  mode: 'append only', fields: 5, recent: '3 months ago', granted: 1 },
  { id: 'identity',       title: 'Identity',       mode: 'mutable state', fields: 3, recent: 'never', granted: 0 },
  { id: 'transactions',   title: 'Transactions',   mode: 'append only', fields: 8, recent: 'today', granted: 4 },
];

const StreamInventory = () => (
  <div className="pdpp-surface-neutral" style={{ overflow: 'hidden' }}>
    <div style={{ padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <div>
        <div className="pdpp-title">Streams</div>
        <div className="pdpp-caption" style={{ color: 'var(--muted-foreground)' }}>
          5 declared · 3 sharing with at least one grant
        </div>
      </div>
      <button className="pdpp-btn pdpp-btn-outline" style={{ height: 30, fontSize: 12 }}>+ Declare stream</button>
    </div>
    <div style={{
      display: 'grid', gridTemplateColumns: '1.6fr 1fr 0.7fr 1fr 0.6fr',
      padding: '8px 20px',
      borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)',
      fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)',
      letterSpacing: '0.05em', textTransform: 'uppercase',
    }}>
      <span>stream</span><span>mode</span><span>fields</span><span>last record</span><span style={{ textAlign: 'right' }}>grants</span>
    </div>
    {STREAMS.map((s, i) => (
      <div key={s.id} style={{
        display: 'grid', gridTemplateColumns: '1.6fr 1fr 0.7fr 1fr 0.6fr',
        padding: '12px 20px', alignItems: 'center',
        borderTop: i > 0 ? '1px solid var(--border)' : 'none',
      }}>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 500 }}>{s.title}</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--muted-foreground)' }}>{s.id}</div>
        </div>
        <span className={`pdpp-badge ${s.mode === 'append only' ? 'pdpp-badge-protocol' : 'pdpp-badge-neutral'}`}>{s.mode}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{s.fields}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--muted-foreground)' }}>{s.recent}</span>
        <span style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12.5, color: s.granted ? 'var(--foreground)' : 'var(--muted-foreground)' }}>
          {s.granted || '—'}
        </span>
      </div>
    ))}
  </div>
);

window.StreamInventory = StreamInventory;
