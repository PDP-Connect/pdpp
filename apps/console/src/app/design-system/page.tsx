/**
 * /design-system — Ink Carbon component showcase.
 *
 * Renders every Ink Carbon component in the dark and light themes for
 * visual design review. This route is the foundation's visual test suite.
 *
 * The page renders two columns: dark (left) and light (right) by
 * applying [data-theme] directly on each panel. Each component section
 * matches its preview/*.html specimen from the spec.
 *
 * Access at: /design-system — a top-level ungated route (sibling of
 * /consent, /owner, /device), deliberately OUTSIDE /dashboard so it is
 * not caught by the connector-redirect catch-all nor the owner-session
 * DAL gate. (A folder name without a leading underscore is required —
 * App Router treats _-prefixed folders as private and excludes them
 * from routing, which is why /_design 404s.)
 */

import {
  Band,
  BandCell,
  Body,
  BodyLg,
  Caption,
  Carbon,
  Copyline,
  DataRow,
  DataRowDetail,
  DataRowMeta,
  DataRowWho,
  Display,
  DisplayMd,
  Endorse,
  Eyebrow,
  Heading,
  HumanSurface,
  IcButton,
  IcField,
  IcInput,
  KV,
  KVRow,
  Label,
  Monogram,
  ProtocolSurface,
  Scope,
  Sheet,
  SheetBody,
  SheetFoot,
  SheetHead,
  SheetSerial,
  SheetTitle,
  Table,
  TableCell,
  TableHeader,
  TableHeaderRow,
  TableRow,
  Tag,
  Title,
  Typed,
  TypedSm,
} from "@pdpp/brand-react";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Ink Carbon — Design showcase",
  robots: { index: false, follow: false },
};

// ─── Specimen panel ───────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: "2.5rem" }}>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.625rem",
          fontWeight: 500,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--muted-foreground)",
          marginBottom: "0.75rem",
          paddingBottom: "0.375rem",
          borderBottom: "1px solid var(--border)",
        }}
      >
        {title}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>{children}</div>
    </section>
  );
}

