"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton, IcInput } from "@pdpp/brand-react";
import { useRouter } from "next/navigation";
import { type SyntheticEvent, useState, useTransition } from "react";
import { type RunInteractionActionState, submitRunInteractionAction } from "./actions.ts";

interface InteractionField {
  format: "password" | "text";
  label: string | null;
  name: string;
  required: boolean;
}

interface Props {
  fields: InteractionField[];
  interactionId: string;
  kind: "credentials" | "otp" | "manual_action" | string;
  message: string;
  runId: string;
}

const INITIAL: RunInteractionActionState = { error: null, status: null };

export function RunInteractionForm({ runId, interactionId, kind, message, fields }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState<RunInteractionActionState>(INITIAL);

  function submitWithStatus(formData: FormData, status: "success" | "cancelled") {
    formData.set("status", status);
    formData.set("run_id", runId);
    formData.set("interaction_id", interactionId);
    startTransition(async () => {
      const next = await submitRunInteractionAction(INITIAL, formData);
      setState(next);
      if (!next.error) {
        router.refresh();
      }
    });
  }

  function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    submitWithStatus(formData, "success");
  }

  function handleCancel() {
    submitWithStatus(new FormData(), "cancelled");
  }

  const effectiveFields =
    kind === "otp" && fields.length === 0
      ? [{ format: "text" as const, label: "Code", name: "code", required: true }]
      : fields;
  const showFields = kind !== "manual_action" && effectiveFields.length > 0;
  const submitLabel = getSubmitLabel(kind);

  return (
    <form
      aria-label={`Answer interaction ${interactionId}`}
      autoComplete="off"
      className="mt-3 flex flex-col gap-3"
      // biome-ignore lint/performance/noJsxPropsBind: non-memoized, inline binding intentional
      onSubmit={handleSubmit}
    >
      <p className="pdpp-caption text-muted-foreground">{message}</p>
      {showFields ? (
        <div className="grid gap-2">
          {effectiveFields.map((field) => {
            const fieldId = `interaction-${interactionId}-${field.name}`;
            return (
              <label className="flex flex-col gap-1" htmlFor={fieldId} key={field.name}>
                <span className="pdpp-caption text-muted-foreground">
                  {field.label || field.name}
                  {field.required ? <span aria-hidden="true"> *</span> : null}
                </span>
                <IcInput
                  autoComplete="off"
                  id={fieldId}
                  name={field.name}
                  required={field.required}
                  spellCheck={false}
                  type={field.format === "password" ? "password" : "text"}
                />
              </label>
            );
          })}
        </div>
      ) : null}
      <p className="pdpp-caption text-muted-foreground">
        Values you submit here satisfy this run only. The reference server does not persist them as durable connector
        credentials, env vars, or timeline payloads.
      </p>
      {state.error ? (
        <p className="pdpp-caption text-destructive" role="alert">
          {state.error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <IcButton disabled={isPending} size="sm" type="submit">
          {isPending ? "Submitting…" : submitLabel}
        </IcButton>
        {/** biome-ignore lint/performance/noJsxPropsBind: non-memoized, inline binding intentional */}
        <IcButton disabled={isPending} onClick={handleCancel} size="sm" type="button" variant="ghost">
          Cancel interaction
        </IcButton>
      </div>
    </form>
  );
}

function getSubmitLabel(kind: Props["kind"]): string {
  if (kind === "manual_action") {
    return "I've completed this step — continue";
  }
  if (kind === "otp") {
    return "Submit code";
  }
  return "Submit credentials";
}
