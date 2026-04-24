const SUPPORTED_RANGE_OPERATORS = new Set(['gte', 'gt', 'lte', 'lt']);

export function invalidQueryError(message, code = 'invalid_request') {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function getFieldSchema(manifestStream, field) {
  return manifestStream?.schema?.properties?.[field] || null;
}

export function nonNullSchemaTypes(schema) {
  const raw = schema?.type;
  if (raw == null) return new Set();
  const list = Array.isArray(raw) ? raw : [raw];
  return new Set(list.filter((t) => t !== 'null'));
}

const SCALAR_SCHEMA_TYPES = new Set(['boolean', 'integer', 'number', 'string']);

function isScalarFieldSchema(fieldSchema) {
  const types = nonNullSchemaTypes(fieldSchema);
  if (types.size !== 1) return false;
  const [only] = types;
  return SCALAR_SCHEMA_TYPES.has(only);
}

function isRangeQueryableSchema(fieldSchema) {
  const types = nonNullSchemaTypes(fieldSchema);
  if (types.size !== 1) return false;
  if (types.has('integer') || types.has('number')) return true;
  if (types.has('string')) {
    return fieldSchema?.format === 'date' || fieldSchema?.format === 'date-time';
  }
  return false;
}

function parseIntegerValue(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) return null;
  return Number.parseInt(value.trim(), 10);
}

function parseNumberValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDateValue(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function coerceComparableValue(value, fieldSchema, { strict = false } = {}) {
  if (value == null) return null;

  const types = nonNullSchemaTypes(fieldSchema);
  const only = types.size === 1 ? [...types][0] : null;

  if (only === 'integer') {
    const parsed = parseIntegerValue(value);
    if (parsed == null && strict) throw invalidQueryError(`Invalid integer value for '${String(value)}'`);
    return parsed;
  }

  if (only === 'number') {
    const parsed = parseNumberValue(value);
    if (parsed == null && strict) throw invalidQueryError(`Invalid number value for '${String(value)}'`);
    return parsed;
  }

  if (only === 'string' && ['date', 'date-time'].includes(fieldSchema?.format)) {
    const parsed = parseDateValue(value);
    if (parsed == null && strict) throw invalidQueryError(`Invalid date value for '${String(value)}'`);
    return parsed;
  }

  return String(value);
}

function normalizeExactFilterValue(value, field) {
  if (value != null && typeof value === 'object') {
    throw invalidQueryError(`Exact filter on '${field}' must use a scalar value`);
  }
  return String(value);
}

export function compileRequestFilters(filter, streamGrant, manifestStream) {
  if (filter == null) return [];
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
    throw invalidQueryError('filter must use filter[field]=value or filter[field][op]=value');
  }

  const compiled = [];
  for (const [field, rawValue] of Object.entries(filter)) {
    if (streamGrant.fields && !streamGrant.fields.includes(field)) {
      throw invalidQueryError(`Filter on field '${field}' not in grant`, 'field_not_granted');
    }

    const fieldSchema = getFieldSchema(manifestStream, field);
    if (!fieldSchema) {
      throw invalidQueryError(`Unknown field: ${field}`);
    }

    if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
      const operatorEntries = Object.entries(rawValue);
      if (!operatorEntries.length) {
        throw invalidQueryError(`Range filter on '${field}' must include at least one operator`);
      }
      if (!isRangeQueryableSchema(fieldSchema)) {
        throw invalidQueryError(`Range filters are not supported on '${field}'`);
      }

      const declaredOperators = manifestStream?.query?.range_filters?.[field];
      if (!Array.isArray(declaredOperators) || !declaredOperators.length) {
        throw invalidQueryError(`Range filters are not declared for '${field}'`);
      }
      const declaredOperatorSet = new Set(declaredOperators);
      const operators = {};

      for (const [operator, operand] of operatorEntries) {
        if (!SUPPORTED_RANGE_OPERATORS.has(operator)) {
          throw invalidQueryError(`Unsupported range operator '${operator}' on '${field}'`);
        }
        if (!declaredOperatorSet.has(operator)) {
          throw invalidQueryError(`Range operator '${operator}' is not declared for '${field}'`);
        }
        const comparable = coerceComparableValue(operand, fieldSchema, { strict: true });
        if (comparable == null) {
          throw invalidQueryError(`Invalid range value for '${field}'`);
        }
        operators[operator] = comparable;
      }

      compiled.push({ field, kind: 'range', fieldSchema, operators });
      continue;
    }

    if (!isScalarFieldSchema(fieldSchema)) {
      throw invalidQueryError(`Exact filters are supported only on top-level scalar fields; '${field}' is not scalar`);
    }

    compiled.push({
      field,
      kind: 'exact',
      value: normalizeExactFilterValue(rawValue, field),
    });
  }

  return compiled;
}

export function passesRequestFilters(data, filters) {
  if (!filters?.length) return true;

  for (const filter of filters) {
    const value = data?.[filter.field];

    if (filter.kind === 'exact') {
      if (String(value) !== filter.value) return false;
      continue;
    }

    const comparable = coerceComparableValue(value, filter.fieldSchema);
    if (comparable == null) return false;
    if (filter.operators.gte != null && comparable < filter.operators.gte) return false;
    if (filter.operators.gt != null && comparable <= filter.operators.gt) return false;
    if (filter.operators.lte != null && comparable > filter.operators.lte) return false;
    if (filter.operators.lt != null && comparable >= filter.operators.lt) return false;
  }

  return true;
}

export function passesTimeRange(data, timeRange, consentTimeField) {
  if (!timeRange || !consentTimeField) return true;
  const val = data[consentTimeField];
  if (!val) return false;
  const t = new Date(val).getTime();
  if (isNaN(t)) return false;
  if (timeRange.since && t < new Date(timeRange.since).getTime()) return false;
  if (timeRange.until && t >= new Date(timeRange.until).getTime()) return false;
  return true;
}

export function passesGrantRecordConstraints(data, recordKey, streamGrant, manifestStream) {
  if (streamGrant?.resources?.length && !streamGrant.resources.includes(recordKey)) {
    return false;
  }
  return passesTimeRange(data, streamGrant?.time_range, manifestStream?.consent_time_field);
}
