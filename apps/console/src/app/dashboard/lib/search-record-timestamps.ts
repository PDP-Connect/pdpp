export interface SearchTimestampMetadata {
  consent_time_field?: string | null;
  cursor_field?: string | null;
}

export interface SearchDisplayTimestamp {
  emittedAt: string;
  label: string;
  value: string;
}

const LOCAL_DEVICE_CONNECTOR_RE = /^local-device:([^:]+)(?::.*)?$/;
const UNDERSCORE_RE = /_/g;

export function searchTimestampMetadataKey(connectorId: string, stream: string): string {
  return `${connectorId}::${stream}`;
}

export function lookupSearchTimestampMetadata(
  metadataByKey: ReadonlyMap<string, SearchTimestampMetadata>,
  connectorId: string,
  stream: string
): SearchTimestampMetadata | null {
  const direct = metadataByKey.get(searchTimestampMetadataKey(connectorId, stream));
  if (direct) {
    return direct;
  }

  const localDeviceMatch = LOCAL_DEVICE_CONNECTOR_RE.exec(connectorId);
  if (!localDeviceMatch) {
    return null;
  }
  let decodedConnectorId: string;
  try {
    decodedConnectorId = decodeURIComponent(localDeviceMatch[1] ?? "");
  } catch {
    return null;
  }
  const decodedDirect = metadataByKey.get(searchTimestampMetadataKey(decodedConnectorId, stream));
  if (decodedDirect) {
    return decodedDirect;
  }
  const registrySuffix = `/connectors/${decodedConnectorId}::${stream}`;
  for (const [key, value] of metadataByKey) {
    if (key.endsWith(registrySuffix)) {
      return value;
    }
  }
  return null;
}

function humanizeFieldName(field: string): string {
  return field.replace(UNDERSCORE_RE, " ");
}

function pickDeclaredTimestamp(
  metadata: SearchTimestampMetadata | null | undefined,
  data: Record<string, unknown> | null | undefined
): { field: string; value: string } | null {
  if (!(metadata && data)) {
    return null;
  }
  const candidates = [metadata.consent_time_field, metadata.cursor_field].filter(
    (field, index, all): field is string =>
      typeof field === "string" && field.length > 0 && all.indexOf(field) === index
  );
  for (const field of candidates) {
    const value = data[field];
    if (typeof value === "string" && value.trim()) {
      return { field, value: value.trim() };
    }
  }
  return null;
}

export function pickSearchDisplayTimestamp({
  data,
  emittedAt,
  metadata,
}: {
  data: Record<string, unknown> | null | undefined;
  emittedAt: string;
  metadata: SearchTimestampMetadata | null | undefined;
}): SearchDisplayTimestamp {
  const semantic = pickDeclaredTimestamp(metadata, data);
  if (semantic) {
    return {
      emittedAt,
      label: humanizeFieldName(semantic.field),
      value: semantic.value,
    };
  }
  return { emittedAt, label: "emitted", value: emittedAt };
}
