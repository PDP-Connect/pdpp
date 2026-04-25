"use client";

import Link from "next/link";
import { useMemo, useReducer } from "react";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/utils.ts";
import {
  formatUsdCents,
  SANDBOX_CLIENT,
  SANDBOX_CONNECTOR,
  SANDBOX_GRANT,
  SANDBOX_OWNER,
  SANDBOX_RECORDS,
  SANDBOX_STREAM,
} from "./scenario.ts";
import {
  buildTranscript,
  INITIAL_STATE,
  PHASE_ORDER,
  phaseIndex,
  reduce,
  type SandboxAction,
  type SandboxPhase,
  type SandboxState,
  type TranscriptEntry,
} from "./state.ts";

const STEP_COPY: Record<Exclude<SandboxPhase, "initial">, { eyebrow: string; title: string; body: string }> = {
  requested: {
    eyebrow: "Step 1 of 4",
    title: "Quill Tax asks for scoped pay statements",
    body: "A fictional tax-prep app stages a request through the authorization endpoint. It names the streams, fields, and connector it needs, plus a short purpose and self-asserted commitments.",
  },
  granted: {
    eyebrow: "Step 2 of 4",
    title: "Sam approves a bounded grant",
    body: "The owner sees exactly what was asked for, prunes anything they don't want shared (no SSN, no bank number), and issues a single-use grant scoped to the requested fields.",
  },
  queried: {
    eyebrow: "Step 3 of 4",
    title: "Quill Tax reads only the granted fields",
    body: "The resource server projects records down to the granted fields and returns them to the client. Nothing outside the scope is reachable through this grant.",
  },
  revoked: {
    eyebrow: "Step 4 of 4",
    title: "Sam revokes; the next read is refused",
    body: "Revocation tears the grant down. Any further read attempt against the same grant id receives a 403 and a `grant_revoked` error code.",
  },
};

interface ButtonSpec {
  action: SandboxAction;
  hint: string;
  label: string;
  variant: "default" | "outline" | "destructive" | "ghost";
}

function nextActions(state: SandboxState): readonly ButtonSpec[] {
  switch (state.phase) {
    case "initial":
      return [
        {
          label: "Stage the request",
          action: { type: "request" },
          variant: "default",
          hint: "Simulates a client POST to /par with the proposed scope.",
        },
      ];
    case "requested":
      return [
        {
          label: "Approve as Sam",
          action: { type: "approve" },
          variant: "default",
          hint: "Issues a grant scoped to the listed fields only.",
        },
        {
          label: "Deny as Sam",
          action: { type: "deny" },
          variant: "outline",
          hint: "Sends the visitor back to the start. No grant is created.",
        },
      ];
    case "granted":
      return [
        {
          label: "Run the scoped query",
          action: { type: "query" },
          variant: "default",
          hint: "GETs records using the new grant; only granted fields come back.",
        },
        {
          label: "Revoke before any read",
          action: { type: "revoke" },
          variant: "destructive",
          hint: "Owner can revoke at any time, even before the client reads.",
        },
      ];
    case "queried":
      return [
        {
          label: "Revoke the grant",
          action: { type: "revoke" },
          variant: "destructive",
          hint: "Tears the grant down and refuses any further read.",
        },
      ];
    case "revoked":
      return [
        {
          label: "Reset and replay",
          action: { type: "reset" },
          variant: "outline",
          hint: "Clears all sandbox state and returns to step 0.",
        },
      ];
    default:
      return [];
  }
}

export function SandboxWalkthrough() {
  const [state, dispatch] = useReducer(reduce, INITIAL_STATE);
  const transcript = useMemo(() => buildTranscript(state), [state]);
  const actions = nextActions(state);
  const currentIndex = phaseIndex(state.phase);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      <ScenarioPane
        actions={actions}
        currentIndex={currentIndex}
        dispatch={dispatch}
        onReset={() => dispatch({ type: "reset" })}
        state={state}
      />
      <TranscriptPane state={state} transcript={transcript} />
    </div>
  );
}

