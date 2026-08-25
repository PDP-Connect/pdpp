"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton, IcInput } from "@pdpp/brand-react";
import { Section } from "@pdpp/operator-ui/components/primitives";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, useTransition } from "react";
import { confirmConfigAction, proposeConfigAction } from "./config-actions.ts";
import {
  buildCurrentSettings,
  buildDraft,
  buildHistory,
  buildProposalConfig,
  type ConfigDraft,
  type ConfigFieldChange,
  type ConfigOptionWire,
  type ConfigRevisionWire,
  type ConfigValue,
  type ConnectionConfigWire,
  confirmationReason,
  describeCommit,
  diffDraft,
  findPendingProposal,
  optionLabel,
  parseStaleConflict,
  reasonError,
  resolveAvailability,
  setDraftValue,
  unchangedCount,
  validateDraft,
} from "./connection-config-view-model.ts";

interface Props {
  /** Live config read: active revision, schema, and the base a propose echoes. */
  config: ConnectionConfigWire;
  /** The connection this editor writes to. */
  connectionId: string;
  /** Route id, for revalidation after a write. */
  connectorId: string;
  /** The attributed ledger, for the history timeline. */
  revisions: readonly ConfigRevisionWire[];
}

/**
 * The owner's configuration surface for one connection.
 *
 * Three steps, and only the third talks to the server:
 *
 *   1. `summary` / `edit` — read current settings, change a local draft.
 *   2. `review`           — see changed fields and give a reason. STILL LOCAL.
 *   3. commit             — one POST, whose persisted answer is then rendered.
 *
 * Step 2 is the one that must not write. A pure-transport bundle SELF-ACTIVATES
 * on propose, so a "preview" that hit the API would apply the owner's edit
 * before they agreed to it. Every value on the review screen therefore comes
 * from `diffDraft`/`describeCommit`, which are pure functions over data already
 * in memory. `connection-config-view-model.ts` imports nothing, so this is a
 * property of the module graph, not a promise in a comment.
 */
type Step = "edit" | "review" | "summary";

export function ConnectionConfiguration({ config, connectionId, connectorId, revisions }: Props) {
  const availability = useMemo(() => resolveAvailability(config), [config]);

  if (availability.kind === "not_declared") {
    return (
      <ConfigShell>
        <p className="pdpp-caption text-muted-foreground">{availability.message}</p>
        <HistoryBlock activeRevision={config.active_revision} revisions={revisions} schema={null} />
      </ConfigShell>
    );
  }

  if (availability.kind === "unreadable") {
    return (
      <ConfigShell>
        <div className="pdpp-caption rounded-md border border-destructive/30 bg-destructive/5 px-4 py-2.5">
          <span className="font-medium text-destructive">{availability.message}</span>
        </div>
        <TechnicalDetails>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">Connector</dt>
            <dd className="font-mono">{config.connector_key}</dd>
            <dt className="text-muted-foreground">Schema status</dt>
            <dd className="font-mono">{config.options_schema_status}</dd>
          </dl>
        </TechnicalDetails>
      </ConfigShell>
    );
  }

  if (availability.kind === "empty") {
    return (
      <ConfigShell>
        <p className="pdpp-caption text-muted-foreground">
          This connector has described its settings and has none to change.
        </p>
        <HistoryBlock activeRevision={config.active_revision} revisions={revisions} schema={availability.schema} />
      </ConfigShell>
    );
  }

  return (
    <ConfigEditor
      config={config}
      connectionId={connectionId}
      connectorId={connectorId}
      revisions={revisions}
      schema={availability.schema}
    />
  );
}

function ConfigShell({ children }: { children: React.ReactNode }) {
  return (
    <Section description="What this source collects, and how collection runs." id="configuration" title="Configuration">
      <div className="flex flex-col gap-4">{children}</div>
    </Section>
  );
}

