"use client";

import React, { useEffect, useState } from "react";
import {
  Callout,
  Section as DashboardSectionPrimitive,
  DataList,
  FilterSummary,
  MetaPill,
  PageHeader,
  Pager,
  SplitLayout,
  StatusBadge,
  Toolbar,
} from "@/app/dashboard/components/primitives.tsx";
import { Hero } from "@/components/Hero.tsx";
import { PdppLogo } from "@/components/PdppLogo.tsx";
import type {
  ConnectorCardProps,
  ConsentCardProps,
  GrantInspectorProps,
  SpecCitationProps,
  StreamInventoryProps,
} from "@/components/pdpp/index.ts";
import {
  ConnectorCard,
  ConsentCard,
  GrantInspector,
  SpecCitationGroup,
  StreamInventory,
} from "@/components/pdpp/index.ts";
import { SiteHeader } from "@/components/SiteHeader.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { LONGVIEW_CLIENT_URI, LONGVIEW_POLICY_URI, LONGVIEW_TOS_URI } from "@/lib/longview-world.ts";

// ─── Nav ──────────────────────────────────────────────────────────────────────

const NAV_SECTIONS = [
  { id: "brand", label: "Brand" },
  { id: "color", label: "Color" },
  { id: "typography", label: "Typography" },
  { id: "spacing", label: "Spacing" },
  { id: "elevation", label: "Elevation" },
  { id: "motion", label: "Motion" },
  { id: "surfaces", label: "Surfaces" },
  { id: "components", label: "Components" },
  { id: "dashboard", label: "Dashboard" },
  { id: "examples", label: "Examples" },
  { id: "docs", label: "Docs" },
  { id: "status", label: "Status" },
  { id: "rules", label: "Rules" },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DesignSystemPage() {
  const [active, setActive] = useState("brand");

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setActive(e.target.id);
          }
        }
      },
      { rootMargin: "-10% 0px -75% 0px", threshold: 0 }
    );
    NAV_SECTIONS.forEach(({ id }) => {
      const el = document.getElementById(id);
      if (el) {
        observer.observe(el);
      }
    });
    return () => observer.disconnect();
  }, []);

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="min-h-screen" style={{ backgroundColor: "var(--background)", color: "var(--foreground)" }}>
      {/* ── Top nav ── */}
      <header
        className="sticky top-0 z-40 flex h-12 items-center gap-3 px-5 md:px-6"
        style={{
          backgroundColor: "var(--background)",
          backdropFilter: "blur(8px)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <SiteHeader currentLabel="Design System" />
        <div className="flex-1" />
        <span className="font-mono text-xs" style={{ color: "var(--muted-foreground)", opacity: 0.5 }}>
          v0.1.0
        </span>
      </header>

      {/* ── Mobile nav ── */}
      <MobileNav active={active} scrollTo={scrollTo} />

      <Hero
        layout="cross"
        gradient="warm"
        title="Design System"
        description="Tokens, type, motion, and specimen patterns for the PDPP reference surfaces."
        actions={
          <div className="flex flex-wrap gap-1.5">
            {["Tailwind v4", "shadcn base-nova", "Base UI", "Geist", "JetBrains Mono"].map((t) => (
              <span
                key={t}
                className="rounded px-2 py-0.5 font-mono text-[10px]"
                style={{
                  color: "var(--muted-foreground)",
                  border: "1px solid var(--border)",
                  backgroundColor: "var(--muted)",
                }}
              >
                {t}
              </span>
            ))}
          </div>
        }
      />

      {/* ── Bottom row: nav bottom-left + content bottom-right ── */}
      <div className="flex w-full min-w-0">
        {/* Bottom-left quadrant — sticky nav */}
        <aside
          className="sticky top-12 hidden h-[calc(100vh-3rem)] shrink-0 flex-col overflow-y-auto md:flex"
          style={{ width: "var(--pdpp-sidebar-width)", borderRight: "1px solid var(--border)" }}
        >
          <div className="px-3 py-6">
            <div
              className="mb-1 px-2 font-semibold text-xs"
              style={{ color: "var(--muted-foreground)", letterSpacing: "0.06em" }}
            >
              Foundations
            </div>
            <nav className="flex flex-col gap-0.5">
              {NAV_SECTIONS.map(({ id, label }) => (
                <button
                  key={id}
                  onClick={() => scrollTo(id)}
                  className="cursor-pointer rounded-md px-2 py-0.5 text-left transition-colors"
                  style={{
                    fontSize: "0.8125rem",
                    color: active === id ? "var(--foreground)" : "var(--muted-foreground)",
                    fontWeight: active === id ? 500 : 400,
                    backgroundColor: active === id ? "var(--muted)" : "transparent",
                  }}
                >
                  {label}
                </button>
              ))}
            </nav>
          </div>
        </aside>

        {/* Main content */}
        <main className="min-w-0 flex-1">
          <div className="flex flex-col">
            <BrandSection />
            <ColorSection />
            <TypographySection />
            <SpacingSection />
            <ElevationSection />
            <MotionSection />
            <SurfacesSection />
            <ComponentsSection />
            <DashboardPrimitivesSection />
            <ExampleWorldsSection />
            <DocsSection />
            <StatusSection />
            <RulesSection />
          </div>

          <div className="px-6 py-8 md:px-12" style={{ borderTop: "1px solid var(--border)" }}>
            <span className="font-mono text-xs" style={{ color: "var(--muted-foreground)", opacity: 0.5 }}>
              PDPP Design System · globals.css + CONSTITUTION.md
            </span>
          </div>
        </main>
      </div>
    </div>
  );
}