function ScenarioPane({
  actions,
  currentIndex,
  dispatch,
  onReset,
  state,
}: {
  actions: readonly ButtonSpec[];
  currentIndex: number;
  dispatch: React.Dispatch<SandboxAction>;
  onReset: () => void;
  state: SandboxState;
}) {
  const stepCopy = state.phase === "initial" ? null : STEP_COPY[state.phase];

  return (
    <section className="rounded-2xl border bg-card/80 p-5 shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="pdpp-eyebrow rounded-full border bg-background px-2.5 py-1 text-muted-foreground">
            Simulated walkthrough
          </span>
          <span className="pdpp-caption text-muted-foreground">
            All data is fictional. Nothing leaves your browser.
          </span>
        </div>
        <Button onClick={onReset} size="xs" variant="ghost">
          Reset
        </Button>
      </header>

      <Stepper currentIndex={currentIndex} />

      <div className="mt-6 space-y-5">
        <ParticipantStrip />
        {stepCopy ? (
          <div className="rounded-xl border bg-background/70 p-4">
            <div className="pdpp-eyebrow text-muted-foreground">{stepCopy.eyebrow}</div>
            <h2 className="pdpp-title mt-1 text-foreground">{stepCopy.title}</h2>
            <p className="pdpp-body mt-2 text-muted-foreground">{stepCopy.body}</p>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed bg-background/60 p-4">
            <div className="pdpp-eyebrow text-muted-foreground">Start here</div>
            <h2 className="pdpp-title mt-1 text-foreground">A small, end-to-end PDPP story</h2>
            <p className="pdpp-body mt-2 text-muted-foreground">
              Press <span className="font-mono text-foreground">Stage the request</span> to begin. You'll play the
              fictional owner, Sam, deciding what Quill Tax can read from a simulated payroll connector.
            </p>
          </div>
        )}

        <ScopeCard state={state} />
        <RecordsCard state={state} />
        <ActionRow actions={actions} dispatch={dispatch} />
      </div>
    </section>
  );
}

