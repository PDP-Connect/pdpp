// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import Link from "next/link";
import type React from "react";
import { buttonVariants } from "@/components/ui/button.tsx";
import { cn } from "@/lib/utils.ts";
import { type CoverageState, type CoverageStatus, coverageRows, coverageSummary } from "./data.ts";

export const metadata: Metadata = {
  title: "Reference Coverage Matrix - PDPP",
  description:
    "A falsifiable public matrix for PDPP reference implementation coverage across protocol flows, retrieval extensions, collection profiles, sandbox, and deferred scope.",
};

const stateLabel: Record<CoverageState, string> = {
  yes: "Yes",
  partial: "Partial",
  no: "No",
  "not-applicable": "N/A",
};

const statusLabel: Record<CoverageStatus, string> = {
  implemented: "Implemented",
  partial: "Partial",
  deferred: "Deferred",
  planned: "Planned",
  "reference-only": "Reference-only",
};

const summaryItems = [
  { label: "Rows", value: coverageSummary.total.toString() },
  { label: "Implemented", value: coverageSummary.implemented.toString() },
  { label: "Partial", value: coverageSummary.partial.toString() },
  { label: "Deferred", value: coverageSummary.deferred.toString() },
  { label: "Planned", value: coverageSummary.planned.toString() },
] as const;

export default function ReferenceCoveragePage() {
  return (
    <main className="relative overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[26rem]"
        style={{
          background:
            "radial-gradient(circle at 18% 18%, oklch(0.58 0.172 253.7 / 0.14), transparent 32%), radial-gradient(circle at 78% 6%, oklch(0.72 0.11 45 / 0.13), transparent 34%)",
        }}
      />
      <div className="relative mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 lg:py-14">
        <section className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <div>
            <div className="pdpp-eyebrow text-muted-foreground">Reference implementation / Coverage honesty</div>
            <h1 className="pdpp-display mt-3 max-w-4xl text-foreground">Coverage matrix</h1>
            <p className="pdpp-body-lg mt-5 max-w-3xl text-muted-foreground">
              This matrix is a manually seeded public artifact. It distinguishes protocol specification, docs,
              executable reference behavior, tests, demonstration surfaces, and intentionally deferred scope.
            </p>
            <div className="mt-7 flex flex-wrap gap-2.5">
              <Link className={buttonVariants({ variant: "default", size: "lg" })} href="/reference">
                Reference explainer
              </Link>
              <Link className={buttonVariants({ variant: "outline", size: "lg" })} href="/sandbox">
                Open sandbox
              </Link>
              <Link className={buttonVariants({ variant: "outline", size: "lg" })} href="/docs">
                Protocol docs
              </Link>
            </div>
          </div>

          <aside className="rounded-2xl border bg-card/80 p-4 shadow-sm backdrop-blur">
            <div className="pdpp-eyebrow text-muted-foreground">Static check</div>
            <p className="pdpp-caption mt-2 text-muted-foreground">
              The data module validates evidence paths at import time. A row marked implemented, tested, or demonstrated
              must carry supporting links to docs, tests, routes, or source artifacts.
            </p>
            <div className="mt-5 grid grid-cols-2 gap-2">
              {summaryItems.map((item) => (
                <div className="rounded-xl border bg-background/70 p-3" key={item.label}>
                  <div className="pdpp-caption text-muted-foreground">{item.label}</div>
                  <div className="pdpp-title mt-1 text-foreground">{item.value}</div>
                </div>
              ))}
            </div>
          </aside>
        </section>

        <section className="mt-10 overflow-hidden rounded-2xl border bg-card/70 shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[74rem] border-collapse">
              <thead>
                <tr className="border-b bg-muted/45 text-left">
                  <HeaderCell>Concept / flow</HeaderCell>
                  <HeaderCell>Category</HeaderCell>
                  <HeaderCell>Specified</HeaderCell>
                  <HeaderCell>Documented</HeaderCell>
                  <HeaderCell>Implemented</HeaderCell>
                  <HeaderCell>Tested</HeaderCell>
                  <HeaderCell>Demonstrated</HeaderCell>
                  <HeaderCell>Status</HeaderCell>
                  <HeaderCell>Evidence</HeaderCell>
                </tr>
              </thead>
              <tbody>
                {coverageRows.map((row) => (
                  <tr className="border-b last:border-b-0" key={row.concept}>
                    <td className="max-w-[18rem] p-4 align-top">
                      <div className="pdpp-title text-foreground">{row.concept}</div>
                      <p className="pdpp-caption mt-2 text-muted-foreground">{row.notes}</p>
                    </td>
                    <td className="p-4 align-top">
                      <span className="pdpp-caption rounded-full border bg-background/70 px-2.5 py-1 text-muted-foreground">
                        {row.category}
                      </span>
                    </td>
                    <StateCell state={row.specified} />
                    <StateCell state={row.documented} />
                    <StateCell state={row.implemented} />
                    <StateCell state={row.tested} />
                    <StateCell state={row.demonstrated} />
                    <td className="p-4 align-top">
                      <StatusPill status={row.status} />
                    </td>
                    <td className="min-w-[15rem] p-4 align-top">
                      <ul className="space-y-1.5">
                        {row.evidence.map((evidence) => (
                          <li key={`${row.concept}-${evidence.href}`}>
                            <EvidenceLink href={evidence.href}>{evidence.label}</EvidenceLink>
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}

function HeaderCell({ children }: { children: React.ReactNode }) {
  return <th className="pdpp-caption whitespace-nowrap p-4 font-medium text-muted-foreground">{children}</th>;
}

function StateCell({ state }: { state: CoverageState }) {
  return (
    <td className="p-4 align-top">
      <span
        className={cn(
          "pdpp-caption rounded-full border px-2.5 py-1",
          state === "yes" &&
            "border-[color:oklch(0.62_0.13_145/0.35)] bg-[color:oklch(0.62_0.13_145/0.12)] text-foreground",
          state === "partial" &&
            "border-[color:oklch(0.72_0.11_45/0.35)] bg-[color:oklch(0.72_0.11_45/0.13)] text-foreground",
          state === "no" && "border-border bg-muted/40 text-muted-foreground",
          state === "not-applicable" && "border-dashed bg-background/60 text-muted-foreground"
        )}
      >
        {stateLabel[state]}
      </span>
    </td>
  );
}

function StatusPill({ status }: { status: CoverageStatus }) {
  return (
    <span
      className={cn(
        "pdpp-caption rounded-full border px-2.5 py-1",
        status === "implemented" &&
          "border-[color:oklch(0.62_0.13_145/0.35)] bg-[color:oklch(0.62_0.13_145/0.12)] text-foreground",
        status === "partial" &&
          "border-[color:oklch(0.58_0.172_253.7/0.35)] bg-[color:oklch(0.58_0.172_253.7/0.12)] text-foreground",
        status === "deferred" &&
          "border-[color:oklch(0.72_0.11_45/0.35)] bg-[color:oklch(0.72_0.11_45/0.13)] text-foreground",
        status === "planned" && "border-dashed bg-background/60 text-muted-foreground",
        status === "reference-only" && "border-border bg-muted/45 text-foreground"
      )}
    >
      {statusLabel[status]}
    </span>
  );
}

function EvidenceLink({ href, children }: { href: string; children: React.ReactNode }) {
  const external = href.startsWith("http");
  const className =
    "pdpp-caption text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground";

  if (external) {
    return (
      <a className={className} href={href}>
        {children}
      </a>
    );
  }

  return (
    <Link className={className} href={href}>
      {children}
    </Link>
  );
}
