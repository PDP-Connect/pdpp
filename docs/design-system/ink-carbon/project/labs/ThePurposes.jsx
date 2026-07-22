// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// ThePurposes — a typographic bestiary of purpose codes, each with its own voice.
// This is the brand's most opinionated page: purpose as a taxonomy of intent.

const ThePurposes = () => (
  <section style={{ padding: '96px 64px', borderBottom: '1px solid var(--rule)' }}>
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 64, alignItems: 'end', marginBottom: 48 }}>
        <div>
          <div className="gutter">§3 · PURPOSES</div>
          <h2 className="t-section" style={{ margin: '12px 0 0' }}>
            Every grant <em>states why</em>.
          </h2>
        </div>
        <p className="t-body" style={{ margin: 0 }}>
          A <span className="chip chip-protocol">purpose_code</span> is a machine-readable commitment. The spec ships five canonical purposes; implementations may extend them, but the shape — verb, object, scope — never changes.
        </p>
      </div>

      <PurposeTaxonomy />

      <div style={{ marginTop: 48, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 48, alignItems: 'start' }}>
        <SpecRow num="3.1" t="Purpose is declared, not enforced." tone="protocol">
          The protocol does not police downstream use — it records the commitment. Policing is the job of courts, auditors, and reputation markets. The record is what makes those possible.
        </SpecRow>
        <SpecRow num="3.2" t="A purpose cannot be silently broadened." tone="human">
          Changing a purpose on an existing grant requires re-consent. The old grant revokes, a new grant issues, the new purpose appears in its own signed artifact. Purposes do not drift.
        </SpecRow>
      </div>
    </div>
  </section>
);

window.ThePurposes = ThePurposes;
