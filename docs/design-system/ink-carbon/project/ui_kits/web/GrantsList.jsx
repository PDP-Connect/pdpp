// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GrantsList — the owner's dashboard of active grants.

const GRANTS = [
  { id: 'grt_longview01', client: 'Longview Planning', monogram: 'LV', purpose: 'long_term_financial_planning', status: 'active', scopes: ['pay_statements.read', 'employment.read'], issued: 'Oct 14, 2025', expires: 'Dec 14, 2025' },
  { id: 'grt_acme_kyc_02', client: 'Acme KYC',         monogram: 'AK', purpose: 'identity_verification',         status: 'active', scopes: ['identity.read'],                           issued: 'Nov 02, 2025', expires: 'Nov 03, 2025' },
  { id: 'grt_forecast_17', client: 'Forecast Mortgage',monogram: 'FM', purpose: 'underwriting_review',            status: 'expiring', scopes: ['pay_statements.read', 'tax_docs.read', 'employment.read'], issued: 'Sep 28, 2025', expires: 'in 2 days' },
  { id: 'grt_oldmedical',  client: 'Old Medical LLC',   monogram: 'OM', purpose: 'insurance_claim',               status: 'revoked', scopes: ['identity.read'],                           issued: 'Aug 05, 2025', expires: '—' },
];

const STATUS_CLASS = { active: 'pdpp-badge-success', expiring: 'pdpp-badge-warning', revoked: 'pdpp-badge-destructive' };

const GrantsList = ({ onOpen }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
      <div>
        <div className="pdpp-heading">Your grants</div>
        <div className="pdpp-caption" style={{ color: 'var(--muted-foreground)' }}>
          4 grants · 2 active · 1 expiring · 1 revoked
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="pdpp-btn pdpp-btn-ghost" style={{ height: 30, fontSize: 12 }}>Filter</button>
        <button className="pdpp-btn pdpp-btn-outline" style={{ height: 30, fontSize: 12 }}>Export</button>
      </div>
    </div>
    {GRANTS.map(g => (
      <div key={g.id}
        onClick={() => onOpen && onOpen(g)}
        className={g.status === 'revoked' ? 'pdpp-surface-neutral' : 'pdpp-surface-protocol'}
        style={{ padding: '14px 16px', cursor: 'pointer', opacity: g.status === 'revoked' ? 0.65 : 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
            <div style={{
              width: 32, height: 32, borderRadius: 6,
              background: g.status === 'revoked' ? 'var(--muted)' : 'oklch(0.52 0.09 45 / 0.14)',
              color: g.status === 'revoked' ? 'var(--muted-foreground)' : 'var(--human)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, flexShrink: 0,
            }}>{g.monogram}</div>
            <div style={{ minWidth: 0 }}>
              <div className="pdpp-title">{g.client}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--edu-fg)' }}>// {g.purpose}</div>
            </div>
          </div>
          <span className={`pdpp-badge ${STATUS_CLASS[g.status]}`}><span className="pdpp-dot"/>{g.status}</span>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
          {g.scopes.map(sc => <span key={sc} className="pdpp-chip" style={{ fontSize: 11, padding: '1px 8px' }}>{sc}</span>)}
        </div>
        <div style={{ display: 'flex', gap: 18, marginTop: 10, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted-foreground)' }}>
          <span>{g.id}</span>
          <span>issued {g.issued}</span>
          <span>expires {g.expires}</span>
        </div>
      </div>
    ))}
  </div>
);

window.GrantsList = GrantsList;
