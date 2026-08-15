// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton, IcInput } from "@pdpp/brand-react";
import { StatusBadge } from "@pdpp/operator-ui/components/primitives";
import type { StatusVocabulary } from "@pdpp/operator-ui/components/status-vocabularies";
import type { ProviderAppConfigGroup } from "../../lib/ref-client.ts";

const FIELD_STATUS_VOCABULARY: StatusVocabulary = {
  configured: { label: "Configured", tone: "success" },
  missing: { label: "Missing", tone: "warning" },
};

// One field within a group's single form. Only `label` is ever rendered — the
// field's underlying logical key travels as part of the input `name` so the
// action can address it on submit, but no env-var name or stored value
// reaches this component at all (the ref-client response never carries
// either). Leaving the input blank on an already-configured field means
// "keep the existing value" — the placeholder says so explicitly, and the
// input has no `defaultValue`, so a stored value is never round-tripped into
// the DOM for the owner (or anyone reading a page source dump) to see.
function FieldInput({ field }: { field: ProviderAppConfigGroup["fields"][number] }) {
  return (
    <label className="grid min-w-0 gap-1" htmlFor={`field-${field.logical_key}`}>
      <span className="pdpp-eyebrow inline-flex flex-wrap items-baseline gap-x-2">
        {field.label}
        <StatusBadge inline status={field.configured ? "configured" : "missing"} vocabulary={FIELD_STATUS_VOCABULARY} />
      </span>
      <IcInput
        autoComplete="off"
        className="w-full"
        id={`field-${field.logical_key}`}
        name={`field_${field.logical_key}`}
        placeholder={field.configured ? "Leave blank to keep the current value" : "Enter value"}
        type={field.secret ? "password" : "text"}
      />
    </label>
  );
}

// One form per identity group, submitted atomically. First setup and later
// rotation are the same form: on first setup the owner fills in every field;
// on rotation, blank fields keep their existing stored value and only the
// fields the owner actually typed into are replaced.
//
// `group.identity_group` (the opaque manifest grouping token) travels ONLY as
// the hidden input's `value` — required so the server action can address
// which group to write — and as the React `key` on the outer list item in
// page.tsx. It must never appear in this component's visible text content.
// `group.provider_identity_label` is the only group-level copy ever
// rendered. See identity-display.test.ts for the rendered-DOM proof.
//
// `action` is injected rather than importing `setProviderAppConfigAction`
// directly: that action lives in a `"use server"` module which transitively
// imports `server-only` (via owner-token.ts), so importing it here would
// make this component unrenderable outside a Next.js server runtime —
// including in identity-display.test.ts, which renders this component for
// real with `react-dom/server`.
export function GroupForm({
  action,
  group,
}: {
  action: (formData: FormData) => void | Promise<void>;
  group: ProviderAppConfigGroup;
}) {
  const allConfigured = group.fields.every((field) => field.configured);
  return (
    <div className="rounded-md border border-border" data-surface="human">
      <div className="border-border/70 border-b px-5 py-3">
        <h2 className="pdpp-eyebrow">{group.provider_identity_label}</h2>
      </div>
      <form action={action} className="grid gap-4 p-5">
        <input name="identity_group" type="hidden" value={group.identity_group} />
        <div className="grid gap-4 sm:grid-cols-2">
          {group.fields.map((field) => (
            <FieldInput field={field} key={field.logical_key} />
          ))}
        </div>
        <div>
          <IcButton size="sm" type="submit" variant={allConfigured ? "ghost" : "human"}>
            {allConfigured ? "Update" : "Save"}
          </IcButton>
        </div>
      </form>
    </div>
  );
}