function ConfigEditor({
  config,
  connectionId,
  connectorId,
  revisions,
  schema,
}: Props & { schema: NonNullable<ConnectionConfigWire["options_schema"]> }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("summary");
  const [draft, setDraft] = useState<ConfigDraft>(() => buildDraft(schema, config.active_revision));
  const [reason, setReason] = useState("");
  const [showReasonError, setShowReasonError] = useState(false);
  const [isPending, startTransition] = useTransition();
  /** A revision the server actually persisted, awaiting owner confirmation. */
  const [persisted, setPersisted] = useState<ConfigRevisionWire | null>(null);
  const [stale, setStale] = useState<{ actualRevision: number | null; message: string } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [applied, setApplied] = useState<ConfigRevisionWire | null>(null);

  const currentSettings = useMemo(
    () => buildCurrentSettings(schema, config.active_revision),
    [schema, config.active_revision]
  );
  // Pure. No request is made to compute what the owner is about to review.
  const changes = useMemo(
    () => diffDraft(schema, config.active_revision, draft),
    [schema, config.active_revision, draft]
  );
  const commit = useMemo(() => describeCommit(changes), [changes]);
  const fieldErrors = useMemo(() => validateDraft(schema, draft), [schema, draft]);
  const hasFieldErrors = Object.keys(fieldErrors).length > 0;
  const pending = useMemo(() => persisted ?? findPendingProposal(revisions), [persisted, revisions]);

  const resetToSummary = useCallback(() => {
    setStep("summary");
    setReason("");
    setShowReasonError(false);
    setFailure(null);
  }, []);

  const onCommit = useCallback(() => {
    if (reasonError(reason) !== null) {
      setShowReasonError(true);
      return;
    }
    setFailure(null);
    setStale(null);
    startTransition(async () => {
      const result = await proposeConfigAction({
        baseEpoch: config.base_epoch,
        baseRevision: config.base_revision,
        config: buildProposalConfig(changes),
        connectionId,
        connectorId,
        sourceOfChange: reason,
      });
      if (result.ok === false) {
        if (result.failure === "stale") {
          // The owner's draft is deliberately preserved. Never merged.
          setStale(parseStaleConflict(result.message));
          return;
        }
        setFailure(result.message);
        return;
      }
      // Render what the SERVER stored, never the local prediction.
      if (result.revision.status === "active") {
        setApplied(result.revision);
        setPersisted(null);
        resetToSummary();
      } else {
        setPersisted(result.revision);
        setStep("summary");
        setReason("");
      }
      router.refresh();
    });
  }, [changes, config.base_epoch, config.base_revision, connectionId, connectorId, reason, resetToSummary, router]);

  const onConfirm = useCallback(
    (revision: number) => {
      setFailure(null);
      startTransition(async () => {
        const result = await confirmConfigAction({ connectionId, connectorId, revision });
        if (result.ok === false) {
          setFailure(result.message);
          return;
        }
        setApplied(result.revision);
        setPersisted(null);
        setDraft(buildDraft(schema, result.revision));
        router.refresh();
      });
    },
    [connectionId, connectorId, router, schema]
  );

  const reviewAgainstLatest = useCallback(() => {
    // Explicit rebase: re-read the server's current configuration and re-review.
    // The draft survives; nothing is merged on the owner's behalf.
    setStale(null);
    setStep("review");
    router.refresh();
  }, [router]);

  return (
    <ConfigShell>
      {applied ? (
        <div className="pdpp-caption rounded-md border border-emerald-500/30 bg-emerald-500/5 px-4 py-2.5">
          <span className="font-medium text-emerald-700 dark:text-emerald-400">
            Revision {applied.revision} is active. Future syncs use this configuration.
          </span>
        </div>
      ) : null}

      {failure ? (
        <div className="pdpp-caption rounded-md border border-destructive/30 bg-destructive/5 px-4 py-2.5">
          <span className="font-medium text-destructive">{failure}</span>
        </div>
      ) : null}

      {stale ? (
        <div className="pdpp-caption flex flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-2.5">
          <span className="font-medium text-amber-700 dark:text-amber-400">{stale.message}</span>
          <span className="text-muted-foreground">
            Your edits are still here. Review them against the latest configuration before saving.
          </span>
          <div>
            <IcButton onClick={reviewAgainstLatest} size="sm" type="button">
              Review against latest
            </IcButton>
          </div>
        </div>
      ) : null}

      {pending ? (
        <PendingProposal isPending={isPending} onConfirm={onConfirm} revision={pending} schema={schema} />
      ) : null}

      {step === "summary" ? (
        <CurrentSettings onEdit={() => setStep("edit")} revision={config.active_revision} rows={currentSettings} />
      ) : null}

      {step === "edit" ? (
        <DraftEditor
          draft={draft}
          errors={fieldErrors}
          onCancel={() => {
            setDraft(buildDraft(schema, config.active_revision));
            resetToSummary();
          }}
          onChange={(key, value) => setDraft((prev) => setDraftValue(prev, key, value))}
          onReview={() => setStep("review")}
          reviewDisabled={changes.length === 0 || hasFieldErrors}
          schema={schema}
        />
      ) : null}

      {step === "review" ? (
        <ReviewChanges
          changes={changes}
          commit={commit}
          isPending={isPending}
          onBack={() => setStep("edit")}
          onCommit={onCommit}
          reason={reason}
          reasonMessage={showReasonError ? reasonError(reason) : null}
          setReason={setReason}
          unchanged={unchangedCount(schema, changes)}
        />
      ) : null}

      <HistoryBlock activeRevision={config.active_revision} revisions={revisions} schema={schema} />
    </ConfigShell>
  );
}

