/**
 * Read connector operator-options in a forward-compatible way.
 *
 * Today: options come from `process.env` under a connector-specific prefix.
 * Tomorrow (pending): options come from `START.connector_options`.
 *
 * Status: `START.connector_options` now flows on the wire (it is a declared,
 * optional field on the canonical `StartMessage`). `readOptions()` prefers it
 * and still falls back to the env-var prefix, so connectors work in both the
 * orchestrator (env) and a future grant-driven (START) world without changes.
 *
 * See openspec/changes/promote-connector-config-schema/ (proposal + design).
 * The manifest `options_schema` / `credentials_schema` fields proposed there are
 * pending close RI-owner + PDPP-owner review.
 *
 * Credentials vs. options:
 *   - Credentials (tokens, passwords, cookies) belong in the credential vault
 *     path — use `requireCredentialsOrAsk` from scope-filters.js.
 *   - Options are operator tuning knobs (lookback window, allowlists, skip
 *     toggles). They are not secrets and should be declarable in the manifest.
 */

const BOOL_TRUE = /^(1|true|yes|on)$/i;

export type OptionParseKind = "int" | "bool" | "csv" | "string";

export interface OptionFieldSpec {
  default: unknown;
  parse: OptionParseKind;
}

export interface OptionsSpec {
  envPrefix: string;
  fields: Record<string, OptionFieldSpec>;
}

export interface StartMessageWithOptions {
  connector_options?: Record<string, unknown>;
}

/**
 * Read options for a connector. Example spec:
 *
 *   {
 *     envPrefix: 'SLACK_',
 *     fields: {
 *       LOOKBACK_DAYS: { parse: 'int', default: 7 },
 *       CHANNEL_ALLOWLIST: { parse: 'csv', default: [] },
 *       SKIP_FILES: { parse: 'bool', default: false },
 *       CHANNEL_TYPES: { parse: 'csv', default: ['public', 'private', 'im', 'mpim'] },
 *     },
 *   }
 */
export function readOptions(
  startMsg: StartMessageWithOptions | null | undefined,
  spec: OptionsSpec
): Record<string, unknown> {
  const fromStart: Record<string, unknown> = startMsg?.connector_options ?? {};
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(spec.fields)) {
    const envKey = `${spec.envPrefix}${name}`;
    let raw: unknown;
    if (Object.hasOwn(fromStart, name)) {
      raw = fromStart[name];
    } else if (process.env[envKey] == null) {
      out[name] = def.default;
      continue;
    } else {
      raw = process.env[envKey];
    }
    out[name] = coerce(raw, def.parse, def.default);
  }
  return out;
}

function coerce(raw: unknown, parse: OptionParseKind, fallback: unknown): unknown {
  if (raw == null) {
    return fallback;
  }
  switch (parse) {
    case "int": {
      const n = Number.parseInt(String(raw), 10);
      return Number.isFinite(n) ? n : fallback;
    }
    case "bool": {
      if (typeof raw === "boolean") {
        return raw;
      }
      return BOOL_TRUE.test(String(raw).trim());
    }
    case "csv": {
      if (Array.isArray(raw)) {
        return raw;
      }
      return String(raw)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    default:
      return String(raw);
  }
}
