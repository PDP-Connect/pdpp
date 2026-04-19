/**
 * Read connector operator-options in a forward-compatible way.
 *
 * Today: options come from `process.env` under a connector-specific prefix.
 * Tomorrow (pending): options come from `START.connector_options`.
 *
 * Migration when the spec lands: replace the env read here with a
 * `startMsg.connector_options`-based read; every connector that calls
 * `readOptions(...)` gets the upgrade for free.
 *
 * See openspec/changes/add-polyfill-connector-system/design-notes/
 *     connector-configuration-open-question.md
 *
 * Credentials vs. options:
 *   - Credentials (tokens, passwords, cookies) belong in the credential vault
 *     path — use `requireCredentialsOrAsk` from scope-filters.js.
 *   - Options are operator tuning knobs (lookback window, allowlists, skip
 *     toggles). They are not secrets and should be declarable in the manifest.
 */

/**
 * @param {object} startMsg  the START message (for forward compatibility)
 * @param {object} spec
 *   {
 *     envPrefix: 'SLACK_',
 *     fields: {
 *       LOOKBACK_DAYS: { parse: 'int', default: 7 },
 *       CHANNEL_ALLOWLIST: { parse: 'csv', default: [] },
 *       SKIP_FILES: { parse: 'bool', default: false },
 *       CHANNEL_TYPES: { parse: 'csv', default: ['public', 'private', 'im', 'mpim'] },
 *     },
 *   }
 * @returns {object} parsed option values keyed by field name
 */
export function readOptions(startMsg, spec) {
  const fromStart = (startMsg && startMsg.connector_options) || {};
  const out = {};
  for (const [name, def] of Object.entries(spec.fields)) {
    const envKey = `${spec.envPrefix}${name}`;
    let raw;
    if (Object.prototype.hasOwnProperty.call(fromStart, name)) {
      raw = fromStart[name];
    } else if (process.env[envKey] != null) {
      raw = process.env[envKey];
    } else {
      out[name] = def.default;
      continue;
    }
    out[name] = coerce(raw, def.parse, def.default);
  }
  return out;
}

function coerce(raw, parse, fallback) {
  if (raw == null) return fallback;
  switch (parse) {
    case 'int': {
      const n = parseInt(String(raw), 10);
      return Number.isFinite(n) ? n : fallback;
    }
    case 'bool': {
      if (typeof raw === 'boolean') return raw;
      return /^(1|true|yes|on)$/i.test(String(raw).trim());
    }
    case 'csv': {
      if (Array.isArray(raw)) return raw;
      return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
    }
    case 'string':
    default:
      return String(raw);
  }
}
