"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { CopyButton } from "../components/copy-button.tsx";
import { Callout, ToolbarField } from "../components/primitives.tsx";
import { createEnrollmentCodeAction } from "./actions.ts";

export function EnrollmentForm() {
  const [state, formAction, pending] = useActionState(createEnrollmentCodeAction, { ok: null });

  return (
    <Callout
      description="Creates a short-lived reference-experimental enrollment code for a local exporter agent. This is not a PDPP Core/Profile protocol control."
      surface="human"
      title="Create enrollment code"
    >
      <form action={formAction} className="grid gap-3 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end">
        <ToolbarField label="Connector id">
          <Input name="connector_id" placeholder="spotify" required />
        </ToolbarField>
        <ToolbarField label="Local binding">
          <Input name="local_binding_name" placeholder="personal-laptop" required />
        </ToolbarField>
        <ToolbarField label="Display name">
          <Input name="display_name" placeholder="the owner's laptop" />
        </ToolbarField>
        <input name="expires_in_seconds" type="hidden" value="900" />
        <Button disabled={pending} type="submit">
          {pending ? "Creating..." : "Create code"}
        </Button>
      </form>

      {state.ok === false ? <p className="pdpp-caption mt-3 text-destructive">{state.message}</p> : null}
      {state.ok === true ? (
        <div className="mt-4 rounded-md border border-border/80 bg-background/60 p-3">
          <div className="pdpp-eyebrow text-muted-foreground">Enrollment code</div>
          <div className="mt-1 flex min-w-0 items-center gap-2">
            <code className="pdpp-body min-w-0 break-all font-mono text-foreground">{state.code.enrollment_code}</code>
            <CopyButton ariaLabel="Copy enrollment code" value={state.code.enrollment_code} />
          </div>
          <p className="pdpp-caption mt-1 text-muted-foreground">Expires at {state.code.expires_at}</p>
        </div>
      ) : null}
    </Callout>
  );
}