function Stepper({ currentIndex }: { currentIndex: number }) {
  return (
    <ol className="mt-5 flex items-center gap-1.5">
      {PHASE_ORDER.map((phase, index) => {
        const reached = index <= currentIndex;
        const active = index === currentIndex;
        return (
          <li className="flex flex-1 items-center gap-1.5" key={phase}>
            <span
              aria-current={active ? "step" : undefined}
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full border font-medium text-[0.7rem] tabular-nums",
                reached
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-muted-foreground",
                active && "ring-2 ring-primary/30"
              )}
            >
              {index}
            </span>
            {index < PHASE_ORDER.length - 1 ? (
              <span
                aria-hidden="true"
                className={cn("h-px flex-1 rounded-full", reached ? "bg-primary/60" : "bg-border")}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function ParticipantStrip() {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <ParticipantCard
        eyebrow="Owner"
        primary={SANDBOX_OWNER.display}
        secondary="Decides what to share, can revoke at any time."
      />
      <ParticipantCard eyebrow="Client app" primary={SANDBOX_CLIENT.name} secondary={SANDBOX_CLIENT.purpose} />
      <ParticipantCard eyebrow="Connector" primary={SANDBOX_CONNECTOR.name} secondary={SANDBOX_CONNECTOR.notes} />
    </div>
  );
}

function ParticipantCard({ eyebrow, primary, secondary }: { eyebrow: string; primary: string; secondary: string }) {
  return (
    <div className="rounded-xl border bg-background/60 p-3">
      <div className="pdpp-eyebrow text-muted-foreground">{eyebrow}</div>
      <div className="pdpp-title mt-1 text-foreground">{primary}</div>
      <p className="pdpp-caption mt-1.5 text-muted-foreground">{secondary}</p>
    </div>
  );
}

function deriveScopeStatus(state: SandboxState): {
  label: string;
  tone: "success" | "destructive" | "neutral" | "muted";
} {
  if (state.phase === "revoked") {
    return { label: "Revoked", tone: "destructive" };
  }
  if (state.history.includes("granted")) {
    return { label: "Granted", tone: "success" };
  }
  if (state.history.includes("requested")) {
    return { label: "Pending owner decision", tone: "neutral" };
  }
  return { label: "Not requested yet", tone: "muted" };
}

function ScopeCard({ state }: { state: SandboxState }) {
  const approved = state.history.includes("granted");
  const revoked = state.phase === "revoked";
  const status = deriveScopeStatus(state);

  return (
    <div className="rounded-xl border bg-background/60 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="pdpp-eyebrow text-muted-foreground">Grant scope</div>
          <div className="pdpp-title mt-1 text-foreground">{SANDBOX_STREAM.label}</div>
        </div>
        <StatusPill label={status.label} tone={status.tone} />
      </div>
      <p className="pdpp-caption mt-2 text-muted-foreground">{SANDBOX_STREAM.detail}</p>
      <ul className="mt-3 flex flex-wrap gap-1.5">
        {SANDBOX_STREAM.fields.map((field) => (
          <li
            className={cn(
              "rounded-full border px-2 py-0.5 font-mono text-[0.7rem]",
              approved && !revoked
                ? "border-primary/40 bg-primary/10 text-foreground"
                : "border-border bg-background text-muted-foreground"
            )}
            key={field}
          >
            {field}
          </li>
        ))}
      </ul>
      <div className="mt-3 grid gap-1.5 text-[0.75rem] text-muted-foreground sm:grid-cols-2">
        <Detail label="Access mode" value={SANDBOX_GRANT.accessMode} />
        <Detail label="Purpose code" value={SANDBOX_GRANT.purposeCode} />
        <Detail label="Grant id" value={SANDBOX_GRANT.grantId} />
        <Detail label="Expires" value={SANDBOX_GRANT.expiresAt} />
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="pdpp-eyebrow text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
    </div>
  );
}

function RecordsCard({ state }: { state: SandboxState }) {
  if (state.recordsVisible) {
    return (
      <div className="rounded-xl border bg-background/60 p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="pdpp-eyebrow text-muted-foreground">Returned records (simulated)</div>
            <div className="pdpp-title mt-1 text-foreground">{SANDBOX_RECORDS.length} pay statements</div>
          </div>
          <StatusPill label="200 OK" tone="success" />
        </div>
        <table className="mt-3 w-full table-fixed text-left">
          <thead>
            <tr className="pdpp-eyebrow text-muted-foreground">
              <th className="py-1.5 font-medium">Period end</th>
              <th className="py-1.5 font-medium">Employer</th>
              <th className="py-1.5 text-right font-medium">Gross</th>
              <th className="py-1.5 text-right font-medium">Net</th>
            </tr>
          </thead>
          <tbody>
            {SANDBOX_RECORDS.map((record) => (
              <tr className="border-border/50 border-t text-foreground" key={record.recordId}>
                <td className="py-1.5 font-mono text-[0.78rem]">{record.period_end}</td>
                <td className="py-1.5 text-[0.82rem]">{record.employer}</td>
                <td className="py-1.5 text-right font-mono text-[0.78rem]">{formatUsdCents(record.gross_pay_cents)}</td>
                <td className="py-1.5 text-right font-mono text-[0.78rem]">{formatUsdCents(record.net_pay_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (state.phase === "revoked") {
    return (
      <div className="rounded-xl border border-[color:var(--destructive)]/30 bg-[color:var(--destructive)]/5 p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="pdpp-eyebrow text-[color:var(--destructive)]">Refused</div>
            <div className="pdpp-title mt-1 text-foreground">Next query returned 403 grant_revoked</div>
          </div>
          <StatusPill label="403 forbidden" tone="destructive" />
        </div>
        <p className="pdpp-caption mt-2 text-muted-foreground">
          The same grant id is no longer valid. Quill Tax would need to re-request and Sam would need to re-approve to
          read again. Inspect the JSON on the right for the exact refusal shape.
        </p>
      </div>
    );
  }

  if (state.phase === "granted") {
    return (
      <div className="rounded-xl border border-dashed bg-background/40 p-4">
        <div className="pdpp-eyebrow text-muted-foreground">Records pane</div>
        <p className="pdpp-caption mt-2 text-muted-foreground">
          Grant is live. Records will appear here after Quill Tax actually queries the resource server.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-dashed bg-background/40 p-4">
      <div className="pdpp-eyebrow text-muted-foreground">Records pane</div>
      <p className="pdpp-caption mt-2 text-muted-foreground">
        No grant yet, so no records to project. PDPP refuses unscoped reads by construction, not by convention.
      </p>
    </div>
  );
}

function ActionRow({ actions, dispatch }: { actions: readonly ButtonSpec[]; dispatch: React.Dispatch<SandboxAction> }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <Button key={action.label} onClick={() => dispatch(action.action)} size="sm" variant={action.variant}>
            {action.label}
          </Button>
        ))}
      </div>
      <ul className="pdpp-caption space-y-0.5 text-muted-foreground">
        {actions.map((action) => (
          <li key={action.label}>
            <span className="font-medium text-foreground">{action.label}.</span> {action.hint}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TranscriptPane({ state, transcript }: { state: SandboxState; transcript: readonly TranscriptEntry[] }) {
  return (
    <section className="rounded-2xl border bg-card/80 p-5 shadow-sm">
      <header className="flex items-center justify-between gap-3">
        <div>
          <div className="pdpp-eyebrow text-muted-foreground">Inspectable transcript</div>
          <h2 className="pdpp-title mt-1 text-foreground">API-shaped requests &amp; responses</h2>
        </div>
        <span className="pdpp-eyebrow rounded-full border bg-background px-2.5 py-1 text-muted-foreground">
          Simulated JSON
        </span>
      </header>
      <p className="pdpp-caption mt-2 text-muted-foreground">
        Each panel reveals as you advance the walkthrough. Shapes are representative of PDPP, not byte-for-byte from a
        live reference run. See <CodeLink href="/docs">/docs</CodeLink> for normative semantics.
      </p>

      <ol className="mt-4 space-y-3">
        {transcript.map((entry) => (
          <li key={entry.id}>
            <TranscriptCard entry={entry} highlighted={entry.id === state.phase} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function TranscriptCard({ entry, highlighted }: { entry: TranscriptEntry; highlighted: boolean }) {
  if (!entry.available) {
    return (
      <div className="rounded-xl border border-dashed bg-background/40 px-3 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <div className="pdpp-caption text-muted-foreground">{entry.label}</div>
          <span className="pdpp-eyebrow text-muted-foreground">Locked</span>
        </div>
      </div>
    );
  }

  return (
    <details
      className={cn(
        "group rounded-xl border bg-background/70 transition-colors",
        highlighted ? "border-primary/50 shadow-sm" : "border-border"
      )}
      open
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="pdpp-caption font-mono text-foreground">{entry.method}</span>
          <span className="pdpp-caption font-mono text-muted-foreground">{entry.endpoint}</span>
        </div>
        <span className="pdpp-eyebrow text-muted-foreground transition-transform group-open:rotate-90">▸</span>
      </summary>
      <div className="px-3 pb-3">
        <div className="pdpp-caption mb-1.5 text-muted-foreground">{entry.label}</div>
        <pre className="overflow-x-auto rounded-lg border bg-card p-3 font-mono text-[0.72rem] text-foreground leading-relaxed">
          {JSON.stringify(entry.body, null, 2)}
        </pre>
      </div>
    </details>
  );
}

function StatusPill({ label, tone }: { label: string; tone: "success" | "destructive" | "neutral" | "muted" }) {
  const className = cn(
    "pdpp-eyebrow inline-flex items-center rounded-full border px-2 py-0.5",
    tone === "success" && "border-[color:var(--success)]/40 bg-[color:var(--success)]/10 text-[color:var(--success)]",
    tone === "destructive" &&
      "border-[color:var(--destructive)]/40 bg-[color:var(--destructive)]/10 text-[color:var(--destructive)]",
    tone === "neutral" && "border-border bg-background text-foreground",
    tone === "muted" && "border-border bg-background text-muted-foreground"
  );
  return <span className={className}>{label}</span>;
}

function CodeLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      className={cn(
        "font-mono text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
      )}
      href={href}
    >
      {children}
    </Link>
  );
}
