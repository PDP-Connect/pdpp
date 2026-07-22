// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GrantInspector — the protocol-temperature companion to ConsentCard.
// Shows a grant "as issued" in machine terms.

const GrantInspector = ({ grantId = 'grt_longview01' }) => (
  <div className="pdpp-surface-protocol" style={{ overflow: 'hidden', maxWidth: 640 }}>
    <div style={{ padding: '20px 24px 14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div className="pdpp-eyebrow" style={{ color: 'var(--primary)' }}>GRANT · ISSUED</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 500, marginTop: 6, letterSpacing: '-0.005em' }}>
            {grantId}
          </div>
        </div>
        <span className="pdpp-badge pdpp-badge-success"><span className="pdpp-dot"/>active</span>
      </div>
    </div>
    <hr className="pdpp-rule"/>
    <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 0 }}>
      {[
        ['purpose', <span style={{ color: 'var(--edu-fg)' }}>long_term_financial_planning</span>],
        ['mode', 'continuous'],
        ['scopes', <span>pay_statements.read · employment.read</span>],
        ['fields', 'employer, pay_period, gross_pay, net_pay'],
        ['time_range', 'last 2y 1mo'],
        ['issued', '2025-10-14T09:22:07Z'],
        ['expires', '2025-12-14T09:22:07Z'],
      ].map(([k, v], i) => (
        <React.Fragment key={k}>
          <div style={{
            padding: '9px 24px', borderTop: '1px solid var(--border)',
            fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--muted-foreground)',
          }}>{k}</div>
          <div style={{
            padding: '9px 24px 9px 0', borderTop: '1px solid var(--border)',
            fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--foreground)',
          }}>{v}</div>
        </React.Fragment>
      ))}
    </div>
    <hr className="pdpp-rule"/>
    <div style={{ padding: '12px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span className="pdpp-caption" style={{ color: 'var(--muted-foreground)' }}>
        The grant is the artifact. Collection is a companion mechanism.
      </span>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="pdpp-btn pdpp-btn-ghost" style={{ height: 30, fontSize: 12 }}>Copy JSON</button>
        <button className="pdpp-btn pdpp-btn-outline" style={{ height: 30, fontSize: 12 }}>Revoke ↺</button>
      </div>
    </div>
  </div>
);

window.GrantInspector = GrantInspector;
