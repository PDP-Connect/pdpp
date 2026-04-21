/**
 * Scope filtering helpers — shared across connectors so every connector
 * honors START.scope.streams[].resources and .time_range consistently.
 *
 * Also provides a tombstone emitter for mutable_state streams: given a prior
 * ID set and the set of IDs actually emitted, emit delete records for IDs
 * that vanished upstream.
 */

/**
 * @param {object} streamRequest — the per-stream entry from START.scope.streams
 * @returns {Set<string>|null} a Set of canonical-key strings if resources
 *   were requested, else null (meaning "all records allowed").
 */
export function resourceSet(streamRequest) {
  if (!streamRequest || !Array.isArray(streamRequest.resources) || !streamRequest.resources.length) return null;
  const s = new Set();
  for (const r of streamRequest.resources) s.add(String(r));
  return s;
}

/**
 * True if the record should be emitted given the stream's resources filter.
 *   null set = allow everything. Otherwise require exact primary-key match.
 * Primary key may be a string or an array; we normalize both to canonical
 * key-string form matching the core spec (minified JSON array for compound).
 */
export function passesResourceFilter(resSet, primaryKey) {
  if (!resSet) return true;
  const canonical = Array.isArray(primaryKey)
    ? JSON.stringify(primaryKey.map(String))
    : String(primaryKey);
  return resSet.has(canonical);
}

/**
 * True if an ISO date/datetime string falls within the stream's time_range.
 */
export function passesTimeRange(isoValue, timeRange) {
  if (!timeRange) return true;
  if (!isoValue) return true; // connector-side: if we can't determine, let RS do enforcement
  if (timeRange.since && isoValue < timeRange.since) return false;
  if (timeRange.until && isoValue >= timeRange.until) return false;
  return true;
}

/**
 * Create a RECORD-emission gate for a stream. Usage:
 *   const gate = makeEmitGate(emitRecord, streamRequest, { consentTimeField });
 *   gate('transactions', recordObj, record.date);  // only emits if allowed
 *
 * Collects emitted IDs internally so you can use them for tombstone diffing.
 */
export function makeEmitGate(emitRecord, streamRequest, { consentTimeField } = {}) {
  const resSet = resourceSet(streamRequest);
  const emitted = new Set();

  const gate = (stream, data, keyField = 'id') => {
    const key = data[keyField];
    if (key == null) return false;
    const canonical = Array.isArray(key) ? JSON.stringify(key.map(String)) : String(key);
    if (resSet && !resSet.has(canonical)) return false;
    if (consentTimeField && streamRequest?.time_range) {
      const v = data[consentTimeField];
      if (!passesTimeRange(v, streamRequest.time_range)) return false;
    }
    emitted.add(canonical);
    emitRecord(stream, data);
    return true;
  };
  gate.emittedSet = () => emitted;
  return gate;
}

/**
 * Emit tombstones for record IDs present in `priorIds` but absent from
 * `currentIds`. For mutable_state streams only.
 *
 * @param {object} args
 * @param {function} args.emit — the connector's emit function
 * @param {string} args.stream
 * @param {Iterable<string>} args.priorIds — IDs seen on a previous run (from state)
 * @param {Set<string>} args.currentIds — IDs emitted on this run
 * @param {string} args.emittedAt — ISO timestamp
 * @returns {number} count of tombstones emitted
 */
export function emitTombstones({ emit, stream, priorIds, currentIds, emittedAt }) {
  let count = 0;
  for (const id of priorIds || []) {
    if (!currentIds.has(id)) {
      emit({
        type: 'RECORD',
        stream,
        key: id,
        data: { id },
        emitted_at: emittedAt,
        op: 'delete',
      });
      count++;
    }
  }
  return count;
}

/**
 * Required-env or emit INTERACTION kind=credentials.
 *
 * If all required env vars are set, returns a map of values.
 * Otherwise, emits INTERACTION and blocks until the user provides them.
 *
 * @param {object} opts
 * @param {string[]} opts.required — env var names
 * @param {string} opts.connectorName — for the prompt
 * @param {function} opts.sendInteractionAndWait
 * @param {function} opts.nextInteractionId
 * @returns {Promise<Record<string,string>>}
 */
export async function requireCredentialsOrAsk({ required, connectorName, sendInteractionAndWait, nextInteractionId }) {
  const missing = required.filter((n) => !process.env[n]);
  const have = {};
  for (const n of required) if (process.env[n]) have[n] = process.env[n];
  if (!missing.length) return have;

  const properties = {};
  for (const n of missing) {
    properties[n] = {
      type: 'string',
      description: `${n} for ${connectorName}`,
      format: /PASSWORD|SECRET|TOKEN/i.test(n) ? 'password' : undefined,
    };
  }
  const resp = await sendInteractionAndWait({
    type: 'INTERACTION',
    request_id: nextInteractionId(),
    kind: 'credentials',
    message: `${connectorName} needs: ${missing.join(', ')}. Set in .env.local for persistence.`,
    schema: { type: 'object', properties, required: missing },
    timeout_seconds: 1800,
  });
  if (resp.status !== 'success' || !resp.data) {
    throw new Error(`${connectorName}_credentials_missing`);
  }
  return { ...have, ...resp.data };
}