function CurrentSettings({
  onEdit,
  revision,
  rows,
}: {
  onEdit: () => void;
  revision: ConfigRevisionWire | null;
  rows: ReturnType<typeof buildCurrentSettings>;
}) {
  const groups = groupRows(rows);
  return (
    <div className="flex flex-col gap-4">
      {groups.map(([group, rowsInGroup]) => (
        <div className="flex flex-col gap-1" key={group.id}>
          <h3 className="pdpp-body font-medium text-foreground">{group.title}</h3>
          <p className="pdpp-caption text-muted-foreground">{group.description}</p>
          <dl className="mt-1 flex flex-col gap-1">
            {rowsInGroup.map((row) => (
              <div className="flex flex-wrap items-baseline justify-between gap-2" key={row.optionKey}>
                <dt className="pdpp-caption text-foreground">{row.label}</dt>
                <dd className="pdpp-caption flex items-baseline gap-2">
                  <span className="text-foreground">{row.valueLabel}</span>
                  <span className="text-muted-foreground/70">{row.provenanceLabel}</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      {revision ? (
        <p className="pdpp-caption text-muted-foreground">
          Last changed by {revision.origin === "owner" ? "you" : "an app"} — “{revision.source_of_change}”
        </p>
      ) : (
        <p className="pdpp-caption text-muted-foreground">
          No owner-set configuration yet. These are the connector's own defaults.
        </p>
      )}
      <div>
        <IcButton onClick={onEdit} size="sm" type="button">
          Edit configuration
        </IcButton>
      </div>
    </div>
  );
}

function DraftEditor({
  draft,
  errors,
  onCancel,
  onChange,
  onReview,
  reviewDisabled,
  schema,
}: {
  draft: ConfigDraft;
  errors: Record<string, string>;
  onCancel: () => void;
  onChange: (key: string, value: ConfigValue) => void;
  onReview: () => void;
  reviewDisabled: boolean;
  schema: NonNullable<ConnectionConfigWire["options_schema"]>;
}) {
  // `null` here asks only for the schema's grouping and order, not for values:
  // every control below binds to `draft`, which was already seeded from the
  // active revision. Passing the revision again would change nothing rendered.
  const groups = groupRows(buildCurrentSettings(schema, null));
  return (
    <div className="flex flex-col gap-4 rounded-md border border-border p-4">
      {groups.map(([group, rowsInGroup]) => (
        <fieldset className="flex flex-col gap-3" key={group.id}>
          <legend className="pdpp-body font-medium text-foreground">{group.title}</legend>
          <p className="pdpp-caption text-muted-foreground">{group.description}</p>
          {rowsInGroup.map((row) => (
            <OptionControl
              error={errors[row.optionKey] ?? null}
              key={row.optionKey}
              onChange={(value) => onChange(row.optionKey, value)}
              option={row.option}
              value={draft[row.optionKey] ?? row.option.default}
            />
          ))}
        </fieldset>
      ))}
      <div className="flex flex-wrap gap-2">
        <IcButton disabled={reviewDisabled} onClick={onReview} size="sm" type="button">
          Review changes
        </IcButton>
        <IcButton onClick={onCancel} size="sm" type="button" variant="ghost">
          Cancel
        </IcButton>
      </div>
    </div>
  );
}

/**
 * One schema-driven control.
 *
 * The control is chosen from the declared type, and the raw option key is never
 * the visible label — it stays under Technical details. Bounds and allowed
 * values are stated in plain words next to the field so a value is rejected
 * before it can reach the append-only ledger.
 */
function OptionControl({
  error,
  onChange,
  option,
  value,
}: {
  error: string | null;
  onChange: (value: ConfigValue) => void;
  option: ConfigOptionWire;
  value: ConfigValue;
}) {
  const label = optionLabel(option.option_key);
  const gate = confirmationReason(option);
  const controlId = `config-${option.option_key}`;
  return (
    <div className="flex flex-col gap-1">
      {option.type === "boolean" ? (
        <label className="pdpp-caption flex items-center gap-2 text-foreground" htmlFor={controlId}>
          <input checked={value === true} id={controlId} onChange={(e) => onChange(e.target.checked)} type="checkbox" />
          <span>{label}</span>
        </label>
      ) : (
        <label className="pdpp-caption flex flex-col gap-1 text-foreground" htmlFor={controlId}>
          <span>{label}</span>
          <ValueControl controlId={controlId} onChange={onChange} option={option} value={value} />
        </label>
      )}
      <p className="pdpp-caption text-muted-foreground">{option.description}</p>
      {option.type === "integer" && (option.minimum !== null || option.maximum !== null) ? (
        <p className="pdpp-caption text-muted-foreground/70">
          {option.minimum ?? "any"}–{option.maximum ?? "any"}
        </p>
      ) : null}
      {gate ? <p className="pdpp-caption text-muted-foreground/70">{gate}</p> : null}
      {error ? <p className="pdpp-caption text-destructive">{error}</p> : null}
    </div>
  );
}

interface ControlProps {
  controlId: string;
  onChange: (value: ConfigValue) => void;
  option: ConfigOptionWire;
  value: ConfigValue;
}

/**
 * Dispatch to the control the declared type calls for.
 *
 * A closed set of shapes, chosen once: a bounded integer, a single choice, a
 * multiple choice, and free text. An enum-less array falls through to the
 * comma-separated text field, which is the only honest control when the
 * connector has not said what the allowed values are.
 */
function ValueControl(props: ControlProps) {
  const { option } = props;
  if (option.type === "integer") {
    return <IntegerControl {...props} />;
  }
  const hasChoices = Boolean(option.enum && option.enum.length > 0);
  if (option.type === "string" && hasChoices) {
    return <ChoiceControl {...props} />;
  }
  if (option.type === "string_array" && hasChoices) {
    return <MultiChoiceControl {...props} />;
  }
  return <TextControl {...props} />;
}

function IntegerControl({ controlId, onChange, option, value }: ControlProps) {
  return (
    <IcInput
      className="w-40"
      id={controlId}
      max={option.maximum ?? undefined}
      min={option.minimum ?? undefined}
      onChange={(e) => onChange(Number(e.target.value))}
      type="number"
      value={String(value)}
    />
  );
}

function ChoiceControl({ controlId, onChange, option, value }: ControlProps) {
  return (
    <select
      className="w-full max-w-md rounded-md border border-border bg-background px-2 py-1"
      id={controlId}
      onChange={(e) => onChange(e.target.value)}
      value={String(value)}
    >
      {(option.enum ?? []).map((choice) => (
        <option key={choice} value={choice}>
          {choice}
        </option>
      ))}
    </select>
  );
}

function MultiChoiceControl({ onChange, option, value }: ControlProps) {
  const selected = Array.isArray(value) ? (value as readonly string[]) : [];
  return (
    <span className="flex flex-wrap gap-3">
      {(option.enum ?? []).map((choice) => (
        <label className="flex items-center gap-1.5" key={choice}>
          <input
            checked={selected.includes(choice)}
            onChange={(e) =>
              onChange(e.target.checked ? [...selected, choice] : selected.filter((entry) => entry !== choice))
            }
            type="checkbox"
          />
          <span>{choice}</span>
        </label>
      ))}
    </span>
  );
}

function TextControl({ controlId, onChange, option, value }: ControlProps) {
  return (
    <IcInput
      className="w-full max-w-md"
      id={controlId}
      onChange={(e) => onChange(option.type === "string_array" ? splitCommaSeparated(e.target.value) : e.target.value)}
      value={Array.isArray(value) ? (value as readonly string[]).join(", ") : String(value)}
    />
  );
}

function splitCommaSeparated(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Step 2. Local only.
 *
 * Everything here is computed from the draft already in memory. There is no
 * fetch, no action, and no server round trip — see the module header for why
 * that is load-bearing rather than incidental.
 */
function ReviewChanges({
  changes,
  commit,
  isPending,
  onBack,
  onCommit,
  reason,
  reasonMessage,
  setReason,
  unchanged,
}: {
  changes: readonly ConfigFieldChange[];
  commit: ReturnType<typeof describeCommit>;
  isPending: boolean;
  onBack: () => void;
  onCommit: () => void;
  reason: string;
  reasonMessage: string | null;
  setReason: (value: string) => void;
  unchanged: number;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-md border border-border p-4">
      <div className="flex flex-col gap-2">
        <h3 className="pdpp-body font-medium text-foreground">What changes</h3>
        {changes.map((change) => (
          <div className="flex flex-col gap-0.5" key={change.optionKey}>
            <span className="pdpp-caption text-foreground">{change.label}</span>
            <span className="pdpp-caption text-muted-foreground">
              <span>{change.currentLabel}</span>
              <span aria-hidden className="mx-2">
                →
              </span>
              <span className="text-foreground">{change.proposedLabel}</span>
            </span>
          </div>
        ))}
        {unchanged > 0 ? (
          <p className="pdpp-caption text-muted-foreground/70">
            {unchanged} unchanged {unchanged === 1 ? "setting" : "settings"}
          </p>
        ) : null}
      </div>

      <p className="pdpp-caption text-muted-foreground">{commit.supportingText}</p>

      <label className="pdpp-caption flex flex-col gap-1 text-foreground" htmlFor="config-reason">
        <span>Why are you changing this?</span>
        <IcInput
          className="w-full max-w-md"
          id="config-reason"
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Include the project launch period"
          value={reason}
        />
      </label>
      {reasonMessage ? <p className="pdpp-caption text-destructive">{reasonMessage}</p> : null}

      <div className="flex flex-wrap gap-2">
        <IcButton onClick={onBack} size="sm" type="button" variant="ghost">
          Back to edit
        </IcButton>
        <IcButton disabled={isPending} onClick={onCommit} size="sm" type="button">
          {isPending ? "Saving…" : commit.buttonLabel}
        </IcButton>
      </div>
    </div>
  );
}

/**
 * A proposal the server has actually stored.
 *
 * Rendered from the persisted revision's own `config`, not from any local
 * draft, so the owner confirms exactly what was written.
 */
function PendingProposal({
  isPending,
  onConfirm,
  revision,
  schema,
}: {
  isPending: boolean;
  onConfirm: (revision: number) => void;
  revision: ConfigRevisionWire;
  schema: NonNullable<ConnectionConfigWire["options_schema"]>;
}) {
  const byKey = new Map(schema.options.map((option) => [option.option_key, option]));
  const proposedBy = revision.origin === "owner" ? "you" : "an app";
  return (
    <div className="flex flex-col gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-4">
      <div className="flex flex-col gap-0.5">
        <h3 className="pdpp-body font-medium text-amber-700 dark:text-amber-400">Awaiting your confirmation</h3>
        <p className="pdpp-caption text-muted-foreground">
          Revision {revision.revision}, proposed by {proposedBy}. Nothing changes until you confirm.
        </p>
      </div>
      <dl className="flex flex-col gap-1">
        {Object.keys(revision.config)
          .sort()
          .map((key) => {
            const option = byKey.get(key);
            const raw = revision.config[key];
            return (
              <div className="flex flex-wrap items-baseline justify-between gap-2" key={key}>
                <dt className="pdpp-caption text-foreground">{optionLabel(key)}</dt>
                <dd className="pdpp-caption text-foreground">{option ? formatWireValue(option, raw) : String(raw)}</dd>
              </div>
            );
          })}
      </dl>
      <p className="pdpp-caption text-muted-foreground">Reason: “{revision.source_of_change}”</p>
      <div>
        <IcButton disabled={isPending} onClick={() => onConfirm(revision.revision)} size="sm" type="button">
          {isPending ? "Confirming…" : "Confirm and make active"}
        </IcButton>
      </div>
    </div>
  );
}

function HistoryBlock({
  activeRevision,
  revisions,
  schema,
}: {
  activeRevision: ConfigRevisionWire | null;
  revisions: readonly ConfigRevisionWire[];
  schema: ConnectionConfigWire["options_schema"];
}) {
  const entries = useMemo(
    () => buildHistory(revisions, schema, activeRevision?.revision ?? null),
    [revisions, schema, activeRevision]
  );
  if (entries.length === 0) {
    return <p className="pdpp-caption text-muted-foreground">No configuration changes have been recorded yet.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <h3 className="pdpp-body font-medium text-foreground">History</h3>
      <ol className="flex flex-col gap-3">
        {entries.map((entry) => (
          <li className="flex flex-col gap-0.5" key={entry.revision.revision}>
            <span className="pdpp-caption font-medium text-foreground">{entry.statusLabel}</span>
            <span className="pdpp-caption text-foreground">{entry.summary}</span>
            <span className="pdpp-caption text-muted-foreground">Reason: “{entry.reason}”</span>
            <span className="pdpp-caption text-muted-foreground/70">{entry.attribution}</span>
          </li>
        ))}
      </ol>
      <TechnicalDetails>
        <ul className="flex flex-col gap-2">
          {entries.map((entry) => (
            <li className="font-mono" key={entry.revision.revision}>
              rev {entry.revision.revision} · {entry.revision.status} · {entry.revision.option_kind} ·{" "}
              {entry.revision.origin} · set_by {entry.revision.set_by} · {entry.revision.set_at}
              {entry.revision.confirmed_by ? ` · confirmed_by ${entry.revision.confirmed_by}` : ""}
              {entry.revision.collection_boundary_fingerprint
                ? ` · fingerprint ${entry.revision.collection_boundary_fingerprint}`
                : ""}
              {" · "}
              {entry.revision.config_contract_id}@{entry.revision.config_contract_version}
              <div>{JSON.stringify(entry.revision.config)}</div>
            </li>
          ))}
        </ul>
      </TechnicalDetails>
    </div>
  );
}

/** Exact machine evidence, never the default visible panel. */
function TechnicalDetails({ children }: { children: React.ReactNode }) {
  return (
    <details className="pdpp-caption">
      <summary className="cursor-pointer text-muted-foreground">Technical details</summary>
      <div className="mt-2 overflow-x-auto text-muted-foreground">{children}</div>
    </details>
  );
}

function formatWireValue(option: ConfigOptionWire, raw: unknown): string {
  if (option.type === "boolean") {
    return raw === true ? "On" : "Off";
  }
  if (Array.isArray(raw)) {
    return raw.length === 0 ? "None selected" : (raw as readonly string[]).join(", ");
  }
  return raw === "" ? "Not set" : String(raw);
}

function groupRows(rows: ReturnType<typeof buildCurrentSettings>) {
  const order = ["what_to_collect", "how_it_runs", "advanced"] as const;
  const buckets = new Map<string, [ReturnType<typeof buildCurrentSettings>[number]["group"], typeof rows]>();
  for (const row of rows) {
    const existing = buckets.get(row.group.id);
    if (existing) {
      existing[1].push(row);
    } else {
      buckets.set(row.group.id, [row.group, [row]]);
    }
  }
  return order.flatMap((id) => {
    const bucket = buckets.get(id);
    return bucket ? [bucket] : [];
  });
}