function ThemePanel({ theme, label }: { theme: "dark" | "light"; label: string }) {
  return (
    <div
      className={theme === "dark" ? "dark" : undefined}
      data-theme={theme}
      style={{
        flex: 1,
        minWidth: 0,
        background: "var(--background)",
        color: "var(--foreground)",
        padding: "2rem",
        fontFamily: "var(--font-sans)",
      }}
    >
      <div style={{ marginBottom: "2rem" }}>
        <Eyebrow>{label}</Eyebrow>
      </div>

      {/* ─── Type scale ─── */}
      <Section title="Type scale">
        <Display as="div">Display lg</Display>
        <DisplayMd as="div">Display md</DisplayMd>
        <Heading as="div">Heading</Heading>
        <Title as="div">Title / card header</Title>
        <BodyLg as="div">Body large — intro paragraph</BodyLg>
        <Body as="div">Body — standard body text</Body>
        <Label as="div">Label — UI label</Label>
        <Caption as="div">Caption — helper text</Caption>
        <Typed as="div">typed · protocol · voice · 2026-01-15</Typed>
        <TypedSm as="div">grant_abc123def456 · typed-sm</TypedSm>
        <Eyebrow>Eyebrow — section marker</Eyebrow>
      </Section>

      {/* ─── Endorsements (status badges) ─── */}
      <Section title="Endorsements — spent color">
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
          <Endorse status="active" />
          <Endorse status="continuous" />
          <Endorse status="expiring" />
          <Endorse status="revoked" />
          <Endorse status="denied" />
        </div>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
          <Endorse label="recorded" status="active" />
          <Endorse label="expires in 3 days" status="expiring" />
          <Endorse label="open-ended" status="continuous" />
        </div>
      </Section>

      {/* ─── Tags ─── */}
      <Section title="Tags — taxonomy labels">
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <Tag>statements</Tag>
          <Tag>transactions</Tag>
          <Tag>identity</Tag>
          <Tag>read-only</Tag>
          <Tag>v1.2.0</Tag>
        </div>
      </Section>

      {/* ─── Buttons ─── */}
      <Section title="Buttons">
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center" }}>
          <IcButton>Default</IcButton>
          <IcButton variant="human">Approve 3 streams</IcButton>
          <IcButton variant="ghost">Cancel</IcButton>
          <IcButton variant="destructive">Revoke</IcButton>
        </div>
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center" }}>
          <IcButton size="sm">Default sm</IcButton>
          <IcButton size="sm" variant="human">
            Approve
          </IcButton>
          <IcButton size="sm" variant="ghost">
            Keep
          </IcButton>
          <IcButton size="sm" variant="destructive">
            Revoke
          </IcButton>
          <IcButton disabled>Disabled</IcButton>
        </div>
      </Section>

      {/* ─── Inputs ─── */}
      <Section title="Inputs + Fields">
        <IcInput placeholder="grant_abc123def456" />
        <IcField hint="The OAuth client identifier issued at registration." htmlFor="client-id-demo" label="Client ID">
          <IcInput defaultValue="client_1a2b3c4d5e6f" id="client-id-demo" />
        </IcField>
        <IcField htmlFor="redirect-demo" label="Redirect URI">
          <IcInput id="redirect-demo" placeholder="https://app.example.com/callback" />
        </IcField>
      </Section>

      {/* ─── Sheet ─── */}
      <Section title="Sheet — paper artifact">
        <Sheet>
          <SheetHead>
            <SheetTitle>Acme Data Corp</SheetTitle>
            <SheetSerial>grant_abc123def456</SheetSerial>
          </SheetHead>
          <SheetBody>
            <KV>
              <KVRow k="status">
                <Endorse status="active" />
              </KVRow>
              <KVRow k="issued">2026-01-15T09:00:00Z</KVRow>
              <KVRow k="expires">2026-09-01T00:00:00Z</KVRow>
              <KVRow k="scopes">read:statements · read:transactions</KVRow>
            </KV>
          </SheetBody>
          <SheetFoot>
            <Copyline />
            <IcButton size="sm" variant="destructive">
              Revoke
            </IcButton>
          </SheetFoot>
        </Sheet>
      </Section>

      {/* ─── Carbon duplicate ─── */}
      <Section title="Carbon — server's retained copy (max 2/screen)">
        <Carbon>
          <Sheet>
            <SheetHead>
              <SheetTitle>Pending consent — Acme Data Corp</SheetTitle>
              <SheetSerial>req_pending_xyz</SheetSerial>
            </SheetHead>
            <SheetBody>
              <Scope
                description="Your financial statements and balances."
                name="read:statements"
                terms="read · 90 days"
              />
              <Scope description="Individual transaction records." name="read:transactions" terms="read · 90 days" />
              <Scope description="Your name and contact details." name="read:identity" off terms="read · session" />
            </SheetBody>
            <SheetFoot>
              <Copyline>Carbon pressed — your copy stays here</Copyline>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <IcButton size="sm" variant="ghost">
                  Refuse all
                </IcButton>
                <IcButton size="sm" variant="human">
                  Approve 2 streams
                </IcButton>
              </div>
            </SheetFoot>
          </Sheet>
        </Carbon>
      </Section>

      {/* ─── KV block ─── */}
      <Section title="KV — typed record block">
        <div style={{ maxWidth: 340 }}>
          <KV>
            <KVRow k="grant id">grant_abc123def456</KVRow>
            <KVRow k="client">Acme Data Corp</KVRow>
            <KVRow k="status">
              <Endorse status="active" />
            </KVRow>
            <KVRow k="issued">2026-01-15T09:00:00Z</KVRow>
            <KVRow k="expires">2026-09-01T00:00:00Z</KVRow>
            <KVRow k="projection">statements · transactions</KVRow>
          </KV>
        </div>
      </Section>

      {/* ─── Band ─── */}
      <Section title="Band — stat strip">
        <Band>
          <BandCell k="grants" v="14" />
          <BandCell k="streams" v="6" />
          <BandCell k="records" v="4,201" />
          <BandCell k="last run" v="4m ago" />
        </Band>
      </Section>

      {/* ─── Monogram ─── */}
      <Section title="Monogram — 2-letter client mark">
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <Monogram name="Acme Data Corp" />
          <Monogram name="First Bank" />
          <Monogram name="Chase" />
          <Monogram name="OpenAI" />
          <Monogram name="Meta Platforms" />
        </div>
      </Section>

      {/* ─── Data rows ─── */}
      <Section title="DataRow — grant list rows">
        <div
          className="pdpp-data-list"
          style={{ "--cols": "26px minmax(0,1.2fr) minmax(0,1.6fr) 110px 120px" } as React.CSSProperties}
        >
          <DataRow>
            <Monogram name="Acme Data Corp" />
            <DataRowWho id="grant_abc123" title="Acme Data Corp" />
            <DataRowDetail>statements · transactions</DataRowDetail>
            <span>
              <Endorse status="active" />
            </span>
            <DataRowMeta>2026-09-01</DataRowMeta>
          </DataRow>
          <DataRow>
            <Monogram name="First Bank" />
            <DataRowWho id="grant_def456" title="First Bank" />
            <DataRowDetail>identity · accounts</DataRowDetail>
            <span>
              <Endorse status="expiring" />
            </span>
            <DataRowMeta>2026-06-20</DataRowMeta>
          </DataRow>
          <DataRow revoked>
            <Monogram name="Old App" />
            <DataRowWho id="grant_xyz789" title="Old App" />
            <DataRowDetail>statements</DataRowDetail>
            <span>
              <Endorse status="revoked" />
            </span>
            <DataRowMeta>Revoked 2026-03-01</DataRowMeta>
          </DataRow>
        </div>
      </Section>

      {/* ─── Table ─── */}
      <Section title="Table — aligned list primitive">
        <Table cols="minmax(0,1.5fr) minmax(0,2fr) 100px 110px">
          <TableHeaderRow>
            <TableHeader>Client</TableHeader>
            <TableHeader>Scopes</TableHeader>
            <TableHeader>Status</TableHeader>
            <TableHeader numeric>Expires</TableHeader>
          </TableHeaderRow>
          <TableRow>
            <TableCell>Acme Data Corp</TableCell>
            <TableCell>statements · transactions</TableCell>
            <TableCell>
              <Endorse status="active" />
            </TableCell>
            <TableCell numeric>2026-09-01</TableCell>
          </TableRow>
          <TableRow>
            <TableCell>First Bank</TableCell>
            <TableCell>identity</TableCell>
            <TableCell>
              <Endorse status="expiring" />
            </TableCell>
            <TableCell numeric>2026-06-20</TableCell>
          </TableRow>
          <TableRow>
            <TableCell>Old App</TableCell>
            <TableCell>statements</TableCell>
            <TableCell>
              <Endorse status="revoked" />
            </TableCell>
            <TableCell numeric>—</TableCell>
          </TableRow>
        </Table>
      </Section>

      {/* ─── Scope rows ─── */}
      <Section title="Scope — consent scope rows">
        <Sheet>
          <SheetHead>
            <SheetTitle>Acme Data Corp requests</SheetTitle>
            <SheetSerial>req_xyz789</SheetSerial>
          </SheetHead>
          <div>
            <Scope
              description="Your monthly statements and running balances."
              name="read:statements"
              terms="read · 90 days"
            />
            <Scope description="Individual debit/credit records." name="read:transactions" terms="read · 90 days" />
            <Scope
              description="Your name and email for display purposes."
              name="read:identity"
              off
              terms="read · session"
            />
          </div>
        </Sheet>
      </Section>

      {/* ─── Surface wrappers ─── */}
      <Section title="Surfaces — temperature tints">
        <ProtocolSurface style={{ padding: "1rem" }}>
          <Typed>protocol surface — machine-authored content</Typed>
          <br />
          <TypedSm>IDs, projections, scopes, grant metadata</TypedSm>
        </ProtocolSurface>
        <HumanSurface style={{ padding: "1rem" }}>
          <Body as="span">human surface — owner-authored content</Body>
          <br />
          <Caption>Display names, consent text, human-readable descriptions</Caption>
        </HumanSurface>
      </Section>
    </div>
  );
}

export default function InkCarbonShowcase() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Page header */}
      <div
        style={{
          padding: "1.5rem 2rem",
          borderBottom: "1px solid var(--border-strong)",
          background: "var(--card)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
        <span className="pdpp-heading" style={{ fontFamily: "var(--font-sans)", fontSize: "1.25rem", fontWeight: 700 }}>
          Ink Carbon — Foundation showcase
        </span>
        <span
          className="pdpp-typed-sm"
          style={{ fontFamily: "var(--font-mono)", fontSize: "0.6875rem", color: "var(--muted-foreground)" }}
        >
          Phase 1 · /design-system
        </span>
      </div>

      {/* Two-column: dark | light */}
      <div style={{ display: "flex", flex: 1 }}>
        <ThemePanel label="Dark — operator console (primary)" theme="dark" />
        <div style={{ width: 1, background: "var(--border-strong)", flexShrink: 0 }} />
        <ThemePanel label="Light — paper mode" theme="light" />
      </div>
    </div>
  );
}