// Mobile nav — shown below md
function MobileNav({ active, scrollTo }: { active: string; scrollTo: (id: string) => void }) {
  return (
    <div
      className="sticky top-12 z-30 flex w-full items-center gap-0 overflow-x-auto px-2 md:hidden"
      style={{
        borderBottom: "1px solid var(--border)",
        backgroundColor: "var(--background)",
        backdropFilter: "blur(8px)",
        scrollbarWidth: "none",
      }}
    >
      {NAV_SECTIONS.map(({ id, label }) => (
        <button
          key={id}
          onClick={() => scrollTo(id)}
          className="shrink-0 px-3.5 py-3 font-medium text-sm transition-colors"
          style={{
            color: active === id ? "var(--foreground)" : "var(--muted-foreground)",
            borderBottom: active === id ? "2px solid var(--foreground)" : "2px solid transparent",
            marginBottom: "-1px",
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// ─── Shared primitives ────────────────────────────────────────────────────────

function SectionWrap({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <section
      id={id}
      className="scroll-mt-[96px] px-5 py-10 md:scroll-mt-11 md:px-12 md:py-14"
      style={{ maxWidth: "860px", borderTop: "1px solid var(--border)" }}
    >
      {children}
    </section>
  );
}

function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-10 flex flex-col gap-2">
      <h2 className="font-semibold leading-none tracking-tight" style={{ fontSize: "1.5rem" }}>
        {title}
      </h2>
      {description && (
        <p
          className="mt-1 text-sm leading-relaxed md:text-sm"
          style={{ color: "var(--muted-foreground)", maxWidth: "56ch", fontSize: "clamp(0.875rem, 2.5vw, 0.9375rem)" }}
        >
          {description}
        </p>
      )}
    </div>
  );
}

function SubLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mb-4 overflow-hidden text-ellipsis whitespace-nowrap font-mono font-semibold text-[9px] uppercase tracking-widest"
      style={{ color: "var(--muted-foreground)" }}
    >
      {children}
    </div>
  );
}

function RuleBlock({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4 py-3 pl-4" style={{ borderLeft: "2px solid var(--border)" }}>
      <span className="text-sm leading-relaxed" style={{ color: "var(--muted-foreground)" }}>
        {children}
      </span>
    </div>
  );
}

// Swatch — flat square with a very subtle border
function SwatchDot({ token }: { token: string }) {
  return (
    <div
      className="h-6 w-6 shrink-0 rounded"
      style={{
        background: `var(${token})`,
        boxShadow: "inset 0 0 0 1px oklch(0 0 0 / 0.10)",
        outline: "1px solid oklch(0.88 0 0)",
        outlineOffset: "1px",
      }}
    />
  );
}

// ─── 00 Brand ─────────────────────────────────────────────────────────────────
// Reproduces the plates from the handoff bundle (identity/logo_study.html).
// The split-P mark, wordmark lockups, abstract variants, and size ramp.

function BrandSection() {
  return (
    <SectionWrap id="brand">
      <SectionHeader
        title="Brand"
        description="The mark is a P split on the thermal axis — copper (holder) on the left, blue (issuer) on the right — with a circular counter that reads as the grant itself. At favicon sizes it reduces to two rectangles."
      />

      {/* ── Plate I: Primary mark ─────────────────────────────────────────── */}
      <SubLabel>Primary mark · the seam</SubLabel>
      <div className="mb-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        <MarkPlate surface="light" caption="I.1 — the seam, positive" meta="primary · light surface" />
        <MarkPlate surface="dark" caption="I.2 — the seam, night" meta="primary · dark surface" />
      </div>

      {/* Construction + rules */}
      <div
        className="mb-10 grid grid-cols-1 gap-6 p-5 md:grid-cols-[220px_1fr_1fr]"
        style={{ border: "1px solid var(--border)", background: "var(--muted)" }}
      >
        <ConstructionDiagram />
        <div>
          <SubLabel>Idea</SubLabel>
          <p className="text-sm leading-relaxed" style={{ color: "var(--muted-foreground)" }}>
            The uppercase P holds two shapes: a bowl that opens toward a person, and a descending stem that roots it in
            a server. The thermal seam runs vertically through the counter, splitting the letter into its two halves
            without dividing its silhouette.
          </p>
          <p className="mt-2.5 text-sm leading-relaxed" style={{ color: "var(--foreground)" }}>
            The mark is whole from a distance. The seam rewards a closer look.
          </p>
        </div>
        <div>
          <SubLabel>Rules</SubLabel>
          <ol className="space-y-1.5 pl-4 text-sm leading-relaxed" style={{ color: "var(--muted-foreground)" }}>
            <li>
              The counter is always{" "}
              <span className="font-mono text-xs" style={{ color: "var(--foreground)" }}>
                r = 9% × mark width
              </span>
              .
            </li>
            <li>The seam never moves off the optical vertical.</li>
            <li>
              Warm side is <em style={{ color: "var(--human)" }}>holder</em>, cool side is{" "}
              <em style={{ color: "var(--primary)" }}>issuer</em>.
            </li>
            <li>Never outline the mark. The wordmark hangs left of the P; never stack it below.</li>
          </ol>
        </div>
      </div>

      {/* ── Plate II: Wordmark lockups ──────────────────────────────────── */}
      <SubLabel>Wordmark lockups</SubLabel>
      <div className="mb-10 grid grid-cols-1 gap-3 md:grid-cols-2">
        <BrandPlate caption="II.1 — primary lockup" meta="mark + wordmark">
          <div className="flex flex-col items-start gap-2">
            <div className="flex items-center gap-3">
              <PdppLogo variant="mark" size={44} title="" />
              <span
                className="font-semibold tracking-tight"
                style={{ fontSize: "32px", letterSpacing: "-0.02em", color: "var(--foreground)" }}
              >
                PDPP
              </span>
            </div>
            <span
              className="font-mono text-[10px] uppercase tracking-widest"
              style={{ color: "var(--muted-foreground)" }}
            >
              personal data portability protocol
            </span>
          </div>
        </BrandPlate>
        <BrandPlate caption="II.2 — technical lockup" meta="mono · ruled · versioned">
          <div
            className="inline-flex items-center gap-3 py-2"
            style={{ borderTop: "1px solid var(--foreground)", borderBottom: "1px solid var(--foreground)" }}
          >
            <PdppLogo variant="mark" size={44} title="" />
            <span
              className="font-mono"
              style={{ fontSize: "22px", letterSpacing: "-0.02em", fontWeight: 500, color: "var(--foreground)" }}
            >
              PDPP <span style={{ color: "var(--muted-foreground)", fontWeight: 400 }}>v0.1</span>
            </span>
          </div>
        </BrandPlate>
      </div>

      {/* ── Plate IV: Responsive size ramp ──────────────────────────────── */}
      <SubLabel>Size ramp · 140 → 16 px</SubLabel>
      <BrandPlate caption="IV — the full ramp" meta="140 · 96 · 64 · 44 · 28 · 20 · 16 px">
        <div className="flex flex-wrap items-end gap-8 py-2">
          {[140, 96, 64, 44, 28, 22, 20, 16].map((s) => (
            <PdppLogo key={s} variant="mark" size={s} title="" />
          ))}
        </div>
      </BrandPlate>
      <p className="mt-3 mb-10 text-sm leading-relaxed" style={{ color: "var(--muted-foreground)", maxWidth: "60ch" }}>
        At 20px and below, the counter collapses — the P silhouette becomes illegible, so the mark reduces to its
        irreducible idea: two rectangles, one warm, one cool. The thermal duality survives everything else being
        stripped away.
      </p>

      {/* ── Plate V: In context ─────────────────────────────────────────── */}
      <SubLabel>In context</SubLabel>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <BrandPlate caption="V.1 — browser tab + header" meta="14 + 28px">
          <div className="w-full max-w-xs">
            <div
              className="flex items-center gap-2 rounded-md px-2.5 py-1.5"
              style={{ border: "1px solid var(--border)", background: "var(--card)" }}
            >
              <PdppLogo variant="mark" size={14} title="" />
              <span className="font-mono text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                pdpp.vana.org — the grant is the artifact
              </span>
            </div>
            <div className="mt-4 flex items-center gap-2">
              <PdppLogo variant="mark" size={22} title="" />
              <span
                className="font-semibold tracking-tight"
                style={{ fontSize: 18, letterSpacing: "-0.015em", color: "var(--foreground)" }}
              >
                PDPP
              </span>
            </div>
            <div className="mt-2 text-xs" style={{ color: "var(--muted-foreground)" }}>
              Personal Data Portability Protocol · v0.1.0 draft 3
            </div>
          </div>
        </BrandPlate>
        <BrandPlate caption="V.2 — card, night" meta="ink substrate · 32px mark" darkStage>
          <div
            className="flex w-full max-w-[260px] flex-col justify-between p-5"
            style={{ background: "oklch(0.16 0.01 60)", color: "oklch(0.985 0.005 85)", minHeight: 150 }}
          >
            <PdppLogo variant="mark" size={32} surface="dark" title="" />
            <div>
              <div className="font-semibold tracking-tight" style={{ fontSize: 16, letterSpacing: "-0.015em" }}>
                Ada Verhoeven
              </div>
              <div className="mt-0.5 font-mono text-[10px]" style={{ color: "oklch(0.7 0.01 60)" }}>
                ada@pdpp.vana.org · editor, working group
              </div>
            </div>
          </div>
        </BrandPlate>
      </div>

      <RuleBlock>
        Plate I is the canonical mark. The wordmark pairs the mark with &ldquo;PDPP&rdquo; in Geist (the system sans);
        don&rsquo;t typeset it in serif, italic, or all lowercase. Below 20&thinsp;px the mark reduces to the
        two-rectangle favicon form automatically &mdash; don&rsquo;t force the full P at favicon sizes.
      </RuleBlock>
    </SectionWrap>
  );
}

function MarkPlate({ surface, caption, meta }: { surface: "light" | "dark"; caption: string; meta: string }) {
  const isDark = surface === "dark";
  return (
    <div
      className="grid grid-rows-[1fr_auto]"
      style={{
        border: `1px solid ${isDark ? "oklch(0.16 0.01 60)" : "var(--border)"}`,
        background: isDark ? "oklch(0.16 0.01 60)" : "var(--card)",
        color: isDark ? "oklch(0.985 0.005 85)" : "var(--foreground)",
        minHeight: 300,
      }}
    >
      <div className="flex items-center justify-center p-12">
        <PdppLogo variant="mark" size={180} surface={surface} />
      </div>
      <div
        className="flex items-baseline justify-between px-5 py-3 font-mono text-[11px]"
        style={{ borderTop: `1px solid ${isDark ? "oklch(0.28 0.012 255)" : "var(--border)"}` }}
      >
        <span style={{ color: isDark ? "oklch(0.985 0.005 85)" : "var(--foreground)" }}>{caption}</span>
        <span style={{ color: isDark ? "oklch(0.7 0.01 60)" : "var(--muted-foreground)" }}>{meta}</span>
      </div>
    </div>
  );
}

function BrandPlate({
  caption,
  meta,
  children,
  darkStage = false,
}: {
  caption: string;
  meta: string;
  children: React.ReactNode;
  darkStage?: boolean;
}) {
  return (
    <div
      className="grid grid-rows-[1fr_auto]"
      style={{ border: "1px solid var(--border)", background: "var(--card)", minHeight: 220 }}
    >
      <div
        className="flex items-center justify-center p-10"
        style={darkStage ? { background: "var(--muted)" } : undefined}
      >
        {children}
      </div>
      <div
        className="flex items-baseline justify-between px-5 py-3 font-mono text-[11px]"
        style={{ borderTop: "1px solid var(--border)" }}
      >
        <span style={{ color: "var(--foreground)" }}>{caption}</span>
        <span style={{ color: "var(--muted-foreground)" }}>{meta}</span>
      </div>
    </div>
  );
}

function ConstructionDiagram() {
  return (
    <svg
      viewBox="0 0 200 200"
      width="200"
      height="200"
      style={{ background: "var(--card)", border: "1px solid var(--border)", maxWidth: "100%" }}
    >
      {/* 5-unit grid */}
      <g stroke="oklch(0.92 0.01 60)" strokeWidth="0.5">
        <line x1="0" y1="30" x2="200" y2="30" />
        <line x1="0" y1="73" x2="200" y2="73" />
        <line x1="0" y1="116" x2="200" y2="116" />
        <line x1="0" y1="170" x2="200" y2="170" />
        <line x1="40" y1="0" x2="40" y2="200" />
        <line x1="105" y1="0" x2="105" y2="200" />
        <line x1="155" y1="0" x2="155" y2="200" />
      </g>
      {/* Faint mark outline */}
      <g opacity="0.3" fill="none" stroke="var(--foreground)" strokeWidth="0.6">
        <path d="M 40 30 L 40 170 L 60 170 L 60 116 L 105 116 L 105 30 Z" />
        <path d="M 105 30 L 105 116 L 60 116 L 60 170 L 80 170 L 80 136 L 125 136 Q 155 136 155 103 Q 155 30 105 30 Z" />
        <circle cx="105" cy="73" r="18" />
      </g>
      {/* Thermal seam */}
      <defs>
        <linearGradient id="pdpp-construction-thermal" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="oklch(0.52 0.11 45)" />
          <stop offset="1" stopColor="oklch(0.58 0.18 253)" />
        </linearGradient>
      </defs>
      <line x1="105" y1="30" x2="105" y2="116" stroke="url(#pdpp-construction-thermal)" strokeWidth="1.5" />
      {/* Construction points */}
      <g fill="var(--foreground)">
        <circle cx="40" cy="30" r="1.5" />
        <circle cx="105" cy="30" r="1.5" />
        <circle cx="155" cy="30" r="1.5" />
        <circle cx="40" cy="170" r="1.5" />
        <circle cx="105" cy="73" r="1.5" />
      </g>
      <text x="4" y="196" fontFamily="var(--font-mono)" fontSize="7" fill="var(--muted-foreground)">
        construction · 5-unit grid · counter r=18
      </text>
    </svg>
  );
}

// ─── 01 Color ─────────────────────────────────────────────────────────────────

const COLOR_GROUPS = [
  {
    label: "Surfaces",
    tokens: [
      {
        token: "--background",
        value: "oklch(0.99 0.002 95)",
        label: "Page background",
        usage: "Root page, panel backgrounds",
      },
      { token: "--card", value: "oklch(1 0 0)", label: "Card surface", usage: "Cards, elevated panels" },
      { token: "--muted", value: "oklch(0.96 0 0)", label: "Muted fill", usage: "Input backgrounds, secondary rows" },
      { token: "--popover", value: "oklch(1 0 0)", label: "Floating surface", usage: "Dropdowns, tooltips, popovers" },
    ],
  },
  {
    label: "Text",
    tokens: [
      { token: "--foreground", value: "oklch(0.13 0 0)", label: "Primary text", usage: "Body copy, headings, labels" },
      {
        token: "--muted-foreground",
        value: "oklch(0.50 0 0)",
        label: "Secondary text",
        usage: "Captions, helper text, placeholders",
      },
      {
        token: "--primary-foreground",
        value: "oklch(0.99 0 0)",
        label: "On-primary text",
        usage: "Text on primary-colored backgrounds",
      },
    ],
  },
  {
    label: "Interactive",
    tokens: [
      {
        token: "--primary",
        value: "oklch(0.580 0.172 253.7)",
        label: "Signature blue (#187adc)",
        usage: "CTAs, links, focus rings, progress",
      },
      { token: "--secondary", value: "oklch(0.96 0 0)", label: "Secondary action", usage: "Secondary buttons, chips" },
      {
        token: "--destructive",
        value: "oklch(0.55 0.20 27)",
        label: "Destructive",
        usage: "Delete actions, error states",
      },
    ],
  },
  {
    label: "Borders",
    tokens: [
      {
        token: "--border",
        value: "oklch(0.94 0 0)",
        label: "Default border",
        usage: "Cards, dividers, all structural borders",
      },
      {
        token: "--input",
        value: "oklch(0.91 0 0)",
        label: "Input border",
        usage: "Form field borders at rest — higher contrast for accessibility",
      },
      { token: "--ring", value: "oklch(0.580 0.172 253.7)", label: "Focus ring", usage: "Keyboard focus indicator" },
    ],
  },
  {
    label: "Status",
    tokens: [
      { token: "--success", value: "oklch(0.52 0.15 150)", label: "Success", usage: "Granted, confirmed, synced" },
      { token: "--warning", value: "oklch(0.62 0.15 70)", label: "Warning", usage: "Pending, caution states" },
      {
        token: "--edu-fg",
        value: "oklch(0.55 0.08 270)",
        label: "Spec citation (§)",
        usage: "Protocol spec references only",
      },
    ],
  },
  {
    label: "Surface Temperature",
    tokens: [
      {
        token: "--human",
        value: "oklch(0.52 0.09 45)",
        label: "Human — copper-deep",
        usage: "Identity, ownership, consent surfaces",
      },
      {
        token: "--human-wash",
        value: "oklch(0.52 0.09 45 / 0.07)",
        label: "Human wash",
        usage: "Warm background tint on human surfaces",
      },
    ],
  },
];

function ColorSection() {
  return (
    <SectionWrap id="color">
      <SectionHeader
        title="Color"
        description="All color values live in :root as CSS custom properties. Semantic tokens only — never raw Tailwind palette classes."
      />

      {/* Signature color — in-situ specimens */}
      <div className="mb-12">
        <SubLabel>Signature color — --primary · #187adc · oklch(0.580 0.172 253.7)</SubLabel>
        <div
          className="grid grid-cols-2 overflow-hidden rounded-lg md:grid-cols-4"
          style={{ border: "1px solid var(--border)" }}
        >
          {/* CTA button */}
          <div
            className="flex flex-col items-start justify-between gap-8 p-6"
            style={{ backgroundColor: "var(--background)", borderRight: "1px solid var(--border)" }}
          >
            <button
              className="rounded px-3.5 py-1.5 font-medium text-sm"
              style={{ backgroundColor: "var(--primary)", color: "var(--primary-foreground)" }}
            >
              Allow access
            </button>
            <span
              className="font-mono text-[9px] uppercase tracking-widest"
              style={{ color: "var(--muted-foreground)", opacity: 0.6 }}
            >
              CTA button
            </span>
          </div>
          {/* Link */}
          <div
            className="flex flex-col items-start justify-between gap-8 p-6"
            style={{ backgroundColor: "var(--background)", borderRight: "1px solid var(--border)" }}
          >
            <span
              className="text-sm"
              style={{ color: "var(--primary)", textDecoration: "underline", textUnderlineOffset: "3px" }}
            >
              Read the spec →
            </span>
            <span
              className="font-mono text-[9px] uppercase tracking-widest"
              style={{ color: "var(--muted-foreground)", opacity: 0.6 }}
            >
              Link
            </span>
          </div>
          {/* Focus ring */}
          <div
            className="flex flex-col items-start justify-between gap-8 p-6"
            style={{ backgroundColor: "var(--background)", borderRight: "1px solid var(--border)" }}
          >
            <input
              readOnly
              className="rounded px-3 py-1.5 text-xs"
              style={{
                border: "1px solid var(--border)",
                outline: "2px solid var(--ring)",
                outlineOffset: "2px",
                backgroundColor: "var(--background)",
                width: "80%",
              }}
              value="focused input"
            />
            <span
              className="font-mono text-[9px] uppercase tracking-widest"
              style={{ color: "var(--muted-foreground)", opacity: 0.6 }}
            >
              Focus ring
            </span>
          </div>
          {/* Progress */}
          <div
            className="flex flex-col items-start justify-between gap-8 p-6"
            style={{ backgroundColor: "var(--background)" }}
          >
            <div className="h-1 w-full overflow-hidden rounded-full" style={{ backgroundColor: "var(--muted)" }}>
              <div className="h-full w-3/5 rounded-full" style={{ backgroundColor: "var(--primary)" }} />
            </div>
            <span
              className="font-mono text-[9px] uppercase tracking-widest"
              style={{ color: "var(--muted-foreground)", opacity: 0.6 }}
            >
              Progress bar
            </span>
          </div>
        </div>
      </div>

      {/* Token table */}
      <div className="w-full overflow-x-auto" style={{ borderTop: "1px solid var(--border)" }}>
        <table className="w-full text-sm" style={{ tableLayout: "fixed", minWidth: "480px" }}>
          <colgroup>
            <col style={{ width: "40px" }} />
            <col style={{ width: "180px" }} />
            <col style={{ width: "150px" }} />
            <col className="hidden md:table-column" style={{ width: "190px" }} />
            <col className="hidden md:table-column" />
          </colgroup>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              {["", "Token", "Semantic label", "OKLCH value", "Usage"].map((h, i) => (
                <th
                  key={h}
                  className={`py-3 pr-6 text-left text-xs font-medium${i >= 3 ? "hidden md:table-cell" : ""}`}
                  style={{ color: "var(--muted-foreground)" }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {COLOR_GROUPS.map(({ label, tokens }, gi) => (
              <React.Fragment key={label}>
                <tr style={{ borderTop: gi > 0 ? "1px solid var(--border)" : undefined }}>
                  <td colSpan={5} className="pt-6 pb-1.5">
                    <span
                      className="font-mono font-semibold text-[9px] uppercase tracking-widest"
                      style={{ color: "var(--muted-foreground)", opacity: 0.55 }}
                    >
                      {label}
                    </span>
                  </td>
                </tr>
                {tokens.map(({ token, value, label: l, usage }) => (
                  <tr key={token}>
                    <td className="py-2.5 pr-4 align-middle">
                      <SwatchDot token={token} />
                    </td>
                    <td className="py-2.5 pr-4 align-middle">
                      <code className="font-mono text-xs">{token}</code>
                    </td>
                    <td className="py-2.5 pr-4 align-middle">
                      <span className="text-xs" style={{ color: "var(--muted-foreground)" }}>
                        {l}
                      </span>
                    </td>
                    <td className="hidden py-2.5 pr-4 align-middle md:table-cell">
                      <code className="font-mono text-[11px] tabular-nums" style={{ color: "var(--muted-foreground)" }}>
                        {value}
                      </code>
                    </td>
                    <td className="hidden py-2.5 pr-4 align-middle md:table-cell">
                      <span className="text-xs" style={{ color: "var(--muted-foreground)" }}>
                        {usage}
                      </span>
                    </td>
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-10">
        <RuleBlock>
          Never use raw Tailwind palette colors (<code className="font-mono text-xs">bg-green-500</code>,{" "}
          <code className="font-mono text-xs">text-blue-600</code>). Never hardcode hex values inline. If a semantic
          token doesn't exist for your use case, add it to :root and this page first.
        </RuleBlock>
      </div>
    </SectionWrap>
  );
}

// ─── 02 Typography ────────────────────────────────────────────────────────────

function TypographySection() {
  return (
    <SectionWrap id="typography">
      <SectionHeader
        title="Typography"
        description="Two typefaces. Geist for human-readable copy. JetBrains Mono for everything the protocol produces."
      />

      <div className="flex flex-col gap-14">
        {/* Geist Sans */}
        <div>
          <SubLabel>Geist Sans — interface copy</SubLabel>
          <div className="overflow-x-auto">
            <table className="w-full" style={{ borderCollapse: "collapse", tableLayout: "auto", minWidth: "300px" }}>
              <colgroup>
                <col style={{ width: "64px" }} />
                <col />
                <col style={{ width: "64px" }} />
                <col className="hidden md:table-column" style={{ width: "160px" }} />
              </colgroup>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {["Role", "Specimen", "Spec", "Usage"].map((h, i) => (
                    <th
                      key={h}
                      className={`pb-2 text-left text-xs font-medium${i === 3 ? "hidden md:table-cell" : ""}`}
                      style={{ color: "var(--muted-foreground)" }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  {
                    className: "pdpp-display-lg",
                    label: "display-lg",
                    spec: "60/600/-0.03em",
                    sample: "Personal Data",
                    usage: "Splash heroes — the landing page only",
                  },
                  {
                    className: "pdpp-display",
                    label: "display",
                    spec: "40/600/-0.025em",
                    sample: "Design System",
                    usage: "Page heroes — docs, design system",
                  },
                  {
                    className: "pdpp-heading",
                    label: "heading",
                    spec: "20/600/-0.01em",
                    sample: "Grant request",
                    usage: "Section headers",
                  },
                  {
                    className: "pdpp-title",
                    label: "title",
                    spec: "14/600",
                    sample: "Longview",
                    usage: "Card titles, entity names",
                  },
                  {
                    className: "pdpp-body-lg",
                    label: "body-lg",
                    spec: "18/400",
                    sample: "An authorization and disclosure protocol.",
                    usage: "Hero lead copy",
                  },
                  {
                    className: "pdpp-body",
                    label: "body",
                    spec: "14/400",
                    sample: "Comparing salary, equity, benefits, and tax tradeoffs.",
                    usage: "Descriptions, prose",
                  },
                  {
                    className: "pdpp-label",
                    label: "label",
                    spec: "12/500",
                    sample: "What they can access",
                    usage: "Field labels, section labels",
                  },
                  {
                    className: "pdpp-caption",
                    label: "caption",
                    spec: "12/400",
                    sample: "No live scraping required.",
                    usage: "Helper text, footnotes",
                  },
                ].map(({ className, label, spec, sample, usage }) => (
                  <tr key={label}>
                    <td className="py-3 pr-4" style={{ verticalAlign: "baseline" }}>
                      <span className="pdpp-caption font-mono" style={{ color: "var(--muted-foreground)" }}>
                        .{className}
                      </span>
                    </td>
                    <td className="py-3 pr-4" style={{ verticalAlign: "baseline", overflow: "hidden", maxWidth: 0 }}>
                      <span
                        className={className}
                        style={{
                          display: "block",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          lineHeight: 1,
                        }}
                      >
                        {sample}
                      </span>
                    </td>
                    <td className="py-3 pr-4" style={{ verticalAlign: "baseline" }}>
                      <span className="font-mono text-[11px] tabular-nums" style={{ color: "var(--muted-foreground)" }}>
                        {spec}
                      </span>
                    </td>
                    <td className="hidden py-3 md:table-cell" style={{ verticalAlign: "baseline" }}>
                      <span className="pdpp-caption" style={{ color: "var(--muted-foreground)", opacity: 0.7 }}>
                        {usage}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Dual access — class vs utility */}
        <div>
          <SubLabel>Dual access — class vs Tailwind utility</SubLabel>
          <p className="pdpp-caption mb-6 max-w-[56ch] text-muted-foreground">
            Every Geist step is reachable two ways. Use the <code className="font-mono">.pdpp-*</code> class when you
            want the full semantic bundle (family + size + weight + line-height + letter-spacing). Use the{" "}
            <code className="font-mono">text-pdpp-*</code> Tailwind utility when you need the size step alone — e.g.
            paired with <code className="font-mono">font-mono</code>, or inside a responsive variant like{" "}
            <code className="font-mono">md:text-pdpp-heading</code>. Both resolve to the same CSS custom property;
            rendering is pixel-identical.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full" style={{ borderCollapse: "collapse" }}>
              <colgroup>
                <col style={{ width: "120px" }} />
                <col />
                <col />
                <col className="hidden md:table-column" style={{ width: "80px" }} />
              </colgroup>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {["Step", "Class form", "Utility form", "Spec"].map((h, i) => (
                    <th
                      key={h}
                      className={`pb-2 text-left text-xs font-medium${i === 3 ? "hidden md:table-cell" : ""}`}
                      style={{ color: "var(--muted-foreground)" }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  {
                    step: "heading",
                    utility: "text-pdpp-heading font-semibold tracking-[-0.01em]",
                    className: "pdpp-heading",
                    sample: "Grant request",
                    spec: "20/600",
                  },
                  {
                    step: "title",
                    utility: "text-pdpp-title font-semibold",
                    className: "pdpp-title",
                    sample: "Longview",
                    spec: "14/600",
                  },
                  {
                    step: "body-lg",
                    utility: "text-pdpp-body-lg",
                    className: "pdpp-body-lg",
                    sample: "An authorization and disclosure protocol.",
                    spec: "18/400",
                  },
                  {
                    step: "body",
                    utility: "text-pdpp-body",
                    className: "pdpp-body",
                    sample: "Comparing salary, equity, benefits, and tax tradeoffs.",
                    spec: "14/400",
                  },
                  {
                    step: "label",
                    utility: "text-pdpp-label font-medium",
                    className: "pdpp-label",
                    sample: "What they can access",
                    spec: "12/500",
                  },
                  {
                    step: "caption",
                    utility: "text-pdpp-caption",
                    className: "pdpp-caption",
                    sample: "Helper copy.",
                    spec: "12/400",
                  },
                ].map(({ step, className, utility, sample, spec }) => (
                  <tr key={step}>
                    <td className="py-3 pr-4" style={{ verticalAlign: "baseline" }}>
                      <span className="font-mono text-xs" style={{ color: "var(--muted-foreground)" }}>
                        {step}
                      </span>
                    </td>
                    <td className="py-3 pr-4" style={{ verticalAlign: "baseline", overflow: "hidden", maxWidth: 0 }}>
                      <span
                        className={className}
                        style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      >
                        {sample}
                      </span>
                      <span
                        className="mt-0.5 font-mono text-[10px]"
                        style={{ color: "var(--muted-foreground)", opacity: 0.6, display: "block" }}
                      >
                        .{className}
                      </span>
                    </td>
                    <td className="py-3 pr-4" style={{ verticalAlign: "baseline", overflow: "hidden", maxWidth: 0 }}>
                      <span
                        className={utility}
                        style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      >
                        {sample}
                      </span>
                      <span
                        className="mt-0.5 font-mono text-[10px]"
                        style={{ color: "var(--muted-foreground)", opacity: 0.6, display: "block" }}
                      >
                        {utility}
                      </span>
                    </td>
                    <td className="hidden py-3 md:table-cell" style={{ verticalAlign: "baseline" }}>
                      <span className="font-mono text-xs tabular-nums" style={{ color: "var(--muted-foreground)" }}>
                        {spec}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="pdpp-caption mt-6 max-w-[56ch] text-muted-foreground/80">
            <span className="font-medium text-foreground">Eyebrow</span> is intentionally class-only — its identity{" "}
            <em>is</em> the mono family + uppercase + <code className="font-mono">0.12em</code> tracking bundle. A
            utility alias for the size alone would invite misuse. Reach for{" "}
            <code className="font-mono">.pdpp-eyebrow</code> directly, or compose from{" "}
            <code className="font-mono">font-mono uppercase tracking-pdpp-eyebrow</code> when you need to vary the size.
          </p>
        </div>

        {/* JetBrains Mono */}
        <div>
          <SubLabel>JetBrains Mono — protocol data</SubLabel>
          <div
            className="grid gap-0 pb-2"
            style={{
              gridTemplateColumns: "72px 1fr",
              borderBottom: "1px solid var(--border)",
            }}
          >
            {["Role", "Specimen"].map((h) => (
              <span key={h} className="font-medium text-xs" style={{ color: "var(--muted-foreground)" }}>
                {h}
              </span>
            ))}
          </div>
          {[
            {
              label: "id",
              sample: "grt_8f3a2b1c4d5e6f7a8b9c0d1e2f3a4b5c",
              usage: "Grant IDs, resource identifiers",
              color: "var(--foreground)",
            },
            {
              label: "code",
              sample: "pay_statements · summary · continuous",
              usage: "Stream names, field names, enum values",
              color: "var(--foreground)",
            },
            {
              label: "spec-ref",
              sample: "§4.2 Selection Request · §6.1 Stream Metadata",
              usage: "Protocol spec citations only",
              color: "var(--edu-fg)",
            },
          ].map(({ label, sample, color }) => (
            <div
              key={label}
              className="grid items-baseline gap-0 py-3"
              style={{
                gridTemplateColumns: "72px 1fr",
                borderBottom: "1px solid color-mix(in oklch, var(--border) 50%, transparent)",
              }}
            >
              <span className="pt-px text-xs" style={{ color: "var(--muted-foreground)" }}>
                {label}
              </span>
              <span className="break-all font-mono text-[13px]" style={{ color }}>
                {sample}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-10">
        <RuleBlock>
          Mono signals "this came from the protocol, not a human." All IDs, stream names, field names, enum values,
          timestamps, and spec citations are mono. No arbitrary font sizes.
        </RuleBlock>
      </div>
    </SectionWrap>
  );
}

// ─── 03 Spacing ───────────────────────────────────────────────────────────────

function SpacingSection() {
  const steps = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24];
  return (
    <SectionWrap id="spacing">
      <SectionHeader title="Spacing" description="Standard Tailwind 4px base grid throughout. No arbitrary values." />

      <div className="mb-10 flex flex-wrap items-end gap-4 py-6">
        {steps.map((n) => (
          <div key={n} className="flex flex-col items-center gap-2">
            <div
              className="rounded-sm"
              style={{
                width: `${n * 4}px`,
                height: `${n * 4}px`,
                backgroundColor: "color-mix(in oklch, var(--primary) 18%, transparent)",
                border: "1px solid color-mix(in oklch, var(--primary) 30%, transparent)",
              }}
            />
            <div
              className="text-center font-mono text-[9px] leading-tight"
              style={{ color: "var(--muted-foreground)" }}
            >
              {n}
              <br />
              {n * 4}px
            </div>
          </div>
        ))}
      </div>

      <div className="overflow-x-auto" style={{ borderTop: "1px solid var(--border)" }}>
        <table className="w-full" style={{ borderCollapse: "collapse", tableLayout: "fixed", minWidth: "360px" }}>
          <colgroup>
            <col style={{ width: "160px" }} />
            <col style={{ width: "110px" }} />
            <col />
          </colgroup>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              {["Pattern", "Value", "Usage"].map((h, i) => (
                <th
                  key={h}
                  className={`pt-3 pr-6 pb-2 text-left text-xs font-medium${i === 2 ? "hidden md:table-cell" : ""}`}
                  style={{ color: "var(--muted-foreground)" }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[
              { pattern: "px-4 py-2", value: "16px 8px", usage: "Panel headers, toolbar rows" },
              { pattern: "p-4 / p-5", value: "16px / 20px", usage: "Card content, form sections" },
              { pattern: "gap-2 / gap-3", value: "8px / 12px", usage: "Tight list items, inline groups" },
              { pattern: "gap-6 / gap-8", value: "24px / 32px", usage: "Section-level spacing" },
              { pattern: "px-6 py-8", value: "24px 32px", usage: "Stage / centered empty states" },
            ].map(({ pattern, value, usage }) => (
              <tr key={pattern}>
                <td className="py-3 pr-6" style={{ verticalAlign: "baseline" }}>
                  <code className="font-mono text-xs">{pattern}</code>
                </td>
                <td className="py-3 pr-6" style={{ verticalAlign: "baseline" }}>
                  <span className="font-mono text-[11px] tabular-nums" style={{ color: "var(--muted-foreground)" }}>
                    {value}
                  </span>
                </td>
                <td className="hidden py-3 md:table-cell" style={{ verticalAlign: "baseline" }}>
                  <span className="text-xs" style={{ color: "var(--muted-foreground)" }}>
                    {usage}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-10">
        <RuleBlock>
          No arbitrary spacing values. If the Tailwind scale doesn't have it, question the design decision before
          introducing a custom value.
        </RuleBlock>
      </div>
    </SectionWrap>
  );
}

// ─── 04 Elevation ─────────────────────────────────────────────────────────────

const ELEVATION_LEVELS = [
  { level: 0, label: "Flat", shadow: "none", desc: "Page surface, rows, default panels" },
  {
    level: 1,
    label: "Raised",
    shadow: "0 1px 2px rgba(0,0,0,0.04), 0 1px 3px rgba(0,0,0,0.02)",
    desc: "Cards, form fields",
  },
  {
    level: 2,
    label: "Float",
    shadow: "0 4px 6px rgba(0,0,0,0.04), 0 10px 15px rgba(0,0,0,0.08)",
    desc: "Dropdowns, command palette",
  },
  {
    level: 3,
    label: "Modal",
    shadow: "0 10px 15px rgba(0,0,0,0.05), 0 20px 25px rgba(0,0,0,0.10), 0 0 0 1px rgba(0,0,0,0.05)",
    desc: "Modals, overlays",
  },
];

function ElevationSection() {
  return (
    <SectionWrap id="elevation">
      <SectionHeader
        title="Elevation"
        description="Depth hierarchy through shadow and border. Four levels — most UI lives at 0 or 1."
      />

      <div className="mb-12 grid grid-cols-2 gap-5 md:grid-cols-4">
        {ELEVATION_LEVELS.map(({ level, label, shadow, desc }) => (
          <div key={level} className="flex flex-col gap-3">
            <div
              className="flex h-24 items-start rounded-lg p-3"
              style={{
                backgroundColor: "var(--card)",
                border: "1px solid var(--border)",
                boxShadow: shadow,
              }}
            >
              <span
                className="font-medium font-mono text-xs leading-none"
                style={{ color: "var(--muted-foreground)", opacity: 0.4 }}
              >
                {level}
              </span>
            </div>
            <div>
              <div className="font-medium text-sm">{label}</div>
              <div className="mt-0.5 text-xs leading-snug" style={{ color: "var(--muted-foreground)" }}>
                {desc}
              </div>
            </div>
          </div>
        ))}
      </div>

      <RuleBlock>
        Most UI in this app is flat (level 0) with border differentiation. Reach for shadow only when a surface
        genuinely floats above its context.
      </RuleBlock>
    </SectionWrap>
  );
}

// ─── 05 Motion ────────────────────────────────────────────────────────────────

function MotionSection() {
  return (
    <SectionWrap id="motion">
      <SectionHeader
        title="Motion"
        description="Productive by default. Every animation must answer: does this help the user understand what just happened? If not, it doesn't animate."
      />

      <div className="flex flex-col gap-12">
        <div>
          <SubLabel>Duration tiers</SubLabel>
          <DurationDemo />
        </div>

        <div>
          <SubLabel>Easing curves</SubLabel>
          <EasingDemo />
        </div>

        <div>
          <SubLabel>Semantic aliases</SubLabel>
          <div style={{ borderTop: "1px solid var(--border)" }}>
            {[
              { token: "--motion-enter", composes: "300ms ease-enter", usage: "Modals, drawers, toasts arriving" },
              {
                token: "--motion-exit",
                composes: "100ms ease-exit",
                usage: "Any element leaving — exits are faster than enters",
              },
              {
                token: "--motion-state",
                composes: "200ms ease-standard",
                usage: "Button hover, checkbox, toggle, tab switch",
              },
              {
                token: "--motion-feedback",
                composes: "100ms ease-spring",
                usage: "Success flash, error indication, confirm action",
              },
            ].map(({ token, composes, usage }) => (
              <div
                key={token}
                className="flex flex-col gap-1 py-3 md:flex-row md:items-center md:gap-6"
                style={{ borderBottom: "1px solid var(--border)" }}
              >
                <code className="font-mono text-xs md:w-44 md:shrink-0">{token}</code>
                <span
                  className="font-mono text-[11px] tabular-nums md:w-40 md:shrink-0"
                  style={{ color: "var(--muted-foreground)" }}
                >
                  {composes}
                </span>
                <span className="hidden text-xs md:block md:flex-1" style={{ color: "var(--muted-foreground)" }}>
                  {usage}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div>
          <SubLabel>Stagger — choreographed list entry</SubLabel>
          <StaggerDemo />
        </div>

        <div>
          <SubLabel>Skeleton shimmer — loading state</SubLabel>
          <SkeletonDemo />
        </div>

        <div>
          <SubLabel>Reduced motion</SubLabel>
          <pre
            className="overflow-auto rounded-lg border p-5 font-mono text-xs leading-relaxed"
            style={{
              borderColor: "var(--border)",
              backgroundColor: "var(--muted)",
              color: "var(--muted-foreground)",
            }}
          >{`@media (prefers-reduced-motion: reduce) {
  :root {
    --duration-fast:     0.01ms;
    --duration-base:     0.01ms;
    --duration-moderate: 0.01ms;
    --duration-slow:     0.01ms;
  }
}`}</pre>
          <p className="mt-3 text-sm" style={{ color: "var(--muted-foreground)" }}>
            One rule at <code className="font-mono text-xs">:root</code> covers the entire system. No per-component
            overrides needed.
          </p>
        </div>
      </div>

      <div className="mt-10">
        <RuleBlock>
          Only animate <code className="font-mono text-xs">transform</code> and{" "}
          <code className="font-mono text-xs">opacity</code> — GPU-composited properties only. Never animate{" "}
          <code className="font-mono text-xs">width</code>, <code className="font-mono text-xs">height</code>, or layout
          properties. Productive motion is the default; expressive motion is earned for meaningful moments.
        </RuleBlock>
      </div>
    </SectionWrap>
  );
}

function DurationDemo() {
  const [playing, setPlaying] = useState<string | null>(null);
  const tiers = [
    { name: "fast", ms: 100, cssVar: "--duration-fast" },
    { name: "base", ms: 200, cssVar: "--duration-base" },
    { name: "moderate", ms: 300, cssVar: "--duration-moderate" },
    { name: "slow", ms: 500, cssVar: "--duration-slow" },
  ];

  const play = (name: string, ms: number) => {
    setPlaying(null);
    requestAnimationFrame(() => {
      setPlaying(name);
      setTimeout(() => setPlaying((p) => (p === name ? null : p)), ms + 100);
    });
  };

  return (
    <div style={{ borderTop: "1px solid var(--border)" }}>
      {tiers.map(({ name, ms, cssVar }) => (
        <div key={name} className="flex items-center gap-4 py-3 md:gap-6">
          <code className="w-36 shrink-0 font-mono text-xs md:w-44">{cssVar}</code>
          <span
            className="w-12 shrink-0 font-mono text-[11px] tabular-nums"
            style={{ color: "var(--muted-foreground)" }}
          >
            {ms}ms
          </span>
          <div className="relative h-1 flex-1 overflow-hidden rounded-full" style={{ backgroundColor: "var(--muted)" }}>
            <div
              className="absolute top-0 left-0 h-full rounded-full"
              style={{
                width: playing === name ? "100%" : "0%",
                backgroundColor: "var(--primary)",
                transitionProperty: playing === name ? "width" : "none",
                transitionDuration: playing === name ? `${ms}ms` : "0ms",
                transitionTimingFunction: "var(--ease-standard)",
              }}
            />
          </div>
          <Button size="xs" variant="outline" onClick={() => play(name, ms)} className="w-14 shrink-0">
            Play
          </Button>
        </div>
      ))}
    </div>
  );
}

function EasingDemo() {
  const [active, setActive] = useState<string | null>(null);
  const curves = [
    { name: "enter", cssVar: "--ease-enter", desc: "Decelerate — arrivals" },
    { name: "exit", cssVar: "--ease-exit", desc: "Accelerate — departures" },
    { name: "standard", cssVar: "--ease-standard", desc: "Full arc — state changes" },
    { name: "spring", cssVar: "--ease-spring", desc: "Overshoot — feedback" },
  ];

  const play = (name: string) => {
    setActive(null);
    requestAnimationFrame(() => requestAnimationFrame(() => setActive(name)));
  };

  return (
    <div style={{ borderTop: "1px solid var(--border)" }}>
      {curves.map(({ name, cssVar }) => (
        <div key={name} className="flex items-center gap-3 py-3">
          <code className="w-36 shrink-0 font-mono text-xs">{cssVar}</code>
          <div
            className="relative h-5 min-w-0 flex-1 overflow-hidden rounded"
            style={{ backgroundColor: "var(--muted)" }}
          >
            <div
              className="absolute top-0.5 h-4 w-8 rounded-sm"
              style={{
                left: active === name ? "calc(100% - 2.25rem)" : "4px",
                backgroundColor: "var(--primary)",
                transitionProperty: active === name ? "left" : "none",
                transitionDuration: active === name ? "400ms" : "0ms",
                transitionTimingFunction: active === name ? `var(${cssVar})` : "linear",
              }}
            />
          </div>
          <Button size="xs" variant="outline" onClick={() => play(name)} className="w-14 shrink-0">
            Play
          </Button>
        </div>
      ))}
    </div>
  );
}

function StaggerDemo() {
  const [phase, setPhase] = useState<"resting" | "reset" | "playing">("resting");
  const items = ["purpose_binding", "field_projection", "stream_isolation", "temporal_gating", "single_use_expiry"];

  const play = () => {
    setPhase("reset");
    requestAnimationFrame(() => requestAnimationFrame(() => setPhase("playing")));
  };

  const visible = phase === "resting" || phase === "playing";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5 rounded-lg p-5" style={{ border: "1px solid var(--border)" }}>
        {items.map((item, i) => (
          <div
            key={item}
            className="flex items-center gap-2.5 rounded px-3 py-2"
            style={{
              backgroundColor: "var(--card)",
              border: "1px solid var(--border)",
              opacity: visible ? 1 : 0,
              transform: visible ? "translateY(0)" : "translateY(6px)",
              transitionProperty: phase === "playing" ? "opacity, transform" : "none",
              transitionDuration: "var(--duration-moderate)",
              transitionTimingFunction: "var(--ease-enter)",
              transitionDelay: phase === "playing" ? `${i * 50}ms` : "0ms",
            }}
          >
            <span className="font-medium text-xs" style={{ color: "var(--success)" }}>
              ✓
            </span>
            <span className="font-mono text-xs">{item}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-4">
        <Button size="xs" variant="outline" onClick={play}>
          Play stagger
        </Button>
        <span className="text-xs" style={{ color: "var(--muted-foreground)" }}>
          50ms delay per item · <code className="font-mono">--stagger-base</code>
        </span>
      </div>
    </div>
  );
}

function SkeletonDemo() {
  return (
    <div className="flex flex-col gap-3">
      <div
        className="flex flex-col gap-2.5 rounded-lg border p-5"
        style={{ borderColor: "var(--border)", backgroundColor: "var(--card)" }}
      >
        <div className="flex items-center gap-3">
          <div className="shimmer-bone h-9 w-9 rounded" />
          <div className="flex flex-1 flex-col gap-1.5">
            <div className="shimmer-bone h-3 rounded" style={{ width: "40%" }} />
            <div className="shimmer-bone h-2.5 rounded" style={{ width: "60%" }} />
          </div>
        </div>
        <div className="shimmer-bone h-2.5 rounded" />
        <div className="shimmer-bone h-2.5 rounded" style={{ width: "75%" }} />
      </div>
      <p className="text-xs" style={{ color: "var(--muted-foreground)" }}>
        Used for loading states where content shape is known. Shimmer moves left-to-right at{" "}
        <code className="font-mono">1.5s</code>.
      </p>
      <style>{`
        .shimmer-bone {
          position: relative;
          overflow: hidden;
          background-color: var(--muted);
        }
        .shimmer-bone::after {
          content: '';
          position: absolute;
          inset: 0;
          background: linear-gradient(90deg, transparent 0%, oklch(1 0 0 / 0.55) 50%, transparent 100%);
          animation: shimmer-sweep 1.5s ease-in-out infinite;
        }
        @keyframes shimmer-sweep {
          from { transform: translateX(-100%); }
          to   { transform: translateX(200%); }
        }
      `}</style>
    </div>
  );
}

// ─── 06 Surfaces ─────────────────────────────────────────────────────────────

function SurfacesSection() {
  return (
    <SectionWrap id="surfaces">
      <SectionHeader
        title="Surfaces"
        description="Semantic HTML attributes that encode what a surface is. CSS derives the visual from the attribute — never the reverse."
      />

      <div className="flex flex-col gap-14">
        {/* Stage */}
        <div>
          <SubLabel>data-surface="stage" — neutral surround</SubLabel>
          <p className="mb-6 text-xs leading-relaxed" style={{ color: "var(--muted-foreground)", maxWidth: "52ch" }}>
            Frames an independent thing — a browser viewport, phone, or device that operates outside the app's own UI.
            Muted background + radial dot grid.
          </p>
          <div
            data-surface="stage"
            className="flex items-center justify-center rounded-xl p-12"
            style={{ border: "1px solid var(--border)" }}
          >
            <Card className="w-64">
              <CardContent className="flex flex-col gap-2 p-5 text-center">
                <div className="font-medium text-sm">Staged content</div>
                <div className="text-xs leading-relaxed" style={{ color: "var(--muted-foreground)" }}>
                  A browser, phone, or device frame that operates independently of the surrounding UI.
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Human / Protocol duality */}
        <div>
          <SubLabel>Surface temperature — human vs protocol</SubLabel>
          <p className="mb-6 text-xs leading-relaxed" style={{ color: "var(--muted-foreground)", maxWidth: "52ch" }}>
            Every surface belongs to a person or to the protocol. The visual language makes this legible at a glance.
            The consent card is the highest-stakes moment — both signals appear simultaneously.
          </p>

          {/* Side-by-side: human row + protocol row */}
          <div className="mb-8 flex flex-col gap-2" style={{ maxWidth: "480px" }}>
            {/* Human row */}
            <div
              style={{
                borderLeft: "1px solid var(--human)",
                background: "linear-gradient(to right, var(--human-wash), transparent 70%)",
                paddingLeft: "14px",
                paddingTop: "10px",
                paddingBottom: "10px",
              }}
            >
              <div className="font-medium text-sm">Alex Rivera</div>
              <div className="font-mono text-[11px]" style={{ color: "var(--muted-foreground)", marginTop: "2px" }}>
                instagram.com/alex · owner
              </div>
            </div>
            {/* Protocol row */}
            <div
              style={{
                borderLeft: "2px solid var(--primary)",
                background: "linear-gradient(to right, oklch(0.580 0.172 253.7 / 0.04), transparent 70%)",
                paddingLeft: "14px",
                paddingTop: "10px",
                paddingBottom: "10px",
              }}
            >
              <div className="font-mono text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                grt_8f3a2b1c · single_use · §4.2
              </div>
              <div
                className="font-mono text-[10px]"
                style={{ color: "var(--muted-foreground)", opacity: 0.55, marginTop: "2px" }}
              >
                expires 24h · PDPP v0.1.0
              </div>
            </div>
          </div>

          {/* Token reference */}
          <div style={{ borderTop: "1px solid var(--border)" }}>
            {[
              {
                attr: "--human",
                value: "oklch(0.52 0.09 45)",
                desc: "2px left border on human surfaces (identity, ownership, consent)",
              },
              {
                attr: "--human-wash",
                value: "oklch(0.52 0.09 45 / 0.07)",
                desc: "Gradient wash tint — linear-gradient to right, fades to transparent",
              },
              {
                attr: "--primary",
                value: "oklch(0.580 0.172 253.7)",
                desc: "2px left border on protocol surfaces (tokens, grants, spec data)",
              },
            ].map(({ attr, value, desc }) => (
              <div
                key={attr}
                className="flex flex-col gap-0.5 py-3 md:flex-row md:items-baseline md:gap-6"
                style={{ borderBottom: "1px solid var(--border)" }}
              >
                <code className="font-mono text-xs md:w-36 md:shrink-0">{attr}</code>
                <code
                  className="font-mono text-[11px] tabular-nums md:w-52 md:shrink-0"
                  style={{ color: "var(--muted-foreground)" }}
                >
                  {value}
                </code>
                <span className="hidden text-xs md:block md:flex-1" style={{ color: "var(--muted-foreground)" }}>
                  {desc}
                </span>
              </div>
            ))}
          </div>

          {/* Consent card — duality in its most important context */}
          <div className="mt-8">
            <div
              className="mb-4 font-mono text-[9px] uppercase tracking-widest"
              style={{ color: "var(--muted-foreground)", opacity: 0.55 }}
            >
              Consent card — both temperatures present
            </div>
            <div style={{ maxWidth: "320px" }}>
              <Card>
                <CardHeader className="p-4 pb-0">
                  {/* Human row inside the card */}
                  <div
                    style={{
                      borderLeft: "1px solid var(--human)",
                      background: "linear-gradient(to right, var(--human-wash), transparent 70%)",
                      paddingLeft: "10px",
                      paddingTop: "8px",
                      paddingBottom: "8px",
                      marginBottom: "2px",
                    }}
                  >
                    <div className="font-medium text-sm">Alex Rivera</div>
                    <div
                      className="font-mono text-[10px]"
                      style={{ color: "var(--muted-foreground)", marginTop: "1px" }}
                    >
                      instagram.com/alex · owner
                    </div>
                  </div>
                  {/* Protocol row inside the card */}
                  <div
                    style={{
                      borderLeft: "2px solid var(--primary)",
                      background: "linear-gradient(to right, oklch(0.580 0.172 253.7 / 0.04), transparent 70%)",
                      paddingLeft: "10px",
                      paddingTop: "8px",
                      paddingBottom: "8px",
                    }}
                  >
                    <div className="font-mono text-[10px]" style={{ color: "var(--muted-foreground)" }}>
                      grt_8f3a2b1c · single_use · §4.2
                    </div>
                    <div
                      className="font-mono text-[10px]"
                      style={{ color: "var(--muted-foreground)", opacity: 0.55, marginTop: "1px" }}
                    >
                      expires 24h · PDPP v0.1.0
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="px-5 pt-3 pb-5">
                  <div className="mb-1 font-medium text-xs">Longview</div>
                  <div className="text-xs leading-relaxed" style={{ color: "var(--muted-foreground)" }}>
                    Access to compensation records for career-move planning.
                  </div>
                </CardContent>
                <CardFooter className="gap-3 px-5 py-4" style={{ borderTop: "1px solid var(--border)" }}>
                  <Button size="sm">Allow</Button>
                  <Button size="sm" variant="ghost">
                    Deny
                  </Button>
                </CardFooter>
              </Card>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-10">
        <RuleBlock>
          Before styling any surface: "whose is this?" Person → <code className="font-mono text-xs">--human</code>.
          System → <code className="font-mono text-xs">--primary</code>. Neither → neutral (no temperature signal).
        </RuleBlock>
      </div>
    </SectionWrap>
  );
}

// ─── 07 Components ───────────────────────────────────────────────────────────

function ComponentsSection() {
  return (
    <SectionWrap id="components">
      <SectionHeader
        title="Components"
        description="shadcn base-nova on Base UI primitives. Own the source — extend directly, never wrap."
      />

      <div className="flex flex-col gap-12">
        {/* Buttons */}
        <div>
          <SubLabel>Button — all variants</SubLabel>
          <div className="overflow-hidden rounded-lg" style={{ border: "1px solid var(--border)" }}>
            <div className="flex flex-col gap-0">
              <div className="flex items-center gap-2 px-5 py-4" style={{ borderBottom: "1px solid var(--border)" }}>
                <span
                  className="w-16 shrink-0 font-mono text-[9px] uppercase tracking-widest"
                  style={{ color: "var(--muted-foreground)", opacity: 0.55 }}
                >
                  Variants
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <Button>Default</Button>
                  <Button variant="secondary">Secondary</Button>
                  <Button variant="outline">Outline</Button>
                  <Button variant="ghost">Ghost</Button>
                  <Button variant="destructive">Destructive</Button>
                  <Button disabled>Disabled</Button>
                </div>
              </div>
              <div className="flex items-center gap-2 px-5 py-4">
                <span
                  className="w-16 shrink-0 font-mono text-[9px] uppercase tracking-widest"
                  style={{ color: "var(--muted-foreground)", opacity: 0.55 }}
                >
                  Sizes
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="lg">Large</Button>
                  <Button>Default</Button>
                  <Button size="sm">Small</Button>
                  <Button size="xs">XS</Button>
                  <Button size="icon">P</Button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Badges */}
        <div>
          <SubLabel>Badge — all variants</SubLabel>
          <div className="flex flex-wrap gap-3 rounded-lg px-5 py-4" style={{ border: "1px solid var(--border)" }}>
            <Badge>Default</Badge>
            <Badge variant="secondary">Secondary</Badge>
            <Badge variant="outline">Outline</Badge>
            <Badge variant="destructive">Destructive</Badge>
          </div>
        </div>

        {/* Cards */}
        <div>
          <SubLabel>Card — anatomy and states</SubLabel>
          {/* Full card — anatomy specimen */}
          <div className="mb-4" style={{ maxWidth: "340px" }}>
            <Card>
              <CardHeader className="p-5 pb-3">
                <div className="font-semibold text-sm">Grant request</div>
                <div className="text-xs" style={{ color: "var(--muted-foreground)" }}>
                  Longview · continuous
                </div>
              </CardHeader>
              <CardContent className="px-5 pt-0 pb-5">
                <div className="text-xs leading-relaxed" style={{ color: "var(--muted-foreground)" }}>
                  Requesting pay statements and equity grants for compensation planning.
                </div>
              </CardContent>
              <CardFooter className="gap-3 px-5 py-4" style={{ borderTop: "1px solid var(--border)" }}>
                <Button size="sm">Allow</Button>
                <Button size="sm" variant="ghost">
                  Deny
                </Button>
              </CardFooter>
            </Card>
          </div>
          {/* States row */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Card size="sm">
                <CardContent className="p-3">
                  <div className="font-medium text-xs">Default</div>
                  <div className="mt-0.5 text-xs" style={{ color: "var(--muted-foreground)" }}>
                    Dense data, inline items.
                  </div>
                </CardContent>
              </Card>
              <div className="mt-1.5 px-0.5 font-mono text-[9px]" style={{ color: "var(--muted-foreground)" }}>
                size="sm"
              </div>
            </div>
            <div>
              <Card size="sm" className="border-primary/25">
                <CardContent className="p-3">
                  <div className="font-medium text-primary text-xs">Highlighted</div>
                  <div className="mt-0.5 text-xs" style={{ color: "var(--muted-foreground)" }}>
                    Active selection.
                  </div>
                </CardContent>
              </Card>
              <div className="mt-1.5 px-0.5 font-mono text-[9px]" style={{ color: "var(--muted-foreground)" }}>
                border-primary/25
              </div>
            </div>
            <div>
              <Card size="sm" style={{ backgroundColor: "var(--muted)", borderColor: "var(--border)" }}>
                <CardContent className="p-3">
                  <div className="font-medium text-xs" style={{ color: "var(--muted-foreground)" }}>
                    Disabled
                  </div>
                  <div className="mt-0.5 text-xs" style={{ color: "var(--muted-foreground)", opacity: 0.6 }}>
                    Not interactive.
                  </div>
                </CardContent>
              </Card>
              <div className="mt-1.5 px-0.5 font-mono text-[9px]" style={{ color: "var(--muted-foreground)" }}>
                bg-muted + muted-foreground text
              </div>
            </div>
          </div>
        </div>

        {/* Consent Card */}
        <div>
          <SubLabel>Consent card — anatomy</SubLabel>
          <p className="mb-6 text-xs leading-relaxed" style={{ color: "var(--muted-foreground)", maxWidth: "52ch" }}>
            The highest-stakes surface in the protocol. A client app is asking the person to share specific streams from
            their personal server. Both human and protocol signals must be present and legible simultaneously.
          </p>
          <SpecimenSwitcher
            specimens={CONSENT_SPECIMENS}
            render={(data) => <ConsentCard key={JSON.stringify(data.requester)} {...data} />}
          />
        </div>

        {/* Grant Inspector */}
        <div>
          <SubLabel>Grant inspector — anatomy</SubLabel>
          <p className="mb-6 text-xs leading-relaxed" style={{ color: "var(--muted-foreground)", maxWidth: "52ch" }}>
            The receipt of a consent decision. Shows what was authorized, by whom, and the grant's current lifecycle
            state. Protocol surface, all content is server-authoritative.
          </p>
          <SpecimenSwitcher
            specimens={GRANT_SPECIMENS}
            render={(data) => <GrantInspector key={data.grantId} {...data} onRevoke={() => {}} />}
          />
        </div>

        {/* Stream Inventory */}
        <div>
          <SubLabel>Stream inventory</SubLabel>
          <p className="mb-6 text-xs leading-relaxed" style={{ color: "var(--muted-foreground)", maxWidth: "52ch" }}>
            What data your personal server holds. Manifest-derived, showing each connector's streams with record counts
            and sync status. The foundation users see before any consent decision.
          </p>
          <SpecimenSwitcher
            specimens={INVENTORY_SPECIMENS}
            render={(data) => <StreamInventory key={data.connectorName} {...data} />}
          />
        </div>

        {/* Connector Card */}
        <div>
          <SubLabel>Connector card</SubLabel>
          <p className="mb-6 text-xs leading-relaxed" style={{ color: "var(--muted-foreground)", maxWidth: "52ch" }}>
            A connector's identity and capabilities from its manifest. Shows what streams are available, what selection
            parameters each supports, and any defined profiles.
          </p>
          <SpecimenSwitcher
            specimens={CONNECTOR_SPECIMENS}
            render={(data) => <ConnectorCard key={data.connectorId} {...data} />}
          />
        </div>

        {/* Spec Citation */}
        <div>
          <SubLabel>Spec citation</SubLabel>
          <p className="mb-6 text-xs leading-relaxed" style={{ color: "var(--muted-foreground)", maxWidth: "52ch" }}>
            Inline protocol references using the education layer color. Links back to spec sections. Used in grant
            inspectors, log panels, and annotation surfaces.
          </p>
          <SpecimenSwitcher
            specimens={CITATION_SPECIMENS}
            render={(data) => <SpecCitationGroup key={data.citations.map((c) => c.section).join(",")} {...data} />}
          />
        </div>
      </div>
    </SectionWrap>
  );
}

// ─── 07b Dashboard Primitives ─────────────────────────────────────────────────
// The control-plane grammar. These primitives are consumed across every
// /dashboard route. Document them here so the grammar is discoverable.

function DashboardPrimitivesSection() {
  return (
    <SectionWrap id="dashboard">
      <SectionHeader
        title="Dashboard primitives"
        description="The control-plane grammar. Layout first, surfaces selective. Every /dashboard route composes these pieces; no page should invent its own header, list, or status affordance."
      />

      <div className="flex flex-col gap-12">
        {/* PageHeader */}
        <div>
          <SubLabel>PageHeader — breadcrumbs, title, count, actions, meta</SubLabel>
          <p className="pdpp-caption mb-4 max-w-[52ch] text-muted-foreground">
            One header per page. Divides from content with a single border-b. No card, no surface.
            {"`title`"} may be prose or a <code className="pdpp-caption font-mono">&lt;code&gt;</code> element;{" "}
            {"`count`"} is a muted caption; {"`meta`"} is a row of MetaPills.
          </p>
          <div className="rounded-lg border border-border/80 bg-background p-6">
            <PageHeader
              title={<code className="font-mono">run_1776830422766</code>}
              breadcrumbs={[{ label: "Runs", href: "#" }, { label: "Run" }]}
              description="connector github · 1,159 events"
              count="page 1"
              meta={
                <>
                  <MetaPill label="status" value="succeeded" tone="success" />
                  <MetaPill label="connector" value="github" tone="protocol" />
                  <MetaPill label="duration" value="00:01:04" />
                </>
              }
            />
          </div>
        </div>

        {/* Section */}
        <div>
          <SubLabel>Section — silent visual boundary</SubLabel>
          <p className="pdpp-caption mb-4 max-w-[52ch] text-muted-foreground">
            A titled region with optional description and right-aligned action. No border, no card — just typographic
            weight and rhythm.
          </p>
          <div className="rounded-lg border border-border/80 bg-background p-6">
            <DashboardSectionPrimitive
              title="Failed traces"
              description="Recent protocol interactions that did not complete."
              action={
                <a className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                  view all →
                </a>
              }
            >
              <DataList>
                <li className="px-3 py-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <code className="pdpp-caption font-medium font-mono text-foreground">trc_qry_0bb58c8f4bcc4c3f</code>
                    <span className="pdpp-caption text-muted-foreground tabular-nums">2026-04-23T04:19:43Z</span>
                  </div>
                  <div className="pdpp-caption mt-1 flex items-center gap-2">
                    <StatusBadge status="failed" />
                    <span className="text-muted-foreground">query.rejected</span>
                  </div>
                </li>
                <li className="px-3 py-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <code className="pdpp-caption font-medium font-mono text-foreground">trc_qry_de0eef952cc1e4f0</code>
                    <span className="pdpp-caption text-muted-foreground tabular-nums">2026-04-23T04:19:43Z</span>
                  </div>
                  <div className="pdpp-caption mt-1 flex items-center gap-2">
                    <StatusBadge status="failed" />
                    <span className="text-muted-foreground">query.rejected</span>
                  </div>
                </li>
              </DataList>
            </DashboardSectionPrimitive>
          </div>
        </div>

        {/* Toolbar */}
        <div>
          <SubLabel>Toolbar — filter/action row</SubLabel>
          <p className="pdpp-caption mb-4 max-w-[52ch] text-muted-foreground">
            Horizontal flex of labelled fields and buttons. Fields stack their label above (
            <code className="font-mono">pdpp-eyebrow</code>). Reuse across search, grants, runs, traces, and timeline.
          </p>
          <div className="rounded-lg border border-border/80 bg-background p-6">
            <Toolbar>
              <label className="flex min-w-0 flex-col gap-1">
                <span className="pdpp-eyebrow">Query</span>
                <Input type="search" placeholder="id contains…" className="w-56 font-mono" defaultValue="" />
              </label>
              <label className="flex min-w-0 flex-col gap-1">
                <span className="pdpp-eyebrow">Status</span>
                <Select defaultValue="">
                  <option value="">Any</option>
                  <option value="succeeded">succeeded</option>
                  <option value="failed">failed</option>
                </Select>
              </label>
              <Button size="sm" className="mt-5">
                Filter
              </Button>
            </Toolbar>
            <FilterSummary
              items={[
                { label: "status", value: "failed" },
                { label: "connector", value: "github" },
              ]}
              resetHref="#"
            />
          </div>
        </div>

        {/* Form elements */}
        <div>
          <SubLabel>Form elements — Input, Select, Textarea</SubLabel>
          <p className="pdpp-caption mb-4 max-w-[52ch] text-muted-foreground">
            Three styled form primitives with a shared border, focus ring, and body-size type. Native elements under the
            hood so GET-form URL state works without JS. Paired with an eyebrow label above and the field gap rhythm
            from the Toolbar.
          </p>
          <div className="rounded-lg border border-border/80 bg-background p-6">
            <div className="grid gap-4 md:grid-cols-3">
              <label className="flex min-w-0 flex-col gap-1">
                <span className="pdpp-eyebrow">Text input</span>
                <Input type="text" placeholder="client_id" defaultValue="" />
              </label>
              <label className="flex min-w-0 flex-col gap-1">
                <span className="pdpp-eyebrow">Select</span>
                <Select defaultValue="">
                  <option value="">Any state</option>
                  <option value="issued">issued</option>
                  <option value="revoked">revoked</option>
                  <option value="denied">denied</option>
                </Select>
              </label>
              <label className="flex min-w-0 flex-col gap-1 md:col-span-3">
                <span className="pdpp-eyebrow">Textarea</span>
                <Textarea rows={3} placeholder="Describe the purpose of this grant…" defaultValue="" />
              </label>
            </div>
          </div>
        </div>

        {/* DataList */}
        <div>
          <SubLabel>DataList — divide-y rows</SubLabel>
          <p className="pdpp-caption mb-4 max-w-[52ch] text-muted-foreground">
            The canonical list pattern for dense operator surfaces. One <code className="font-mono">&lt;ul&gt;</code>,
            divide-y between rows, border-y outside. Intentionally flat — no alternating row backgrounds.
          </p>
          <div className="rounded-lg border border-border/80 bg-background p-6">
            <DataList>
              {["run_1776830422766", "run_1776753603111", "run_1776755678518"].map((id, i) => (
                <li key={id} className="px-3 py-2.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <code className="pdpp-caption font-medium font-mono text-foreground">{id}</code>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={i === 0 ? "succeeded" : i === 1 ? "failed" : "cancelled"} />
                      <span className="pdpp-caption text-muted-foreground tabular-nums">2026-04-22T04:11:00Z</span>
                    </div>
                  </div>
                  <div className="pdpp-caption mt-1 text-muted-foreground">{i + 1} events · github</div>
                </li>
              ))}
            </DataList>
            <Pager prev="#" next="#" countLabel="3 of 50" />
          </div>
        </div>

        {/* SplitLayout */}
        <div>
          <SubLabel>SplitLayout — main + peek pane</SubLabel>
          <p className="pdpp-caption mb-4 max-w-[52ch] text-muted-foreground">
            Two-column grid (1fr, 22rem) with responsive stack. Reserved for list+peek pages: grants, runs, traces.
          </p>
          <div className="rounded-lg border border-border/80 bg-background p-6">
            <SplitLayout
              main={
                <DataList>
                  <li className="px-3 py-2.5">
                    <code className="pdpp-caption font-medium font-mono">trc_qry_0bb58c8f4bcc4c3f</code>
                  </li>
                  <li className="px-3 py-2.5">
                    <code className="pdpp-caption font-medium font-mono">trc_qry_de0eef952cc1e4f0</code>
                  </li>
                </DataList>
              }
              peek={
                <aside className="rounded-md border border-border/80 bg-background">
                  <div className="pdpp-caption border-border/80 border-b bg-muted/40 px-3 py-2">
                    <span className="font-medium">trace trc_qry_…</span>
                  </div>
                  <div className="pdpp-caption p-3 text-muted-foreground">
                    3 events · actor/runtime · peek contents render here.
                  </div>
                </aside>
              }
            />
          </div>
        </div>

        {/* Tones: StatusBadge + MetaPill */}
        <div>
          <SubLabel>StatusBadge + MetaPill — tones</SubLabel>
          <p className="pdpp-caption mb-4 max-w-[52ch] text-muted-foreground">
            StatusBadge maps a string status to a tone (success / warning / danger / neutral). MetaPill is a small
            inline key/value chip with optional tone. Use MetaPill on PageHeader `meta`; StatusBadge per row.
          </p>
          <div className="rounded-lg border border-border/80 bg-background p-6">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <StatusBadge status="succeeded" />
              <StatusBadge status="issued" />
              <StatusBadge status="pending" />
              <StatusBadge status="started" />
              <StatusBadge status="failed" />
              <StatusBadge status="revoked" />
              <StatusBadge status="cancelled" />
              <StatusBadge status="token_issued" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <MetaPill label="workspace" value="active" tone="human" />
              <MetaPill label="client" value="registered" tone="protocol" />
              <MetaPill label="status" value="issued" tone="success" />
              <MetaPill label="attempts" value={3} />
              <MetaPill label="error" value="timeout" tone="danger" />
            </div>
          </div>
        </div>

        {/* Callout */}
        <div>
          <SubLabel>Callout — the one card pattern</SubLabel>
          <p className="pdpp-caption mb-4 max-w-[52ch] text-muted-foreground">
            Selective emphasis where a real boundary or action exists. Neutral (bordered), human (owner-tinted left
            rule), or protocol (primary-tinted left rule). Use sparingly.
          </p>
          <div className="flex flex-col gap-3">
            <Callout title="Neutral" description="Default bordered box for advisory content.">
              <p className="pdpp-caption text-muted-foreground">A quiet bordered surface.</p>
            </Callout>
            <Callout
              surface="human"
              title="Human — owner identity"
              description="Owner self-export, device-flow approval, grant-request workspace."
            >
              <p className="pdpp-caption text-muted-foreground">Copper left-rule + warm wash.</p>
            </Callout>
            <Callout
              surface="protocol"
              title="Protocol — spec data"
              description="Grant envelopes, token introspection, spec citations."
            >
              <p className="pdpp-caption text-muted-foreground">Primary blue left-rule + cool wash.</p>
            </Callout>
          </div>
        </div>

        {/* Interactive primitives — note only */}
        <div>
          <SubLabel>Interactive primitives</SubLabel>
          <p className="pdpp-caption mb-4 max-w-[52ch] text-muted-foreground">
            Two client-only primitives live alongside the layout pieces; they require routing and viewport context and
            are best demonstrated in situ.
          </p>
          <ul className="pdpp-body space-y-2">
            <li>
              <code className="pdpp-caption font-mono">ColumnsMenu</code> — progressive column disclosure on{" "}
              <a href="/dashboard/records" className="underline-offset-2 hover:underline">
                stream record tables
              </a>
              . Base UI Popover, URL state via <code className="pdpp-caption font-mono">?columns</code>.
            </li>
            <li>
              <code className="pdpp-caption font-mono">MobileDrawer</code> — slide-in shell nav below md. Base UI
              Dialog, focus trap, Escape/backdrop dismiss, matchMedia-based auto-close on breakpoint crossover.
            </li>
          </ul>
        </div>
      </div>
    </SectionWrap>
  );
}

interface CanonicalExampleWorld {
  name: string;
  monogram: string;
  descriptor: string;
  summary: string;
  anchorStream: {
    name: string;
    cadence: string;
    syncStory: string;
  };
  whyCare: string;
  whyPdpp: string;
  aiPosture: string;
  risk: string;
  sources: string[];
  fit: string[];
  rolloutCopy: {
    heroLine: string;
    consentPurpose: string;
    proofLine: string;
    docsBlurb: string;
    syncLine: string;
  };
  consent: ConsentCardProps;
  grant: GrantInspectorProps;
  projection: {
    streamLabel: string;
    summary: string;
    granted: string[];
    withheld: string[];
  };
}

const COMPENSATION_STREAM_DETAILS = {
  payStatements:
    "Employer, pay period, gross pay, net pay, and withholding summary. No bank account details or tax ID fragments.",
  equityGrants:
    "Grant type, quantity, vesting schedule, and strike price. No brokerage account numbers or beneficiary details.",
  benefits:
    "Plan name, coverage tier, employer contribution, and effective date. No dependent data, claims, or provider notes.",
} as const;

function createCompensationWorld({
  name,
  monogram,
  logoSrc,
  uri,
  policyUri,
  tosUri,
  descriptor,
  summary,
  anchorStream,
  whyCare,
  whyPdpp,
  aiPosture,
  risk,
  sources,
  fit,
  rolloutCopy,
  clientId,
  purpose,
  purposeCode,
  purposeDescription,
  commitments,
}: {
  name: string;
  monogram: string;
  logoSrc?: string;
  uri?: string;
  policyUri?: string;
  tosUri?: string;
  descriptor: string;
  summary: string;
  anchorStream: CanonicalExampleWorld["anchorStream"];
  whyCare: string;
  whyPdpp: string;
  aiPosture: string;
  risk: string;
  sources: string[];
  fit: string[];
  rolloutCopy: CanonicalExampleWorld["rolloutCopy"];
  clientId: string;
  purpose: string;
  purposeCode: string;
  purposeDescription: string;
  commitments: string[];
}): CanonicalExampleWorld {
  return {
    name,
    monogram,
    descriptor,
    summary,
    anchorStream,
    whyCare,
    whyPdpp,
    aiPosture,
    risk,
    sources,
    fit,
    rolloutCopy,
    consent: {
      requester: { name, monogram, verified: true, logoSrc, uri, policyUri, tosUri },
      purpose,
      commitments,
      streams: [
        { key: "pay_statements", label: "Pay statements", detail: COMPENSATION_STREAM_DETAILS.payStatements },
        { key: "equity_grants", label: "Equity grants", detail: COMPENSATION_STREAM_DETAILS.equityGrants },
      ],
      optional: {
        key: "benefits_enrollments",
        label: "Benefits enrollments",
        detail: COMPENSATION_STREAM_DETAILS.benefits,
        consequenceOn: "Improves the plan comparison and exposes coverage tradeoffs.",
        consequenceOff: "Leaves the rest of the compensation analysis intact.",
      },
      accessMode: "continuous",
      technical: { clientId, purposeCode, grantExpires: "Apr 15, 2027" },
    },
    grant: {
      grantId: `grt_${clientId.replace(/[^a-z0-9]/gi, "").slice(0, 10)}`,
      issuedAt: "Apr 15, 2026",
      status: "active",
      client: { clientId, name },
      purposeCode,
      purposeDescription,
      accessMode: "continuous",
      expiresAt: "Apr 15, 2027",
      retention: { duration: "90 days", onExpiry: "delete" },
      streams: [
        {
          name: "pay_statements",
          label: "Pay statements",
          detail: COMPENSATION_STREAM_DETAILS.payStatements,
          view: "summary",
          fields: ["employer", "pay_period", "gross_pay", "net_pay"],
          timeRange: { since: "Jan 1, 2025" },
        },
        {
          name: "equity_grants",
          label: "Equity grants",
          detail: COMPENSATION_STREAM_DETAILS.equityGrants,
          view: "vesting_summary",
          fields: ["grant_type", "quantity", "vesting_start", "vesting_schedule"],
        },
      ],
    },
    projection: {
      streamLabel: "Pay statements",
      summary:
        "The proof moment stays legible: the app gets the comparability fields and leaves the identity-heavy payroll fields behind.",
      granted: ["employer", "pay_period", "gross_pay", "net_pay"],
      withheld: ["employee_id", "home_address", "bank_account_last4", "tax_id_fragment"],
    },
  };
}

const CANONICAL_EXAMPLE_WORLD: CanonicalExampleWorld = createCompensationWorld({
  name: "Longview",
  monogram: "LV",
  descriptor: "Compensation planning",
  summary: "Compares salary, equity, benefits, and tax tradeoffs before a career move.",
  uri: LONGVIEW_CLIENT_URI,
  policyUri: LONGVIEW_POLICY_URI,
  tosUri: LONGVIEW_TOS_URI,
  anchorStream: {
    name: "pay_statements",
    cadence: "Append-only, every payroll cycle",
    syncStory:
      "Each pay cycle adds one new pay statement. Longview syncs the new record instead of re-downloading the entire compensation history.",
  },
  whyCare: "A person has an offer in hand and wants a serious, document-backed read on what actually changes.",
  whyPdpp:
    "The decision spans payroll, equity, and benefits systems. The useful fields are narrower than the raw records, and no single bank-style aggregator covers the set.",
  aiPosture:
    "Normalizes offer letters, pay statements, vesting schedules, and benefit summaries into comparable scenarios.",
  risk: "The identity is strongest when it stays wordmark-led. The standalone symbol is still in review until it earns its keep at small sizes.",
  sources: ["Payroll portal", "Equity administrator", "Benefits portal"],
  fit: ["Legible to non-experts", "Premium enough to feel paid", "Clearly beyond Plaid", "Strong sync story"],
  rolloutCopy: {
    heroLine: "Longview compares salary, equity, benefits, and tax tradeoffs before a career move.",
    consentPurpose:
      "Longview is requesting compensation records to compare salary, equity, benefits, and tax tradeoffs before a career move.",
    proofLine: "The app gets the comparability fields and leaves the identity-heavy payroll fields behind.",
    docsBlurb:
      "A compensation-planning client that needs payroll, equity, and benefits records under one enforceable consent boundary.",
    syncLine: "Each payroll cycle adds one new pay statement, so sync returns only the new record.",
  },
  clientId: "longview_planning_v1",
  purposeCode: "planning",
  purposeDescription: "Career-move compensation planning",
  purpose:
    "Longview is requesting compensation records to compare salary, equity, benefits, and tax tradeoffs before a career move.",
  commitments: [
    "Analysis remains private to this planning workspace",
    "No employer outreach or document sharing without separate approval",
  ],
});

type LongviewLogoVariant = "aperture_span" | "horizon_tile" | "frame_lane";

interface LongviewLogoCandidate {
  id: LongviewLogoVariant;
  name: string;
  verdict: "recommended" | "alternative" | "discard";
  summary: string;
  strength: string;
  risk: string;
}

const LONGVIEW_LOGO_CANDIDATES: LongviewLogoCandidate[] = [
  {
    id: "aperture_span",
    name: "Aperture wordmark",
    verdict: "recommended",
    summary: "Wordmark-led system with a restrained open-span mark beside it.",
    strength: "Feels closest to a premium software or advisory product instead of a generated fintech icon.",
    risk: "The standalone symbol still needs one more reduction pass before it earns favicon-scale use by itself.",
  },
  {
    id: "horizon_tile",
    name: "Horizon tile",
    verdict: "alternative",
    summary: "Contained tile mark with a panoramic cut running through the center.",
    strength: "Most credible as an app icon or sidebar avatar once the interior cut gets more ownable.",
    risk: "Still risks feeling generic if the slit reads as UI chrome instead of brand geometry.",
  },
  {
    id: "frame_lane",
    name: "Frame lane",
    verdict: "discard",
    summary: "Open frame with an internal lane carrying the view line.",
    strength: "Keeps the horizon idea without becoming a literal monogram.",
    risk: "Still reads more like product UI chrome than something a world-class brand would own.",
  },
];

function LongviewIdentityLockup({
  variant,
  inverse = false,
  compact = false,
}: {
  variant: LongviewLogoVariant;
  inverse?: boolean;
  compact?: boolean;
}) {
  const wordColor = inverse ? "#FBFCFE" : "var(--foreground)";
  const descriptorColor = inverse ? "rgba(251, 252, 254, 0.68)" : "var(--primary)";
  const chipBackground = inverse ? "rgba(251, 252, 254, 0.08)" : "color-mix(in oklab, var(--primary) 7%, white)";
  const chipBorder = inverse
    ? "1px solid rgba(251, 252, 254, 0.16)"
    : "1px solid color-mix(in oklab, var(--primary) 16%, var(--border))";
  const chipSizeClass = compact ? "h-9 w-9 rounded-[1rem]" : "h-11 w-11 rounded-2xl";
  const markSizeClass = compact ? "h-4 w-6" : "h-5 w-7";
  const wordClass = compact ? "text-[1.05rem]" : "text-[1.45rem]";
  const descriptorClass = compact ? "text-[9px]" : "text-[10px]";
  const descriptorMarginTop = compact ? "0.28rem" : "0.38rem";

  return (
    <div className="flex min-w-0 items-center gap-3">
      <div
        className={`flex shrink-0 items-center justify-center ${chipSizeClass}`}
        style={{
          backgroundColor: chipBackground,
          border: chipBorder,
        }}
      >
        <LongviewLogoMark variant={variant} inverse={inverse} className={markSizeClass} />
      </div>
      <div className="min-w-0">
        <div
          className={`${wordClass} truncate font-semibold leading-none`}
          style={{
            color: wordColor,
            letterSpacing: "-0.05em",
          }}
        >
          Longview
        </div>
        <div
          className={`${descriptorClass} truncate font-mono uppercase tracking-[0.11em]`}
          style={{
            color: descriptorColor,
            marginTop: descriptorMarginTop,
          }}
        >
          Compensation planning
        </div>
      </div>
    </div>
  );
}

function LongviewLogoMark({
  variant,
  inverse = false,
  className = "h-12 w-20",
}: {
  variant: LongviewLogoVariant;
  inverse?: boolean;
  className?: string;
}) {
  const fill = inverse ? "#FBFCFE" : "#233F86";

  if (variant === "horizon_tile") {
    return (
      <svg viewBox="0 0 128 80" aria-hidden="true" className={className}>
        <path
          d="M18 10c0-4 3-7 7-7h64c4 0 7 3 7 7v60c0 4-3 7-7 7H25c-4 0-7-3-7-7V10Zm16 14v32h46V24H34Zm22 11h40v10H56V35Z"
          fill={fill}
          fillRule="evenodd"
        />
      </svg>
    );
  }

  if (variant === "frame_lane") {
    return (
      <svg viewBox="0 0 128 80" aria-hidden="true" className={className}>
        <path d="M18 16H58V28H32V52H58V64H18V16Z" fill={fill} />
        <path d="M50 34H112V46H50V34Z" fill={fill} />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 128 80" aria-hidden="true" className={className}>
      <path d="M18 16H62V28H32V52H104V64H18V16Z" fill={fill} />
    </svg>
  );
}

function LongviewCandidatePreview({ candidate }: { candidate: LongviewLogoCandidate }) {
  const verdictTone =
    candidate.verdict === "recommended"
      ? {
          color: "var(--primary)",
          backgroundColor: "color-mix(in oklab, var(--primary) 8%, white)",
          border: "1px solid color-mix(in oklab, var(--primary) 18%, var(--border))",
          label: "Recommended",
        }
      : candidate.verdict === "alternative"
        ? {
            color: "var(--foreground)",
            backgroundColor: "color-mix(in oklab, var(--human-wash) 82%, white)",
            border: "1px solid color-mix(in oklab, var(--human) 18%, var(--border))",
            label: "Alternative",
          }
        : {
            color: "var(--muted-foreground)",
            backgroundColor: "var(--muted)",
            border: "1px solid var(--border)",
            label: "Discard",
          };

  return (
    <div className="border-t pt-4" style={{ borderColor: "var(--border)" }}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-sm tracking-tight">{candidate.name}</div>
          <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--muted-foreground)", maxWidth: "34ch" }}>
            {candidate.summary}
          </p>
        </div>
        <span
          className="w-fit rounded-full px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em]"
          style={verdictTone}
        >
          {verdictTone.label}
        </span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div
          className="flex h-20 items-center justify-center rounded-[1rem] px-4"
          style={{
            backgroundColor: "color-mix(in oklab, var(--muted) 58%, white)",
            border: "1px solid color-mix(in oklab, var(--border) 86%, white)",
          }}
        >
          <LongviewLogoMark variant={candidate.id} className="h-8 w-14" />
        </div>
        <div
          className="flex h-20 items-center justify-center rounded-[1rem] px-4"
          style={{
            backgroundColor: "#203976",
            border: "1px solid color-mix(in oklab, #203976 82%, white)",
          }}
        >
          <LongviewLogoMark variant={candidate.id} inverse className="h-8 w-14" />
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div>
          <div
            className="font-mono text-[10px] uppercase tracking-[0.09em]"
            style={{ color: "var(--muted-foreground)", marginBottom: "0.45rem" }}
          >
            Strength
          </div>
          <p className="text-xs leading-relaxed" style={{ color: "var(--foreground)" }}>
            {candidate.strength}
          </p>
        </div>
        <div>
          <div
            className="font-mono text-[10px] uppercase tracking-[0.09em]"
            style={{ color: "var(--muted-foreground)", marginBottom: "0.45rem" }}
          >
            Risk
          </div>
          <p className="text-xs leading-relaxed" style={{ color: "var(--foreground)" }}>
            {candidate.risk}
          </p>
        </div>
      </div>
    </div>
  );
}

function ExampleWorldsSection() {
  const world = CANONICAL_EXAMPLE_WORLD;

  return (
    <SectionWrap id="examples">
      <SectionHeader
        title="Reference World"
        description="The one example world reused across the reference, docs, consent cards, and screenshots."
      />

      <div className="flex flex-col gap-12">
        <div className="grid gap-10 xl:grid-cols-[minmax(0,1.18fr)_minmax(18rem,0.82fr)]">
          <div className="flex flex-col gap-6">
            <div
              className="font-mono text-[10px] uppercase tracking-[0.09em]"
              style={{ color: "var(--muted-foreground)" }}
            >
              Identity direction
            </div>

            <div>
              <div className="font-semibold text-[1.7rem] leading-none tracking-tight">Longview</div>
              <div
                className="mt-2 font-mono text-[10px] uppercase tracking-[0.11em]"
                style={{ color: "var(--primary)" }}
              >
                Compensation planning
              </div>
            </div>
            <p className="text-sm leading-relaxed" style={{ color: "var(--foreground)", maxWidth: "54ch" }}>
              Longview is the product. Use Aperture wordmark as the system direction. Keep Horizon tile only as reserve.
              Drop Frame lane.
            </p>

            <div className="grid gap-3 lg:grid-cols-2">
              <div
                className="flex min-h-[7.5rem] items-center rounded-[1rem] px-5 py-4"
                style={{
                  backgroundColor: "color-mix(in oklab, var(--muted) 58%, white)",
                  border: "1px solid var(--border)",
                }}
              >
                <LongviewIdentityLockup variant="aperture_span" />
              </div>
              <div
                className="flex min-h-[7.5rem] items-center rounded-[1rem] px-5 py-4"
                style={{
                  backgroundColor: "#203976",
                  border: "1px solid color-mix(in oklab, #203976 82%, white)",
                }}
              >
                <LongviewIdentityLockup variant="aperture_span" inverse />
              </div>
            </div>

            <div
              className="border-t pt-5"
              style={{ borderColor: "color-mix(in oklab, var(--primary) 18%, var(--border))" }}
            >
              <div
                className="font-mono text-[10px] uppercase tracking-[0.09em]"
                style={{ color: "var(--muted-foreground)", marginBottom: "0.75rem" }}
              >
                Recommended symbol sizes
              </div>
              <div className="grid grid-cols-4 gap-2">
                {[16, 24, 32, 64].map((size) => (
                  <div
                    key={size}
                    className="rounded-[0.85rem] px-2 py-3 text-center"
                    style={{
                      backgroundColor: "color-mix(in oklab, var(--muted) 42%, white)",
                      border: "1px solid color-mix(in oklab, var(--border) 86%, white)",
                    }}
                  >
                    <div className="flex h-10 items-center justify-center">
                      <LongviewLogoMark
                        variant="aperture_span"
                        className={
                          size === 16 ? "h-3 w-6" : size === 24 ? "h-4 w-8" : size === 32 ? "h-5 w-10" : "h-7 w-14"
                        }
                      />
                    </div>
                    <div className="mt-2 font-mono text-[10px]" style={{ color: "var(--muted-foreground)" }}>
                      {size}px
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="border-t pt-5" style={{ borderColor: "var(--border)" }}>
              <div
                className="font-mono text-[10px] uppercase tracking-[0.09em]"
                style={{ color: "var(--muted-foreground)", marginBottom: "0.5rem" }}
              >
                Other Longview directions considered
              </div>
              <div className="flex flex-col">
                {LONGVIEW_LOGO_CANDIDATES.filter((candidate) => candidate.verdict !== "recommended").map(
                  (candidate) => (
                    <LongviewCandidatePreview key={candidate.id} candidate={candidate} />
                  )
                )}
              </div>
            </div>
          </div>

          <aside className="flex flex-col gap-6 xl:border-l xl:pl-8" style={{ borderColor: "var(--border)" }}>
            <div>
              <div
                className="mb-4 font-mono text-[10px] uppercase tracking-[0.09em]"
                style={{ color: "var(--muted-foreground)" }}
              >
                Reference bar
              </div>
              <div className="flex flex-wrap gap-2">
                {["Apple", "Nike", "IBM", "FedEx", "Shell", "Stripe", "Plaid", "Linear"].map((name) => (
                  <span
                    key={name}
                    className="rounded-full px-2.5 py-1.5 text-xs"
                    style={{
                      color: "var(--foreground)",
                      backgroundColor: "color-mix(in oklab, var(--muted) 44%, white)",
                      border: "1px solid var(--border)",
                    }}
                  >
                    {name}
                  </span>
                ))}
              </div>
            </div>

            <div className="border-t pt-5" style={{ borderColor: "var(--border)" }}>
              <div
                className="font-mono text-[10px] uppercase tracking-[0.09em]"
                style={{ color: "var(--muted-foreground)", marginBottom: "0.75rem" }}
              >
                Keep only if it can do all of this
              </div>
              <div className="flex flex-col gap-3">
                {[
                  "A distinct silhouette after one glance",
                  "Legible at 16px and 32px without texture or glow",
                  "One-color performance on light and dark backgrounds",
                  "No accidental lettermark unless the letterform is exceptional",
                  "Looks believable in a consent card, favicon, and app tile",
                  "Feels ownable rather than like anonymous fintech clip-art",
                ].map((rule) => (
                  <p key={rule} className="text-xs leading-relaxed" style={{ color: "var(--foreground)" }}>
                    {rule}
                  </p>
                ))}
              </div>
            </div>

            <div className="border-t pt-5" style={{ borderColor: "var(--border)" }}>
              <div
                className="font-mono text-[10px] uppercase tracking-[0.09em]"
                style={{ color: "var(--muted-foreground)", marginBottom: "0.75rem" }}
              >
                Decision
              </div>
              <p className="text-xs leading-relaxed" style={{ color: "var(--foreground)" }}>
                Standardize Aperture wordmark for the reference, docs, and screenshots. Keep Horizon tile only if a
                stronger app-icon need emerges. Discard Frame lane.
              </p>
              <p className="mt-3 text-xs leading-relaxed" style={{ color: "var(--muted-foreground)" }}>
                The standalone symbol is still secondary. The thing to standardize first is the wordmark-led Longview
                system used in the docs and reference surfaces.
              </p>
            </div>
          </aside>
        </div>

        <div className="grid gap-10 xl:grid-cols-[minmax(0,0.98fr)_minmax(0,1.02fr)] xl:items-start">
          <div className="flex flex-col gap-6">
            <div
              className="font-mono text-[10px] uppercase tracking-[0.09em]"
              style={{ color: "var(--muted-foreground)" }}
            >
              Product brief
            </div>

            <div>
              <LongviewIdentityLockup variant="aperture_span" />
              <p
                className="mt-3 text-sm leading-relaxed"
                style={{ color: "var(--muted-foreground)", maxWidth: "58ch" }}
              >
                {world.summary}
              </p>
            </div>

            <div className="grid gap-5 md:grid-cols-2">
              {[
                ["Why people care", world.whyCare],
                ["Why PDPP, not Plaid", world.whyPdpp],
                ["AI posture", world.aiPosture],
                ["Risk to watch", world.risk],
              ].map(([label, value]) => (
                <div key={label}>
                  <div
                    className="font-mono text-[10px] uppercase tracking-[0.09em]"
                    style={{ color: "var(--muted-foreground)", marginBottom: "0.5rem" }}
                  >
                    {label}
                  </div>
                  <p className="text-xs leading-relaxed" style={{ color: "var(--foreground)" }}>
                    {value}
                  </p>
                </div>
              ))}
            </div>

            <div className="border-t pt-5" style={{ borderColor: "var(--border)" }}>
              <div
                className="font-mono text-[10px] uppercase tracking-[0.09em]"
                style={{ color: "var(--primary)", marginBottom: "0.75rem" }}
              >
                Anchor stream
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <code
                  className="rounded-full px-2.5 py-1 text-xs"
                  style={{
                    color: "var(--foreground)",
                    backgroundColor: "color-mix(in oklab, var(--muted) 42%, white)",
                    border: "1px solid var(--border)",
                  }}
                >
                  {world.anchorStream.name}
                </code>
                <span
                  className="rounded-full px-2.5 py-1 text-xs"
                  style={{
                    color: "var(--foreground)",
                    backgroundColor: "color-mix(in oklab, var(--muted) 42%, white)",
                    border: "1px solid var(--border)",
                  }}
                >
                  {world.anchorStream.cadence}
                </span>
              </div>
              <p
                className="mt-3 text-xs leading-relaxed"
                style={{ color: "var(--muted-foreground)", maxWidth: "52ch" }}
              >
                {world.anchorStream.syncStory}
              </p>
            </div>

            <div className="grid gap-5 md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
              <div>
                <div
                  className="font-mono text-[10px] uppercase tracking-[0.09em]"
                  style={{ color: "var(--muted-foreground)", marginBottom: "0.75rem" }}
                >
                  Source systems
                </div>
                <div className="flex flex-wrap gap-2">
                  {world.sources.map((source) => (
                    <span
                      key={source}
                      className="rounded-full px-2.5 py-1.5 text-xs"
                      style={{
                        color: "var(--foreground)",
                        backgroundColor: "color-mix(in oklab, var(--muted) 42%, white)",
                        border: "1px solid var(--border)",
                      }}
                    >
                      {source}
                    </span>
                  ))}
                </div>
              </div>

              <div>
                <div
                  className="font-mono text-[10px] uppercase tracking-[0.09em]"
                  style={{ color: "var(--muted-foreground)", marginBottom: "0.75rem" }}
                >
                  Fit
                </div>
                <div className="flex flex-wrap gap-2">
                  {world.fit.map((item) => (
                    <span
                      key={item}
                      className="rounded-full px-2.5 py-1.5 text-xs"
                      style={{
                        color: "var(--foreground)",
                        backgroundColor: "color-mix(in oklab, var(--background) 75%, var(--human-wash))",
                        border: "1px solid color-mix(in oklab, var(--human) 18%, var(--border))",
                      }}
                    >
                      {item}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="border-t pt-5" style={{ borderColor: "var(--border)" }}>
              <div
                className="font-mono text-[10px] uppercase tracking-[0.09em]"
                style={{ color: "var(--muted-foreground)", marginBottom: "0.75rem" }}
              >
                Next reference worlds to build
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                {[
                  [
                    "Subscription review",
                    "Renewal notices, receipts, refunds, and SaaS billing records under one boundary.",
                  ],
                  ["Travel reimbursement", "Bookings, receipts, and policy documents for policy-aware expense review."],
                  [
                    "Benefits appeal",
                    "EOBs, provider bills, prescriptions, and coverage letters for dispute preparation.",
                  ],
                ].map(([label, detail]) => (
                  <div key={label}>
                    <div className="font-medium text-xs" style={{ color: "var(--foreground)" }}>
                      {label}
                    </div>
                    <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--muted-foreground)" }}>
                      {detail}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-6 xl:border-l xl:pl-8" style={{ borderColor: "var(--border)" }}>
            <div
              className="font-mono text-[10px] uppercase tracking-[0.09em]"
              style={{ color: "var(--muted-foreground)" }}
            >
              Shared copy
            </div>

            <div className="border-t pt-5" style={{ borderColor: "var(--border)" }}>
              <div
                className="font-mono text-[10px] uppercase tracking-[0.09em]"
                style={{ color: "var(--muted-foreground)", marginBottom: "0.75rem" }}
              >
                Copy to carry through the site
              </div>
              {[
                ["Hero line", world.rolloutCopy.heroLine],
                ["Consent purpose", world.rolloutCopy.consentPurpose],
                ["Proof line", world.rolloutCopy.proofLine],
                ["Sync line", world.rolloutCopy.syncLine],
                ["Docs blurb", world.rolloutCopy.docsBlurb],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="grid gap-1 py-3 md:grid-cols-[7.25rem_minmax(0,1fr)]"
                  style={{ borderTop: label === "Hero line" ? "none" : "1px solid var(--border)" }}
                >
                  <div
                    className="font-mono text-[10px] uppercase tracking-[0.09em]"
                    style={{ color: "var(--muted-foreground)" }}
                  >
                    {label}
                  </div>
                  <div className="text-xs leading-relaxed" style={{ color: "var(--foreground)" }}>
                    {value}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="grid gap-8 xl:grid-cols-[minmax(0,1.04fr)_minmax(0,0.96fr)]">
          <div className="flex flex-col gap-4">
            <SubLabel>Consent surface</SubLabel>
            <ConsentCard key={`${world.name}-consent`} {...world.consent} />
          </div>

          <div className="flex flex-col gap-6">
            <div
              data-surface="protocol"
              className="rounded-[1.25rem] px-5 py-5 md:px-6 md:py-6"
              style={{ border: "1px solid var(--border)" }}
            >
              <div
                className="font-mono text-[10px] uppercase tracking-[0.09em]"
                style={{ color: "var(--primary)", marginBottom: "0.75rem" }}
              >
                Projection
              </div>
              <div className="font-semibold text-sm" style={{ color: "var(--foreground)" }}>
                {world.projection.streamLabel}
              </div>
              <p
                className="mt-2 text-xs leading-relaxed"
                style={{ color: "var(--muted-foreground)", maxWidth: "46ch" }}
              >
                {world.projection.summary}
              </p>
              <p
                className="mt-2 text-xs leading-relaxed"
                style={{ color: "var(--muted-foreground)", maxWidth: "46ch" }}
              >
                {world.rolloutCopy.syncLine}
              </p>

              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <div>
                  <div
                    className="font-mono text-[10px] uppercase tracking-[0.09em]"
                    style={{ color: "var(--muted-foreground)", marginBottom: "0.75rem" }}
                  >
                    4 fields returned
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {world.projection.granted.map((field) => (
                      <code
                        key={field}
                        className="rounded-full px-2.5 py-1 text-xs"
                        style={{
                          color: "var(--foreground)",
                          backgroundColor: "color-mix(in oklab, var(--primary) 10%, white)",
                          border: "1px solid color-mix(in oklab, var(--primary) 16%, var(--border))",
                        }}
                      >
                        {field}
                      </code>
                    ))}
                  </div>
                </div>

                <div>
                  <div
                    className="font-mono text-[10px] uppercase tracking-[0.09em]"
                    style={{ color: "var(--muted-foreground)", marginBottom: "0.75rem" }}
                  >
                    4 fields withheld
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {world.projection.withheld.map((field) => (
                      <code
                        key={field}
                        className="rounded-full px-2.5 py-1 text-xs"
                        style={{
                          color: "var(--muted-foreground)",
                          backgroundColor: "var(--muted)",
                          border: "1px solid var(--border)",
                        }}
                      >
                        {field}
                      </code>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div>
              <SubLabel>Grant surface</SubLabel>
              <GrantInspector key={`${world.name}-grant`} {...world.grant} onRevoke={() => {}} />
            </div>
          </div>
        </div>

        <RuleBlock>
          Choose one reference world and carry it through `/`, `/design`, docs, API examples, and screenshots. The
          example should not rename itself every time the surface changes.
        </RuleBlock>
      </div>
    </SectionWrap>
  );
}

// ─── 09 Docs ─────────────────────────────────────────────────────────────────

function DocsSection() {
  return (
    <SectionWrap id="docs">
      <SectionHeader
        title="Docs"
        description="The spec site is a PDPP product surface, not a separate microsite. Docs chrome, prose density, and technical artifacts inherit the same shell rules, temperatures, and muted surfaces as the rest of the app."
      />

      <div className="flex flex-col gap-12">
        <div>
          <SubLabel>Docs shell — masthead, sidebar, TOC</SubLabel>
          <div
            className="overflow-hidden rounded-xl"
            style={{ border: "1px solid var(--border)", backgroundColor: "var(--background)" }}
          >
            <div
              className="flex items-center gap-3 px-5 md:px-6"
              style={{
                height: "2.75rem",
                borderBottom: "1px solid var(--border)",
                backgroundColor: "var(--background)",
              }}
            >
              <div className="flex items-center gap-2">
                <div
                  className="flex h-5 w-5 items-center justify-center rounded"
                  style={{ background: "var(--primary)", color: "var(--primary-foreground)" }}
                >
                  <span className="font-bold text-[9px] leading-none">P</span>
                </div>
                <span className="font-semibold text-sm tracking-tight">PDPP</span>
                <span style={{ color: "var(--muted-foreground)", opacity: 0.4 }}>/</span>
                <span className="text-sm" style={{ color: "var(--muted-foreground)" }}>
                  Docs
                </span>
              </div>
              <div className="flex-1" />
              <span className="font-mono text-xs" style={{ color: "var(--muted-foreground)", opacity: 0.5 }}>
                v0.1.0
              </span>
            </div>

            <div className="flex">
              <aside
                className="hidden shrink-0 md:block"
                style={{
                  width: "var(--pdpp-sidebar-width)",
                  borderRight: "1px solid var(--border)",
                  background:
                    "linear-gradient(to bottom, color-mix(in oklab, var(--human-wash) 58%, white), transparent 18%), color-mix(in oklab, var(--background) 97%, white)",
                }}
              >
                <div className="px-3 py-5">
                  <div
                    className="mb-1 px-2 font-mono font-semibold text-[9px] uppercase tracking-[0.08em]"
                    style={{ color: "var(--muted-foreground)" }}
                  >
                    Spec
                  </div>
                  <nav className="flex flex-col gap-0.5">
                    {[
                      { label: "Overview", active: false },
                      { label: "Core Protocol", active: true },
                      { label: "Collection Profile", active: false },
                      { label: "Architecture", active: false },
                    ].map((item) => (
                      <div
                        key={item.label}
                        className="relative rounded-lg px-2 py-2 text-[13px]"
                        style={{
                          backgroundColor: item.active ? "var(--muted)" : "transparent",
                          color: item.active ? "var(--foreground)" : "var(--muted-foreground)",
                          fontWeight: item.active ? 500 : 400,
                        }}
                      >
                        {item.active && (
                          <span
                            aria-hidden="true"
                            className="absolute top-2.5 bottom-2.5 left-2 w-px"
                            style={{ backgroundColor: "var(--human)" }}
                          />
                        )}
                        <span style={{ paddingLeft: item.active ? "0.625rem" : 0 }}>{item.label}</span>
                      </div>
                    ))}
                  </nav>
                </div>
              </aside>

              <div className="min-w-0 flex-1">
                <div
                  style={{
                    marginLeft: "-1.5rem",
                    marginRight: "-1.5rem",
                    borderLeft: "1px solid var(--human)",
                    borderBottom: "1px solid var(--border)",
                    background: "linear-gradient(to right, var(--human-wash), transparent 70%)",
                  }}
                >
                  <div className="px-6 py-7 md:px-8">
                    <div className="pdpp-eyebrow">Protocol Spec</div>
                    <h3
                      className="mt-2 font-semibold tracking-tight"
                      style={{ fontSize: "clamp(1.9rem, 4vw, 2.75rem)", lineHeight: 1.02, letterSpacing: "-0.05em" }}
                    >
                      Personal Data Portability Protocol
                    </h3>
                    <p
                      className="mt-3 max-w-[56ch] text-sm leading-relaxed"
                      style={{ color: "var(--muted-foreground)" }}
                    >
                      Authorization semantics, stream disclosure, and collection profile boundaries expressed with the
                      same shell language as the live reference.
                    </p>
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <button
                        className="rounded-full px-3 py-1.5 font-medium text-xs"
                        style={{ backgroundColor: "var(--foreground)", color: "var(--background)" }}
                      >
                        Copy Markdown
                      </button>
                      <button
                        className="rounded-full border px-3 py-1.5 font-medium text-xs"
                        style={{
                          borderColor: "var(--border)",
                          backgroundColor: "var(--card)",
                          color: "var(--foreground)",
                        }}
                      >
                        Open
                      </button>
                    </div>
                  </div>
                </div>

                <div className="px-5 py-8 md:px-8">
                  <div className="font-semibold text-sm tracking-tight">1. Introduction</div>
                  <p className="mt-3 max-w-[54ch] text-sm leading-relaxed" style={{ color: "var(--muted-foreground)" }}>
                    Dense protocol prose stays quiet: neutral surfaces, mono for protocol facts, and structure through
                    borders instead of decorative noise.
                  </p>
                </div>
              </div>

              <aside
                className="hidden w-[16rem] shrink-0 px-5 py-8 xl:block"
                style={{ color: "var(--muted-foreground)" }}
              >
                <div className="font-mono font-semibold text-[11px] uppercase tracking-[0.08em]">On This Page</div>
                <div className="mt-4 flex flex-col gap-2 text-xs">
                  <div style={{ color: "var(--foreground)" }}>1. Introduction</div>
                  <div>2. Terminology</div>
                  <div>3. System Architecture</div>
                  <div>4. Record Model</div>
                </div>
              </aside>
            </div>
          </div>
        </div>

        <div>
          <SubLabel>Protocol prose — inline code and code block</SubLabel>
          <div className="flex flex-col gap-5" style={{ maxWidth: "760px" }}>
            <p className="text-sm leading-relaxed" style={{ color: "var(--foreground)" }}>
              A client requests{" "}
              <code
                className="rounded-full px-1.5 py-0.5 font-mono text-xs"
                style={{
                  border: "1px solid var(--border)",
                  backgroundColor: "color-mix(in oklab, var(--muted) 84%, white)",
                }}
              >
                authorization_details
              </code>{" "}
              and receives a{" "}
              <code
                className="rounded-full px-1.5 py-0.5 font-mono text-xs"
                style={{
                  border: "1px solid var(--border)",
                  backgroundColor: "color-mix(in oklab, var(--muted) 84%, white)",
                }}
              >
                grant
              </code>
              . Inline protocol facts stay small, mono, and pill-framed. They do not get heavy contrast blocks.
            </p>

            <pre
              className="overflow-auto rounded-2xl border p-5 text-xs leading-relaxed"
              style={{
                borderColor: "var(--border)",
                backgroundColor: "var(--muted)",
                color: "var(--muted-foreground)",
                boxShadow: "0 1px 2px rgb(0 0 0 / 0.04), 0 1px 3px rgb(0 0 0 / 0.02)",
              }}
            >{`{
  "stream": "following_accounts",
  "view": "social_graph",
  "access_mode": "single_use",
  "time_range": { "since": "2026-01-01" }
}`}</pre>
          </div>
        </div>

        <div>
          <SubLabel>Reference density — table and callout</SubLabel>
          <div className="flex flex-col gap-6" style={{ maxWidth: "760px" }}>
            <div className="overflow-x-auto" style={{ border: "1px solid var(--border)", borderRadius: "1rem" }}>
              <table className="w-full text-sm" style={{ borderCollapse: "collapse", minWidth: "480px" }}>
                <thead style={{ backgroundColor: "color-mix(in oklab, var(--muted) 92%, white)" }}>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    {["Field", "Meaning", "Usage"].map((label) => (
                      <th
                        key={label}
                        className="px-4 py-3 text-left font-mono font-semibold text-[11px] uppercase tracking-[0.08em]"
                        style={{ color: "var(--muted-foreground)" }}
                      >
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["stream", "Named collection of records", "Consent scope and query target"],
                    ["view", "Field projection over a stream", "Human-readable disclosure unit"],
                    ["grant", "Immutable consent artifact", "Server-authoritative authorization"],
                  ].map(([field, meaning, usage]) => (
                    <tr
                      key={field}
                      style={{ borderBottom: "1px solid var(--border)", backgroundColor: "var(--background)" }}
                    >
                      <td className="px-4 py-3 align-top">
                        <code className="font-mono text-xs">{field}</code>
                      </td>
                      <td className="px-4 py-3 align-top text-xs" style={{ color: "var(--muted-foreground)" }}>
                        {meaning}
                      </td>
                      <td className="px-4 py-3 align-top text-xs" style={{ color: "var(--muted-foreground)" }}>
                        {usage}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <blockquote
              className="m-0 border-l-2 px-4 py-4 text-sm leading-relaxed"
              style={{
                borderColor: "var(--human)",
                backgroundColor: "color-mix(in oklab, var(--human-wash) 82%, white)",
                color: "var(--foreground)",
              }}
            >
              PDPP separates authorization from collection. The grant is the portable consent primitive; collection is
              one mechanism for making data available.
            </blockquote>
          </div>
        </div>
      </div>

      <div className="mt-10">
        <RuleBlock>
          Docs do not get a separate aesthetic. Use the shared shell, muted technical surfaces, mono protocol facts, and
          the same light-only palette until dark mode is designed here explicitly.
        </RuleBlock>
      </div>
    </SectionWrap>
  );
}

// ─── Specimen switcher ───────────────────────────────────────────────────────

function SpecimenSwitcher<T>({
  specimens,
  render,
}: {
  specimens: { label: string; axes: string; data: T }[];
  render: (data: T) => React.ReactNode;
}) {
  const [active, setActive] = React.useState(0);
  // The active index is always driven by clicks on rendered buttons, so
  // `current` is guaranteed to exist at runtime. We narrow through an
  // explicit guard so `noUncheckedIndexedAccess` is satisfied without `!`.
  const current = specimens[active];
  if (!current) {
    return null;
  }
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {specimens.map((s, i) => (
          <button
            key={s.label}
            className="rounded px-2 py-1 text-xs transition-colors"
            style={{
              backgroundColor: i === active ? "var(--foreground)" : "var(--muted)",
              color: i === active ? "var(--background)" : "var(--muted-foreground)",
            }}
            onClick={() => setActive(i)}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="mb-4 font-mono text-xs" style={{ color: "var(--muted-foreground)", opacity: 0.6 }}>
        Axes: {current.axes}
      </div>
      {render(current.data)}
    </div>
  );
}

// ─── Consent Card specimens ─────────────────────────────────────────────────
// Coverage: all 18 ConsentCard axes across 6 specimens

const CONSENT_SPECIMENS: { label: string; axes: string; data: ConsentCardProps }[] = [
  {
    // Axes: 1=continuous, 2=research, 4=delete, 5=present, 6=date, 7=mixed, 13=verified, 15=present, 16=present, 17=multiple
    label: "Planning (baseline)",
    axes: "continuous, planning, verified, retention:delete, expiry, optional stream, commitments",
    data: {
      requester: { name: "Longview", monogram: "LV", verified: true },
      purpose:
        "Longview is requesting compensation records to compare salary, equity, benefits, and tax tradeoffs before a career move.",
      commitments: [
        "Analysis stays inside this planning workspace",
        "No employer outreach or document sharing without separate approval",
      ],
      streams: [
        {
          key: "pay_statements",
          label: "Pay statements",
          detail:
            "Employer, pay period, gross pay, and net pay. No bank account details, home address, or tax ID fragments.",
        },
        {
          key: "equity_grants",
          label: "Equity grants",
          detail:
            "Grant type, quantity, vesting start, and vesting schedule. No brokerage account numbers or beneficiary details.",
        },
      ],
      optional: {
        key: "benefits_enrollments",
        label: "Benefits enrollments",
        detail: "Plan name, coverage tier, and employer contribution. No dependent details, claims, or provider notes.",
        consequenceOn: "Improves plan comparison and exposes coverage tradeoffs.",
        consequenceOff: "Turned off. The rest of the grant is unaffected.",
      },
      accessMode: "continuous",
      technical: { clientId: "longview_planning_v1", purposeCode: "planning", grantExpires: "Apr 15, 2027" },
    },
  },
  {
    // Axes: 1=single_use, 2=personalization, 6=null(no expiry), 7=all required, 8=time_range, 15=absent, 17=single stream
    label: "Single use, no expiry",
    axes: "single_use, personalization, no expiry, no optional, time_range, no commitments, single stream",
    data: {
      requester: { name: "Concert Finder", monogram: "CF", verified: true },
      purpose: "Concert Finder wants your top artists to recommend upcoming shows near you.",
      commitments: [],
      streams: [
        {
          key: "top_artists",
          label: "Your top artists",
          detail:
            "Artist names, genres, and popularity scores from the last 6 months. No listening timestamps or play counts.",
        },
      ],
      accessMode: "single_use",
      technical: { clientId: "concert_finder", purposeCode: "personalization", grantExpires: "No expiry" },
    },
  },
  {
    // Axes: 2=ai_training(#3), 4=anonymize, 12=present, 13=unverified, 14=logo suppressed
    label: "AI training, unverified",
    axes: "ai_training (explicit consent), unverified client, retention:anonymize, continuous",
    data: {
      requester: { name: "DataCo ML Pipeline", monogram: "DC", verified: false },
      purpose: "DataCo ML Pipeline wants to use your social media data to train recommendation models.",
      commitments: ["Model weights only, raw data not retained"],
      streams: [
        {
          key: "posts",
          label: "Your posts",
          detail: "Post captions, dates, and engagement metrics. No private messages or stories.",
        },
        { key: "following", label: "Who you follow", detail: "Account IDs and usernames. No DMs or profile details." },
      ],
      accessMode: "continuous",
      technical: { clientId: "dataco_ml_v2", purposeCode: "ai_training", grantExpires: "Jan 1, 2028" },
    },
  },
  {
    // Axes: 2=export, 4=absent(no retention), 5=absent, 15=absent, 16=absent(no purpose_description)
    label: "Self-export, minimal",
    axes: "export, single_use, no retention, no commitments, no purpose_description fallback",
    data: {
      requester: { name: "PDPP Export Tool", monogram: "PE", verified: true },
      purpose: "Export your data for personal use.",
      commitments: [],
      streams: [
        {
          key: "following",
          label: "Who you follow",
          detail: "Complete following list with account IDs and usernames.",
        },
        {
          key: "posts",
          label: "Your posts",
          detail: "All post data including captions, dates, media types, and locations.",
        },
        {
          key: "ad_targeting",
          label: "Ad interest categories",
          detail: "Full ad targeting profile with categories, sources, and confidence scores.",
        },
      ],
      accessMode: "single_use",
      technical: { clientId: "pdpp_export", purposeCode: "export", grantExpires: "24 hours" },
    },
  },
  {
    // Axes: 2=agent_context, 1=continuous, 6=null, 17=single, 12=absent(client_display missing, fall back to client_id)
    label: "AI agent, no display",
    axes: "agent_context, continuous, no expiry, no client_display (client_id fallback)",
    data: {
      requester: { name: "agt_personal_v3", monogram: "AG", verified: false },
      purpose: "Requesting ongoing access to provide personalized context to your AI agent.",
      commitments: ["Data processed locally, never sent to external servers"],
      streams: [
        {
          key: "messages",
          label: "Your messages",
          detail: "Message content, timestamps, and participants. Includes DMs.",
        },
      ],
      accessMode: "continuous",
      technical: { clientId: "agt_personal_v3", purposeCode: "agent_context", grantExpires: "No expiry" },
    },
  },
  {
    // Axes: 2=analytics, 8=since+until, 18=profile used
    label: "Analytics, time-bounded",
    axes: "analytics, single_use, time_range with since+until, profile-based",
    data: {
      requester: { name: "Sleep Insights", monogram: "SI", verified: true },
      purpose: "Sleep Insights wants to analyze your sleep data from Q1 2026 to identify patterns.",
      commitments: ["Analysis results shared back with you", "Raw data deleted after analysis completes"],
      streams: [
        {
          key: "sleep_sessions",
          label: "Sleep sessions",
          detail: "Sleep duration, scores, and stage breakdowns for Jan-Mar 2026. No heart rate or HRV data.",
        },
      ],
      accessMode: "single_use",
      technical: { clientId: "sleep_insights_v1", purposeCode: "analytics", grantExpires: "7 days" },
    },
  },
];

// ─── Grant Inspector specimens ──────────────────────────────────────────────
// Coverage: axes 19 (status), 20 (consumed), plus grant-specific field combos

const GRANT_SPECIMENS: { label: string; axes: string; data: GrantInspectorProps }[] = [
  {
    label: "Active, continuous",
    axes: "active, continuous, retention:delete, view + fields, time_range",
    data: {
      grantId: "grt_8f3a2b1c",
      issuedAt: "Apr 6, 2026",
      status: "active",
      client: { clientId: "longview_planning_v1", name: "Longview" },
      purposeCode: "planning",
      purposeDescription: "Career-move compensation planning",
      accessMode: "continuous",
      expiresAt: "Apr 15, 2027",
      retention: { duration: "90 days", onExpiry: "delete" },
      streams: [
        {
          name: "pay_statements",
          label: "Pay statements",
          detail:
            "Employer, pay period, gross pay, and net pay. No bank account details, home address, or tax ID fragments.",
          view: "summary",
          fields: ["employer", "pay_period", "gross_pay", "net_pay"],
          timeRange: { since: "Jan 1, 2025" },
        },
        {
          name: "equity_grants",
          label: "Equity grants",
          detail:
            "Grant type, quantity, vesting start, and vesting schedule. No brokerage account numbers or beneficiary details.",
          view: "vesting_summary",
          fields: ["grant_type", "quantity", "vesting_start", "vesting_schedule"],
        },
      ],
    },
  },
  {
    label: "Expired",
    axes: "expired, single_use, no retention, no view (all fields)",
    data: {
      grantId: "grt_a1b2c3d4",
      issuedAt: "Mar 1, 2026",
      status: "expired",
      client: { clientId: "concert_finder", name: "Concert Finder" },
      purposeCode: "personalization",
      purposeDescription: "Concert recommendations",
      accessMode: "single_use",
      expiresAt: "Mar 2, 2026",
      streams: [
        { name: "top_artists", label: "Your top artists", detail: "Artist names, genres, and popularity scores." },
      ],
    },
  },
  {
    label: "Revoked",
    axes: "revoked, continuous, retention:anonymize, no expiry",
    data: {
      grantId: "grt_rev0ked1",
      issuedAt: "Jan 15, 2026",
      status: "revoked",
      client: { clientId: "dataco_ml_v2", name: "DataCo ML Pipeline" },
      purposeCode: "ai_training",
      purposeDescription: "Recommendation model training",
      accessMode: "continuous",
      expiresAt: null,
      retention: { duration: "6 months", onExpiry: "anonymize" },
      streams: [
        { name: "posts", label: "Your posts", fields: ["id", "caption", "taken_at", "media_type"] },
        { name: "following_accounts", label: "Who you follow", fields: ["id", "username"] },
      ],
    },
  },
  {
    label: "Single use, all fields",
    axes: "active, single_use, no fields (all authorized), time_range since+until",
    data: {
      grantId: "grt_sleep001",
      issuedAt: "Apr 1, 2026",
      status: "active",
      client: { clientId: "sleep_insights_v1", name: "Sleep Insights" },
      purposeCode: "analytics",
      purposeDescription: "Q1 2026 sleep pattern analysis",
      accessMode: "single_use",
      expiresAt: "Apr 8, 2026",
      retention: { duration: "30 days", onExpiry: "delete" },
      streams: [
        {
          name: "sleep_sessions",
          label: "Sleep sessions",
          detail: "Sleep duration, scores, and stage breakdowns.",
          timeRange: { since: "Jan 1, 2026", until: "Apr 1, 2026" },
        },
      ],
    },
  },
];

// ─── Stream Inventory specimens ──────────────────────────────────────────────
// Coverage: axes 21-27 (semantics, consent_time_field, selection caps, views, sync state, counts)

const INVENTORY_SPECIMENS: { label: string; axes: string; data: StreamInventoryProps }[] = [
  {
    label: "Instagram (populated)",
    axes: "mutable_state + append_only, all synced, nonzero counts",
    data: {
      connectorName: "Instagram",
      connectorVersion: "1.2.0",
      streams: [
        {
          name: "following_accounts",
          label: "Who you follow",
          detail: "Usernames and account IDs of accounts you follow. No DMs, profile details, or follower lists.",
          semantics: "mutable_state",
          recordCount: 106,
          lastSynced: "Apr 6, 2026",
        },
        {
          name: "posts",
          label: "Your posts",
          detail: "Post captions, dates, and media types. No comments, likes, or private messages.",
          semantics: "append_only",
          recordCount: 22,
          lastSynced: "Apr 6, 2026",
        },
        {
          name: "ad_targeting",
          label: "Ad interest categories",
          detail: "Ad categories, sources, and confidence scores. No browsing history or purchase data.",
          semantics: "mutable_state",
          recordCount: 47,
          lastSynced: "Apr 6, 2026",
        },
      ],
    },
  },
  {
    label: "Spotify (fresh)",
    axes: "append_only dominant, one never synced, zero count stream",
    data: {
      connectorName: "Spotify",
      connectorVersion: "2.0.0",
      streams: [
        {
          name: "top_artists",
          label: "Your top artists",
          detail: "Artist names, genres, and popularity scores. No listening timestamps or play counts.",
          semantics: "mutable_state",
          recordCount: 48,
          lastSynced: "Apr 5, 2026",
        },
        {
          name: "play_events",
          label: "Play history",
          detail: "Track plays with timestamps and durations. No skip or repeat data.",
          semantics: "append_only",
          recordCount: 1243,
          lastSynced: "Apr 5, 2026",
        },
        {
          name: "saved_tracks",
          label: "Saved tracks",
          detail: "Tracks in your library with save dates.",
          semantics: "mutable_state",
          recordCount: 0,
        },
      ],
    },
  },
  {
    label: "Oura (single stream)",
    axes: "single stream, append_only only, never synced",
    data: {
      connectorName: "Oura Ring",
      connectorVersion: "1.0.0",
      streams: [
        {
          name: "sleep_sessions",
          label: "Sleep sessions",
          detail: "Sleep duration, scores, and stage breakdowns. No heart rate or HRV data.",
          semantics: "append_only",
          recordCount: 0,
        },
      ],
    },
  },
];

// ─── Connector Card specimens ───────────────────────────────────────────────
// Axes: connector_id, display_name, version, stream count, semantics mix,
//       selection capabilities (fields/resources/time_range), views, profiles

const CONNECTOR_SPECIMENS: { label: string; axes: string; data: ConnectorCardProps }[] = [
  {
    label: "Instagram (full)",
    axes: "multiple streams, mixed semantics, fields+time_range, views, no profiles",
    data: {
      connectorId: "https://registry.pdpp.org/connectors/instagram",
      displayName: "Instagram",
      version: "1.2.0",
      streams: [
        {
          name: "following_accounts",
          label: "Who you follow",
          semantics: "mutable_state",
          supportsFields: true,
          supportsResources: false,
          supportsTimeRange: false,
          viewCount: 2,
        },
        {
          name: "posts",
          label: "Your posts",
          semantics: "append_only",
          supportsFields: true,
          supportsResources: false,
          supportsTimeRange: true,
          viewCount: 2,
        },
        {
          name: "ad_targeting",
          label: "Ad interest categories",
          semantics: "mutable_state",
          supportsFields: true,
          supportsResources: false,
          supportsTimeRange: false,
          viewCount: 1,
        },
      ],
    },
  },
  {
    label: "Spotify (with profiles)",
    axes: "profiles present, resources supported, many views",
    data: {
      connectorId: "https://registry.pdpp.org/connectors/spotify",
      displayName: "Spotify",
      version: "2.0.0",
      streams: [
        {
          name: "top_artists",
          label: "Your top artists",
          semantics: "mutable_state",
          supportsFields: true,
          supportsResources: false,
          supportsTimeRange: true,
          viewCount: 2,
        },
        {
          name: "play_events",
          label: "Play history",
          semantics: "append_only",
          supportsFields: true,
          supportsResources: false,
          supportsTimeRange: true,
          viewCount: 0,
        },
        {
          name: "saved_tracks",
          label: "Saved tracks",
          semantics: "mutable_state",
          supportsFields: true,
          supportsResources: true,
          supportsTimeRange: false,
          viewCount: 1,
        },
        {
          name: "playlists",
          label: "Playlists",
          semantics: "mutable_state",
          supportsFields: true,
          supportsResources: true,
          supportsTimeRange: true,
          viewCount: 2,
        },
      ],
      profiles: [
        { id: "listening_history", label: "Listening history", streamCount: 2 },
        { id: "library", label: "Full library", streamCount: 3 },
      ],
    },
  },
  {
    label: "Oura (minimal)",
    axes: "single stream, no views, no profiles, no resources, append_only only",
    data: {
      connectorId: "https://registry.pdpp.org/connectors/oura",
      displayName: "Oura Ring",
      version: "1.0.0",
      streams: [
        {
          name: "sleep_sessions",
          label: "Sleep sessions",
          semantics: "append_only",
          supportsFields: true,
          supportsResources: false,
          supportsTimeRange: true,
          viewCount: 0,
        },
      ],
    },
  },
  {
    label: "Gmail (no labels)",
    axes: "no display.label (falls back to stream name), mixed capabilities",
    data: {
      connectorId: "https://registry.pdpp.org/connectors/gmail",
      displayName: "Gmail",
      version: "1.0.0",
      streams: [
        {
          name: "messages",
          semantics: "append_only",
          supportsFields: true,
          supportsResources: true,
          supportsTimeRange: true,
          viewCount: 3,
        },
        {
          name: "contacts",
          semantics: "mutable_state",
          supportsFields: true,
          supportsResources: true,
          supportsTimeRange: false,
          viewCount: 1,
        },
        {
          name: "labels",
          semantics: "mutable_state",
          supportsFields: false,
          supportsResources: false,
          supportsTimeRange: false,
          viewCount: 0,
        },
      ],
    },
  },
];

// ─── Spec Citation specimens ────────────────────────────────────────────────
// Axes: single vs group, with/without href, different section depths

const CITATION_SPECIMENS: { label: string; axes: string; data: { citations: SpecCitationProps[] } }[] = [
  {
    label: "Single citation",
    axes: "single, no href",
    data: { citations: [{ section: "5", label: "Selection Request" }] },
  },
  {
    label: "Citation with link",
    axes: "single, with href",
    data: { citations: [{ section: "6", label: "Grant", href: "/spec-core#grant" }] },
  },
  {
    label: "Citation group",
    axes: "multiple citations, mixed href",
    data: {
      citations: [
        { section: "5", label: "Selection Request", href: "/spec-core#selection-request" },
        { section: "6", label: "Grant" },
        { section: "7", label: "Manifest Format", href: "/spec-core#manifest-format" },
      ],
    },
  },
  {
    label: "Deep section refs",
    axes: "subsection numbers, Appendix",
    data: {
      citations: [
        { section: "5.1", label: "Client Display" },
        { section: "5.2", label: "Client Claims" },
        { section: "7.1", label: "Stream Display" },
        { section: "A", label: "Purpose Codes" },
      ],
    },
  },
  {
    label: "Consent flow citations",
    axes: "realistic grouping for consent card context",
    data: {
      citations: [
        { section: "5", label: "Selection Request" },
        { section: "6", label: "Grant" },
        { section: "A", label: "Purpose Codes" },
      ],
    },
  },
];

// ─── 10 Status ───────────────────────────────────────────────────────────────

function StatusSection() {
  return (
    <SectionWrap id="status">
      <SectionHeader
        title="Status Indicators"
        description="Inline patterns for communicating state. Consistent across all panels."
      />

      <div className="flex flex-col gap-12">
        <div>
          <SubLabel>Status dot</SubLabel>
          <div className="overflow-x-auto" style={{ borderTop: "1px solid var(--border)" }}>
            <table
              className="w-full"
              style={{ borderCollapse: "collapse", tableLayout: "fixed", minWidth: "320px", maxWidth: "600px" }}
            >
              <colgroup>
                <col style={{ width: "28px" }} />
                <col style={{ width: "160px" }} />
                <col style={{ width: "140px" }} />
                <col className="hidden md:table-column" />
              </colgroup>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {["", "State", "Token", "Usage"].map((h, i) => (
                    <th
                      key={h}
                      className={`pt-3 pr-6 pb-2 text-left text-xs font-medium${i === 3 ? "hidden md:table-cell" : ""}`}
                      style={{ color: "var(--muted-foreground)" }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  {
                    tokenVal: "--border",
                    label: "Offline / idle",
                    token: "--border",
                    usage: "Uninitiated, not started",
                  },
                  {
                    tokenVal: "--primary",
                    label: "Active / in progress",
                    token: "--primary",
                    usage: "Running, loading, processing",
                  },
                  {
                    tokenVal: "--success",
                    label: "Success / complete",
                    token: "--success",
                    usage: "Done, granted, synced",
                  },
                  {
                    tokenVal: "--warning",
                    label: "Warning / pending",
                    token: "--warning",
                    usage: "Pending review, attention needed",
                  },
                  {
                    tokenVal: "--destructive",
                    label: "Error",
                    token: "--destructive",
                    usage: "Failed, rejected, revoked",
                  },
                ].map(({ tokenVal, label, token, usage }) => (
                  <tr key={tokenVal}>
                    <td className="py-2.5 pr-3" style={{ verticalAlign: "middle" }}>
                      <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: `var(${tokenVal})` }} />
                    </td>
                    <td className="py-2.5 pr-6" style={{ verticalAlign: "baseline" }}>
                      <span className="text-xs">{label}</span>
                    </td>
                    <td className="py-2.5 pr-6" style={{ verticalAlign: "baseline" }}>
                      <code className="font-mono text-xs" style={{ color: "var(--muted-foreground)" }}>
                        {token}
                      </code>
                    </td>
                    <td className="hidden py-2.5 md:table-cell" style={{ verticalAlign: "baseline" }}>
                      <span className="text-xs" style={{ color: "var(--muted-foreground)" }}>
                        {usage}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <SubLabel>Spinner</SubLabel>
          <div className="flex items-center gap-4 rounded-lg px-5 py-4" style={{ border: "1px solid var(--border)" }}>
            <span
              className="h-4 w-4 shrink-0 rounded-full"
              style={{
                border: "2px solid var(--border)",
                borderTopColor: "var(--primary)",
                display: "inline-block",
                animation: "spin 0.8s linear infinite",
              }}
            />
            <code className="font-mono text-xs" style={{ color: "var(--muted-foreground)" }}>
              border: --border · borderTopColor: --primary · spin 0.8s linear
            </code>
          </div>
        </div>

        <div>
          <SubLabel>Spec citation</SubLabel>
          <div className="flex items-center gap-3 rounded-lg px-5 py-4" style={{ border: "1px solid var(--border)" }}>
            <a href="#" className="font-mono text-xs transition-colors" style={{ color: "var(--edu-fg)" }}>
              §4.2 Selection Request
            </a>
            <span style={{ color: "var(--muted-foreground)" }} className="text-xs">
              ·
            </span>
            <a href="#" className="font-mono text-xs transition-colors" style={{ color: "var(--edu-fg)" }}>
              §6.1 Stream Metadata
            </a>
            <code className="ml-auto font-mono text-xs" style={{ color: "var(--muted-foreground)" }}>
              color: --edu-fg · font-mono text-xs
            </code>
          </div>
        </div>
      </div>
    </SectionWrap>
  );
}

// ─── 11 Rules ────────────────────────────────────────────────────────────────

const RULE_GROUPS = [
  {
    label: "Color",
    rules: [
      { bad: "bg-green-500", good: "--success", why: "Raw palette class. Breaks when the theme changes." },
      { bad: "text-blue-600", good: "--primary", why: "Raw palette class. There is one blue in this system." },
      { bad: "color: '#187adc'", good: "var(--primary)", why: "Hardcoded hex. Add to :root if it doesn't exist." },
      {
        bad: "Multiple accent colors",
        good: "--primary + status tokens only",
        why: "One signature color. Everything else is neutral or a status.",
      },
    ],
  },
  {
    label: "Typography",
    rules: [
      {
        bad: "text-[13px]",
        good: "text-xs / text-sm",
        why: "Arbitrary size. Standard scale enforces rhythm across the system.",
      },
      { bad: "font-mono on UI copy", good: "font-sans", why: "Mono signals protocol data. UI copy is always sans." },
      {
        bad: "font-sans on IDs, stream names, spec refs",
        good: "font-mono",
        why: 'Mono signals "this came from the protocol." Never break this contract.',
      },
      {
        bad: "§ citation in non-mono",
        good: "font-mono + --edu-fg",
        why: "Spec citations are their own visual layer. Never styled as regular text.",
      },
    ],
  },
  {
    label: "Motion",
    rules: [
      {
        bad: "transition: all",
        good: "opacity, transform only",
        why: "Layout properties trigger reflow. GPU-composited properties only.",
      },
      {
        bad: "Animation without state change",
        good: "Motion earns its existence",
        why: "Every animation must answer: does this help the user understand what changed?",
      },
      {
        bad: "Per-component prefers-reduced-motion",
        good: ":root duration reset",
        why: "One rule in globals.css covers the entire system. No per-component overrides.",
      },
    ],
  },
  {
    label: "Tokens",
    rules: [
      {
        bad: "New token not on this page",
        good: "Add to :root + /design first",
        why: "If it isn't defined here, don't invent it in product code.",
      },
      {
        bad: "data-[attr] with no CSS rule",
        good: "Define semantic, then derive visual",
        why: "The attribute encodes what something is. CSS derives what it looks like. Never reverse this.",
      },
      {
        bad: "Inline opacity on muted-foreground",
        good: "Use the token as-is",
        why: "oklch(0.50 0 0) is already calibrated. Stacking opacity creates uncalibrated contrast.",
      },
    ],
  },
  {
    label: "Surface Temperature",
    rules: [
      {
        bad: "oklch(0.52 0.09 45) inline",
        good: "var(--human)",
        why: "Human color is a named token. Never hardcode it — the token carries the semantic meaning.",
      },
      {
        bad: "Warm tone on protocol data",
        good: "--human on identity/consent only",
        why: "Warm = person. If it's a token ID, stream name, or spec ref, it stays cool.",
      },
      {
        bad: "Cool tone on the person row",
        good: "--human on name, handle, owner",
        why: "Protocol blue on a person's name breaks the duality contract.",
      },
      {
        bad: "Temperature on neutral UI",
        good: "No temperature on structural chrome",
        why: "Headers, nav, and empty states have no owner — they are neutral. Adding temperature here dilutes the signal.",
      },
    ],
  },
  {
    label: "Docs",
    rules: [
      {
        bad: "Separate docs theme",
        good: "Reuse the PDPP shell",
        why: "Docs are part of the product. Their chrome, hero, and rail geometry come from the same system.",
      },
      {
        bad: "Dark mode before design",
        good: "Light only until specified here",
        why: "System dark mode is not a design spec. Unsupported themes create accidental UI.",
      },
      {
        bad: "Independent code-block palette",
        good: "Muted technical surfaces",
        why: "Reference-heavy content belongs inside the same muted light system as tables, prose, and support UI.",
      },
    ],
  },
];

function RulesSection() {
  return (
    <SectionWrap id="rules">
      <SectionHeader
        title="Rules"
        description="Hard constraints, not guidelines. Each exists because someone violated it. Check here before reaching for any custom value."
      />

      <div className="flex flex-col gap-10">
        {RULE_GROUPS.map(({ label, rules }) => (
          <div key={label}>
            <SubLabel>{label}</SubLabel>
            <div style={{ borderTop: "1px solid var(--border)" }}>
              {rules.map(({ bad, good, why }, i, arr) => (
                <div
                  key={bad}
                  className="py-3"
                  style={{
                    borderBottom:
                      i < arr.length - 1 ? "1px solid color-mix(in oklch, var(--border) 40%, transparent)" : "none",
                  }}
                >
                  <div className="mb-2 text-xs leading-relaxed" style={{ color: "var(--foreground)" }}>
                    {why}
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-8">
                    <div className="flex items-center gap-2">
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 10 10"
                        fill="none"
                        className="shrink-0 translate-y-px"
                        style={{ color: "var(--destructive)" }}
                      >
                        <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                      <code className="font-mono text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                        {bad}
                      </code>
                    </div>
                    <div className="flex items-center gap-2">
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 10 10"
                        fill="none"
                        className="shrink-0 translate-y-px"
                        style={{ color: "var(--success)" }}
                      >
                        <path
                          d="M1.5 5l2.5 2.5L8.5 2"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      <code className="font-mono text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                        {good}
                      </code>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </SectionWrap>
  );
}
