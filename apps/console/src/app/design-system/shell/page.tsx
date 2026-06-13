/**
 * /design-system/shell — Ink Carbon SHELL + RecordBody showcase.
 *
 * Visual verification for the redesigned-console SPINE:
 *   - RecordroomShell (sidebar + grouped nav + sticky header + mobile drawer)
 *     rendered live at the top, so the frame, active state, theme toggle, and
 *     ⌘K affordance can be exercised in the browser.
 *   - A grid of RecordBody specimens (money, attachment/image, long text,
 *     generic) rendered in BOTH themes side by side, plus Rhythm and CopyMono.
 *
 * Sibling of /design-system — a top-level ungated route, deliberately OUTSIDE
 * /dashboard so the connector-redirect catch-all and the owner-session DAL gate
 * do not apply.
 */
import type { Metadata } from "next";
import {
  CopyMono,
  Eyebrow,
  RecordBody,
  RecordroomShell,
  Rhythm,
  Sheet,
  SheetBody,
  SheetHead,
  SheetSerial,
  SheetTitle,
} from "@/components/ink-carbon/index.ts";

export const metadata: Metadata = {
  title: "Ink Carbon — Shell + record showcase",
  robots: { index: false, follow: false },
};

// ─── Sample records (real `{ data, stream, declaredTypes }` shape) ─

const SAMPLES: Array<{
  data: Record<string, unknown>;
  declaredTypes?: Record<string, string>;
  label: string;
  stream: string;
}> = [
  {
    label: "money — declared currency hero",
    stream: "current_activity",
    declaredTypes: { amount: "currency" },
    data: {
      amount: -4215,
      merchant: "Blue Bottle Coffee",
      category: "Dining",
      date: "2026-06-09",
      account_ref: "chk_••4021",
    },
  },
  {
    label: "attachment — derived image (heuristic)",
    stream: "attachments",
    data: {
      filename: "receipt-2026-06.png",
      // A field whose value LOOKS like an image URL — derived, never declared.
      preview: "https://placehold.co/600x240/png",
      content_type: "image/png",
      bytes: 184_320,
    },
  },
  {
    label: "agent — long-text reading region",
    stream: "messages",
    data: {
      role: "assistant",
      model: "claude-opus-4-8",
      content:
        "Here is the summary you asked for. The reading region kicks in once a body/content field crosses the length threshold, so long machine output reads as prose rather than a cramped table cell. Short content stays a normal row.",
      turns: 4,
    },
  },
  {
    label: "generic — dual-key field list + null token",
    stream: "employment",
    data: {
      employer: "Northstar HR",
      title: "Staff Engineer",
      start_date: "2021-03-01",
      end_date: null,
      manager_contact: "",
    },
  },
];

function ThemePanel({ theme, label }: { label: string; theme: "dark" | "light" }) {
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
      <div style={{ marginBottom: "1.5rem" }}>
        <Eyebrow>{label}</Eyebrow>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
        {SAMPLES.map((s) => (
          <div key={s.label}>
            <div style={{ marginBottom: "0.5rem" }}>
              <Eyebrow>{s.label}</Eyebrow>
            </div>
            <Sheet>
              <SheetHead>
                <SheetTitle>{s.stream}</SheetTitle>
                <SheetSerial>rec_{s.stream}</SheetSerial>
              </SheetHead>
              <SheetBody>
                <RecordBody data={s.data} declaredTypes={s.declaredTypes} stream={s.stream} />
              </SheetBody>
            </Sheet>
          </div>
        ))}

        {/* Rhythm sparkline */}
        <div>
          <div style={{ marginBottom: "0.5rem" }}>
            <Eyebrow>Rhythm — run history</Eyebrow>
          </div>
          <div style={{ display: "flex", gap: "1.5rem", alignItems: "center" }}>
            <Rhythm ticks={["ok", "ok", "ok", "ok", "ok"]} />
            <Rhythm ticks={["ok", "ok", "fail", "ok", "ok"]} />
            <Rhythm ticks={["fail", "fail", "ok"]} />
          </div>
        </div>

        {/* CopyMono */}
        <div>
          <div style={{ marginBottom: "0.5rem" }}>
            <Eyebrow>CopyMono — click-to-copy id</Eyebrow>
          </div>
          <CopyMono text="grant_abc123def456" />
        </div>
      </div>
    </div>
  );
}

export default function ShellShowcase() {
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {/* ─── Live shell — full frame with grouped nav + chrome ─── */}
      <div
        className="dark"
        data-theme="dark"
        style={{ height: "70vh", borderBottom: "2px solid var(--border-strong)" }}
      >
        <RecordroomShell build="pdpp 0.1.0" host="rs.owner.example.net">
          <div style={{ maxWidth: 760 }}>
            <h1 style={{ fontSize: 21, fontWeight: 800, letterSpacing: "-0.02em", margin: "0 0 4px" }}>Shell frame</h1>
            <p
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--muted-foreground)",
                margin: "0 0 24px",
              }}
            >
              grouped nav · active state via pathname · theme toggle flips &lt;html&gt; · ⌘K jump · mobile drawer
            </p>
            <Sheet>
              <SheetHead>
                <SheetTitle>current_activity</SheetTitle>
                <SheetSerial>rec_current_activity</SheetSerial>
              </SheetHead>
              <SheetBody>
                <RecordBody
                  data={SAMPLES[0]?.data ?? {}}
                  declaredTypes={SAMPLES[0]?.declaredTypes}
                  stream={SAMPLES[0]?.stream ?? "current_activity"}
                />
              </SheetBody>
            </Sheet>
          </div>
        </RecordroomShell>
      </div>

      {/* ─── Two-column record specimens: dark | light ─── */}
      <div style={{ display: "flex", flex: 1 }}>
        <ThemePanel label="Dark — operator console (primary)" theme="dark" />
        <div style={{ width: 1, background: "var(--border-strong)", flexShrink: 0 }} />
        <ThemePanel label="Light — paper mode" theme="light" />
      </div>
    </div>
  );
}
