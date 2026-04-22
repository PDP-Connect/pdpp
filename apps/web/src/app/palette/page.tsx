'use client';

// Warm tone sampler — shows each candidate in the actual context it would be used:
// 1. As a left border rule on the title block
// 2. As a background wash behind a human surface
// 3. Against the protocol blue (--primary) to test the duality

const CANDIDATES = [
  { name: 'Rose — soft',    description: 'Lower chroma, lighter. Refined.',         border: 'oklch(0.75 0.06 15)', wash: 'oklch(0.75 0.06 15 / 0.07)', swatch: 'oklch(0.75 0.06 15)' },
  { name: 'Rose',           description: 'Original. Explicit, human.',               border: 'oklch(0.72 0.08 20)', wash: 'oklch(0.72 0.08 20 / 0.07)', swatch: 'oklch(0.72 0.08 20)' },
  { name: 'Terracotta',     description: 'Rose toward orange. Earthier.',            border: 'oklch(0.65 0.10 35)', wash: 'oklch(0.65 0.10 35 / 0.07)', swatch: 'oklch(0.65 0.10 35)' },
  { name: 'Brick',          description: 'Deep muted rose. Serious.',                border: 'oklch(0.55 0.09 25)', wash: 'oklch(0.55 0.09 25 / 0.07)', swatch: 'oklch(0.55 0.09 25)' },
  { name: 'Copper — light', description: 'Brighter, more orange. Near amber.',       border: 'oklch(0.70 0.12 55)', wash: 'oklch(0.70 0.12 55 / 0.07)', swatch: 'oklch(0.70 0.12 55)' },
  { name: 'Copper',         description: 'Original. Warm but precise.',              border: 'oklch(0.62 0.10 50)', wash: 'oklch(0.62 0.10 50 / 0.07)', swatch: 'oklch(0.62 0.10 50)' },
  { name: 'Copper — deep',  description: 'Darker, richer. More bronze.',             border: 'oklch(0.52 0.09 45)', wash: 'oklch(0.52 0.09 45 / 0.07)', swatch: 'oklch(0.52 0.09 45)' },
  { name: 'Copper — red',   description: 'Red-copper. More oxide, aged.',            border: 'oklch(0.58 0.11 35)', wash: 'oklch(0.58 0.11 35 / 0.07)', swatch: 'oklch(0.58 0.11 35)' },
  { name: 'Vana Stone',     description: 'Earthy neutral. Already in Vana.',         border: 'oklch(0.60 0.04 80)', wash: 'oklch(0.60 0.04 80 / 0.07)', swatch: 'oklch(0.60 0.04 80)' },
];

const PROTOCOL_BLUE = 'oklch(0.580 0.172 253.7)';

