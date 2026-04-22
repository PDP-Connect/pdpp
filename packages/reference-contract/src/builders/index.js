// Thin, boring URL / body builders used by the CLI, dashboard, tests, and
// future agent-facing tooling.

function isPresent(value) {
  return value !== undefined && value !== null && value !== '';
}

function normalizeStringList(value) {
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((entry) => String(entry ?? '').split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function compactObject(input) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => isPresent(value) && (!Array.isArray(value) || value.length > 0))
  );
}

export function buildExpandParams(params = {}) {
  const expand = Array.from(new Set(normalizeStringList(params.expand)));
  const expandLimitInput = params.expand_limit && typeof params.expand_limit === 'object'
    ? params.expand_limit
    : {};
  const expand_limit = compactObject(expandLimitInput);
  return compactObject({
    expand: expand.length ? expand : undefined,
    expand_limit: Object.keys(expand_limit).length ? expand_limit : undefined,
  });
}

export function buildRecordsQuery(params = {}) {
  const expandParams = buildExpandParams(params);
  return compactObject({
    limit: params.limit,
    cursor: params.cursor,
    order: params.order,
    changes_since: params.changes_since,
    fields: Array.isArray(params.fields) ? params.fields.join(',') : params.fields,
    view: params.view,
    filter: params.filter && typeof params.filter === 'object' ? params.filter : undefined,
    connector_id: params.connector_id,
    subject_id: params.subject_id,
    ...expandParams,
  });
}

export function buildOwnerDeviceAuthorizationRequest(params = {}) {
  const clientId = String(params.client_id || '').trim();
  if (!clientId) {
    throw new Error('client_id is required');
  }

  const form = new URLSearchParams();
  form.set('client_id', clientId);

  for (const [key, value] of Object.entries(params)) {
    if (key === 'client_id' || !isPresent(value)) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isPresent(item)) form.append(key, String(item));
      }
      continue;
    }
    form.set(key, String(value));
  }

  return form;
}

export function buildParRequest(input = {}) {
  if (Array.isArray(input.authorization_details) && input.authorization_details.length) {
    return { ...input };
  }

  const detail = compactObject({
    type: input.type || 'https://pdpp.org/data-access',
    connector_id: input.connector_id,
    provider_id: input.provider_id,
    purpose_code: input.purpose_code,
    purpose_description: input.purpose_description,
    access_mode: input.access_mode,
    retention: input.retention,
    streams: Array.isArray(input.streams) ? input.streams : undefined,
  });

  const request = compactObject({
    client_id: input.client_id,
    client_display: input.client_display,
    scenario_id: input.scenario_id || (typeof input.request_context === 'string' ? input.request_context : undefined),
    authorization_details: Object.keys(detail).length > 1 ? [detail] : undefined,
  });

  return request;
}
