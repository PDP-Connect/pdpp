// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { formatConnectorKeyForDisplay, formatSourceForDisplay, type SourceDisplayInput } from "./connector-display.ts";

export interface RunLabelInput {
  connector_id?: string | null;
  provider_id?: string | null;
  source?: SourceDisplayInput | null;
}

export interface TraceLabelInput {
  client?: ClientDisplayInput | null;
  client_id?: string | null;
  kinds?: string[] | null;
  provider_id?: string | null;
  source?: SourceDisplayInput | null;
}

export interface GrantLabelInput {
  client?: ClientDisplayInput | null;
  client_id?: string | null;
  connector_id?: string | null;
  provider_id?: string | null;
  source?: SourceDisplayInput | null;
}

export interface ClientDisplayInput {
  client_name?: string | null;
}

function clean(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function sourceConnectorLabel(source: SourceDisplayInput | null | undefined): string {
  if (!source) {
    return "";
  }
  const label = formatSourceForDisplay(source);
  const colon = label.indexOf(":");
  return colon >= 0 ? clean(label.slice(colon + 1)) : clean(label);
}

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

export function traceRowLabel(trace: TraceLabelInput): string {
  const fromSource = sourceConnectorLabel(trace.source);
  if (fromSource && fromSource !== "-") {
    return fromSource;
  }
  const provider = clean(trace.provider_id);
  if (provider) {
    return formatConnectorKeyForDisplay(provider);
  }
  const clientName = clean(trace.client?.client_name);
  if (clientName) {
    return clientName;
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

export function grantRowLabel(grant: GrantLabelInput): string {
  const fromSource = sourceConnectorLabel(grant.source);
  if (fromSource && fromSource !== "-") {
    return fromSource;
  }
  const connector = clean(grant.connector_id);
  if (connector) {
    return formatConnectorKeyForDisplay(connector);
  }
  const clientName = clean(grant.client?.client_name);
  if (clientName) {
    return clientName;
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
