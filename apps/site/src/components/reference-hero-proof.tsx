// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { LongviewWordmark } from "@/components/longview-wordmark.tsx";
import { LONGVIEW_PURPOSE_DESCRIPTION } from "@/lib/longview-world.ts";

export function ReferenceHeroProof() {
  return (
    <div className="w-full max-w-5xl">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.02fr)_minmax(0,0.98fr)]">
        <section className="overflow-hidden rounded-xl" data-surface="human">
          <div className="px-5 py-5 md:px-6 md:py-6">
            <div className="pdpp-eyebrow" style={{ color: "var(--authorship-manifest-fg)", marginBottom: "0.75rem" }}>
              Consent surface
            </div>
            <div style={{ marginBottom: "0.9rem" }}>
              <LongviewWordmark compact />
            </div>
            <p className="pdpp-body" style={{ color: "var(--muted-foreground)", maxWidth: "44ch" }}>
              It requests pay statements and equity grants for a career-move review. Approve four pay-statement fields.
              The response drops the identity-heavy payroll fields.
            </p>

            <div className="mt-5 border-t" style={{ borderColor: "var(--border)" }}>
              {[
                ["Purpose", LONGVIEW_PURPOSE_DESCRIPTION],
                ["Access", "Continuous"],
                ["Decision", "Approve 4 payroll fields"],
              ].map(([label, value]) => (
                <div
                  className="flex items-center justify-between gap-4 py-3"
                  key={label}
                  style={{ borderBottom: "1px solid var(--border)" }}
                >
                  <span className="pdpp-label" style={{ color: "var(--muted-foreground)" }}>
                    {label}
                  </span>
                  <span className="font-medium text-sm" style={{ color: "var(--foreground)" }}>
                    {value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="overflow-hidden rounded-xl" data-surface="protocol">
          <div className="px-5 py-5 md:px-6 md:py-6">
            <div className="pdpp-eyebrow" style={{ color: "var(--authorship-protocol-fg)", marginBottom: "0.75rem" }}>
              Grant + response
            </div>
            <pre
              className="text-xs leading-6 md:text-sm"
              style={{
                margin: 0,
                color: "var(--foreground)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {`grant.fields = [
  "employer",
  "pay_period",
  "gross_pay",
  "net_pay"
]

GET /v1/records/pay_statements
→ 4 of 8 fields returned`}
            </pre>
            <p className="pdpp-caption" style={{ color: "var(--muted-foreground)", marginTop: "1rem" }}>
              The grant is the boundary. The response matches it.
            </p>
          </div>
        </section>
      </div>

      <div
        className="mt-4 flex flex-wrap items-center gap-2 text-xs md:text-sm"
        style={{ color: "var(--muted-foreground)" }}
      >
        <span className="pdpp-label" style={{ color: "var(--foreground)" }}>
          8 fields on the record
        </span>
        <span aria-hidden="true">→</span>
        <span className="pdpp-label" style={{ color: "var(--human)" }}>
          4 fields approved
        </span>
        <span aria-hidden="true">→</span>
        <span className="pdpp-label" style={{ color: "var(--primary)" }}>
          4 fields returned
        </span>
      </div>
    </div>
  );
}
