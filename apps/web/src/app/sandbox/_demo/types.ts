/**
 * Public types for the sandbox demo dataset and response builders.
 *
 * Shapes are inspired by the live reference server (see
 * `apps/web/src/app/dashboard/lib/ref-client.ts`) but are deliberately
 * simplified for a deterministic, fictional, public demo. They are not the
 * normative protocol contract — that lives in `openspec/specs/**` and
 * `spec-*.md`.
 */

export interface DemoFieldDef {
  readonly description: string;
  readonly name: string;
  /** Coarse semantic class label, mirroring the spec's three-class trust model. */
  readonly semantic_class: "common" | "sensitive" | "identifying";
  readonly type: "string" | "number" | "boolean" | "timestamp" | "currency_minor_units";
}

export interface DemoStreamDef {
  readonly connector_id: string;
  readonly description: string;
  readonly fields: readonly DemoFieldDef[];
  readonly key: string;
  readonly label: string;
  /** ISO timestamp seeded so list/detail responses are deterministic. */
  readonly latest_record_time: string;
  readonly retention_label: string;
}

export interface DemoConnectorDef {
  readonly connector_id: string;
  readonly description: string;
  readonly display_name: string;
  /** Provenance: native to the reference, or supplied by the polyfill registry. */
  readonly provenance: "native" | "polyfill-registered";
  readonly provider_id: string;
  readonly schedule: string | null;
  readonly streams: readonly string[];
}

export interface DemoRecord {
  readonly connector_id: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly ingested_at: string;
  readonly record_id: string;
  readonly record_time: string;
  readonly stream: string;
}

export interface DemoTimelineEvent {
  readonly client_id: string | null;
  readonly data: Readonly<Record<string, unknown>>;
  readonly event_id: string;
  readonly event_type: string;
  readonly grant_id: string | null;
  readonly object_type: string | null;
  readonly occurred_at: string;
  readonly run_id: string | null;
  readonly status: string | null;
  readonly trace_id: string;
}

export interface DemoGrantDef {
  readonly client_id: string;
  readonly connector_id: string;
  readonly events: readonly DemoTimelineEvent[];
  readonly fields: readonly string[];
  readonly first_at: string;
  readonly grant_id: string;
  readonly last_at: string;
  /** Indicates the grant story (issued, revoked, denied). */
  readonly status: "issued" | "revoked" | "denied";
  readonly stream: string;
  readonly trace_id: string;
}

export interface DemoRunDef {
  readonly connector_id: string;
  readonly events: readonly DemoTimelineEvent[];
  readonly failure_reason: string | null;
  readonly finished_at: string | null;
  readonly first_at: string;
  readonly grant_id: string | null;
  readonly last_at: string;
  readonly needs_input: boolean;
  readonly run_id: string;
  readonly started_at: string;
  /** "succeeded", "failed", "needs_input", or "started". */
  readonly status: "succeeded" | "failed" | "needs_input" | "started";
}

export interface DemoTraceDef {
  readonly client_id: string | null;
  readonly events: readonly DemoTimelineEvent[];
  readonly failure_reason: string | null;
  readonly first_at: string;
  readonly grant_id: string | null;
  readonly kinds: readonly string[];
  readonly last_at: string;
  readonly run_id: string | null;
  readonly status: string;
  readonly trace_id: string;
}

export interface DemoClientDef {
  readonly client_id: string;
  readonly client_uri: string;
  readonly display_name: string;
  readonly logo_initials: string;
  readonly policy_uri: string;
  readonly tos_uri: string;
  /** Whether the demo treats this client as registry-verified. */
  readonly verified: boolean;
}

export interface DemoCapabilityDef {
  /** Public concept name from the protocol or the reference. */
  readonly capability: string;
  /** Whether the demo instance demonstrates this capability today. */
  readonly demonstrated_in_demo: boolean;
  readonly description: string;
  /** Whether the live reference server implements it. */
  readonly implemented: boolean;
  readonly notes: string;
}