export default function PalettePage() {
  return (
    <div style={{ backgroundColor: 'var(--background)', color: 'var(--foreground)', minHeight: '100vh', padding: '48px 64px', fontFamily: 'var(--font-sans)' }}>

      <div style={{ maxWidth: '900px' }}>
        <div style={{ marginBottom: '48px' }}>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '8px' }}>Warm tone candidates</h1>
          <p style={{ fontSize: '0.875rem', color: 'var(--muted-foreground)', maxWidth: '52ch', lineHeight: 1.6 }}>
            Each candidate shown in three contexts: as a left border rule, as a background wash, and paired with the protocol blue to test the human/protocol duality.
          </p>
        </div>

        {/* Test 1: 2px border on white — does it survive at actual pixel weight? */}
        <div style={{ marginBottom: '48px' }}>
          <div style={{ fontSize: '0.75rem', fontWeight: 600, marginBottom: '4px' }}>Test 1 — 2px border on white</div>
          <div style={{ fontSize: '0.8125rem', color: 'var(--muted-foreground)', marginBottom: '20px' }}>The hardest context. Most colors disappear or go muddy at 2px.</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            {CANDIDATES.map(({ name, border, swatch }) => (
              <div key={name} style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                <div style={{ width: '14px', height: '14px', borderRadius: '3px', backgroundColor: swatch, flexShrink: 0, boxShadow: 'inset 0 0 0 1px oklch(0 0 0 / 0.1)' }} />
                <div style={{ borderLeft: `2px solid ${border}`, paddingLeft: '14px', paddingTop: '10px', paddingBottom: '10px', flex: 1, backgroundColor: 'white' }}>
                  <span style={{ fontSize: '1.5rem', fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1 }}>Design System</span>
                </div>
                <span style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)', width: '120px', flexShrink: 0 }}>{name}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Test 2: Coexistence with #187adc — intentional contrast or accidental clash? */}
        <div style={{ marginBottom: '48px' }}>
          <div style={{ fontSize: '0.75rem', fontWeight: 600, marginBottom: '4px' }}>Test 2 — alongside protocol blue</div>
          <div style={{ fontSize: '0.8125rem', color: 'var(--muted-foreground)', marginBottom: '20px' }}>Human row (warm) above protocol row (blue). Do they read as intentionally different or accidentally clashing?</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {CANDIDATES.map(({ name, border, wash, swatch }) => (
              <div key={name} style={{ display: 'flex', alignItems: 'stretch', gap: '16px' }}>
                <div style={{ width: '14px', height: '14px', borderRadius: '3px', backgroundColor: swatch, flexShrink: 0, boxShadow: 'inset 0 0 0 1px oklch(0 0 0 / 0.1)', marginTop: '10px' }} />
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <div style={{ borderLeft: `2px solid ${border}`, paddingLeft: '12px', paddingTop: '8px', paddingBottom: '8px', background: `linear-gradient(to right, ${wash}, transparent 60%)` }}>
                    <div style={{ fontSize: '0.875rem', fontWeight: 500 }}>Alex Rivera</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)' }}>instagram.com/alex · owner</div>
                  </div>
                  <div style={{ borderLeft: `2px solid ${PROTOCOL_BLUE}`, paddingLeft: '12px', paddingTop: '8px', paddingBottom: '8px', background: `linear-gradient(to right, oklch(0.580 0.172 253.7 / 0.04), transparent 60%)` }}>
                    <div style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: 'var(--muted-foreground)' }}>grt_8f3a2b1c · single_use · §4.2</div>
                    <div style={{ fontSize: '0.6875rem', fontFamily: 'var(--font-mono)', color: 'var(--muted-foreground)', opacity: 0.6 }}>expires 24h · PDPP v0.1.0</div>
                  </div>
                </div>
                <span style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)', width: '120px', flexShrink: 0, paddingTop: '10px' }}>{name}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Test 3: Consent card — the most important surface */}
        <div>
          <div style={{ fontSize: '0.75rem', fontWeight: 600, marginBottom: '4px' }}>Test 3 — consent card</div>
          <div style={{ fontSize: '0.8125rem', color: 'var(--muted-foreground)', marginBottom: '20px' }}>The primary blue Allow button on a warm-washed card. Does it feel trustworthy or confused?</div>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            {CANDIDATES.map(({ name, border, wash, swatch }) => (
              <div key={name} style={{ width: '200px' }}>
                <div style={{ backgroundColor: wash, border: `1px solid ${border}`, borderRadius: '8px', padding: '16px', marginBottom: '6px' }}>
                  <div style={{ fontSize: '0.8125rem', fontWeight: 600, marginBottom: '2px' }}>Grant request</div>
                  <div style={{ fontSize: '0.625rem', fontFamily: 'var(--font-mono)', color: 'var(--muted-foreground)', marginBottom: '8px' }}>single_use · 24h</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)', marginBottom: '12px', lineHeight: 1.5 }}>Access to your Instagram social graph.</div>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button style={{ fontSize: '0.75rem', padding: '5px 12px', backgroundColor: PROTOCOL_BLUE, color: 'white', border: 'none', borderRadius: '4px', fontWeight: 500 }}>Allow</button>
                    <button style={{ fontSize: '0.75rem', padding: '5px 12px', backgroundColor: 'transparent', color: 'var(--muted-foreground)', border: '1px solid var(--border)', borderRadius: '4px' }}>Deny</button>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <div style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: swatch, flexShrink: 0 }} />
                  <span style={{ fontSize: '0.6875rem', color: 'var(--muted-foreground)' }}>{name}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ marginTop: '48px', paddingTop: '24px', borderTop: '1px solid var(--border)' }}>
          <p style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)', fontFamily: 'var(--font-mono)' }}>
            Protocol blue for reference: <span style={{ color: PROTOCOL_BLUE }}>oklch(0.580 0.172 253.7) · #187adc</span>
            {' '}&nbsp; Selected: <span style={{ color: 'oklch(0.52 0.09 45)' }}>Copper — deep → --human</span>
          </p>
        </div>
      </div>
    </div>
  );
}
