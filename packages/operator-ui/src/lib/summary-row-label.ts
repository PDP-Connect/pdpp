/**
 * Derive the human-readable PRIMARY label for a run / trace / grant list row.
 *
 * The list rows used to lead with the raw artifact id (`run_1780463950373`)
 * in foreground weight and demote the connector/source to dim subtext — the
 * inverse of what an operator scans for. These helpers pick the meaningful
 * label (the connector/source, falling back to the client or kind) so the row
 * can lead with *what happened to whom* and demote the raw id to a monospace
 * lookup-key detail.
 *
 * Each helper returns a plain string and never the raw artifact id; the id is
 * rendered separately as secondary mono text.
 */

import {
  formatConnectorKeyForDisplay,
  formatSourceForDisplay,
  type SourceDisplayInput,
} from "./connector-display.ts";

interface RunLabelInput {
  connector_id?: string | null;
  provider_id?: string | null;
  source?: SourceDisplayInput | null;
}

interface TraceLabelInput {
  client_id?: string | null;
  kinds?: string[] | null;
  provider_id?: string | null;
  source?: SourceDisplayInput | null;
}

interface GrantLabelInput {
  client_id?: string | null;
  connector_id?: string | null;
  provider_id?: string | null;
  source?: SourceDisplayInput | null;
}

function clean(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Connector/source label for a source object, without the `kind:` prefix. */
function sourceConnectorLabel(source: SourceDisplayInput | null | undefined): string {
  if (!source) {
    return "";
  }
  // formatSourceForDisplay returns `connector:<key>` / `provider_native:<id>`.
  // The leading `kind:` is noise for a row headline; keep just the key.
  const label = formatSourceForDisplay(source);
  const colon = label.indexOf(":");
  return colon >= 0 ? clean(label.slice(colon + 1)) : clean(label);
}

/** Primary label for a connector-run row: connector name, never the run id. */
export function runRowLabel(run: RunLabelInput): string {
  const connector = clean(run.connector_id);
  if (connector) {
    return formatConnectorKeyForDisplay(connector);
  }
  const fromSource = sourceConnectorLabel(run.source);
  if (fromSource && fromSource !== "-") {
    return fromSource;
  }
  const provider = clean(run.provider_id);
  if (provider) {
    return `provider ${provider}`;
  }
  return "Run";
}

/** Primary label for a trace row: the source/connector, client, or kind. */
export function traceRowLabel(trace: TraceLabelInput): string {
  const fromSource = sourceConnectorLabel(trace.source);
  if (fromSource && fromSource !== "-") {
    return fromSource;
  }
  const provider = clean(trace.provider_id);
  if (provider) {
    return formatConnectorKeyForDisplay(provider);
  }
  const client = clean(trace.client_id);
  if (client) {
    return `client ${client}`;
  }
  const firstKind = (trace.kinds ?? []).map(clean).find(Boolean);
  if (firstKind) {
    return firstKind;
  }
  return "Trace";
}

/** Primary label for a grant row: the source/connector or the client. */
export function grantRowLabel(grant: GrantLabelInput): string {
  const fromSource = sourceConnectorLabel(grant.source);
  if (fromSource && fromSource !== "-") {
    return fromSource;
  }
  const connector = clean(grant.connector_id);
  if (connector) {
    return formatConnectorKeyForDisplay(connector);
  }
  const client = clean(grant.client_id);
  if (client) {
    return `client ${client}`;
  }
  const provider = clean(grant.provider_id);
  if (provider) {
    return `provider ${provider}`;
  }
  return "Grant";
}
