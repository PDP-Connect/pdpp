// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export interface CanonicalTerminalFactInput {
  readonly coverage_statuses: readonly string[];
  readonly scoped?: boolean;
  readonly stream: string;
}

export interface TerminalRunCommitEnvelopeInput {
  readonly collection_boundary: string;
  readonly commit_id: string;
  readonly connector_id: string;
  readonly connector_instance_id: string;
  readonly device_id: string;
  readonly run_id: string;
  readonly source_instance_id: string;
  readonly state_delta: Readonly<Record<string, unknown>>;
  readonly terminal_facts: readonly CanonicalTerminalFactInput[];
  readonly version: 1;
}

/**
 * The one hash-authority projection shared by collector and reference server.
 * Connector identity MUST already be canonical before entry.
 */
export function canonicalTerminalRunCommitEnvelope(input: TerminalRunCommitEnvelopeInput): unknown {
  return canonicalValue({
    collection_boundary: input.collection_boundary,
    commit_id: input.commit_id,
    connector_id: input.connector_id,
    connector_instance_id: input.connector_instance_id,
    device_id: input.device_id,
    run_id: input.run_id,
    source_instance_id: input.source_instance_id,
    state_delta: input.state_delta,
    terminal_facts: input.terminal_facts
      .map((fact) => ({
        coverage_statuses: [...new Set(fact.coverage_statuses)].sort(),
        ...(typeof fact.scoped === "boolean" ? { scoped: fact.scoped } : {}),
        stream: fact.stream,
      }))
      .sort((left, right) => left.stream.localeCompare(right.stream)),
    version: 1,
  });
}

export function canonicalTerminalRunCommitJson(input: TerminalRunCommitEnvelopeInput): string {
  return JSON.stringify(canonicalTerminalRunCommitEnvelope(input));
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) {
      canonical[key] = canonicalValue(item);
    }
  }
  return canonical;
}
