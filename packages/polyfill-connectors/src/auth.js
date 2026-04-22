/**
 * Auth strategies for connectors.
 *
 * The runtime resolves `config.auth` into a `credentials` object that is
 * passed to collect(). Today we have one strategy (env-with-prompt-fallback).
 * Future strategies — OAuth token, refresh flows, shared provider (Login
 * with Google), platform-specific device flows — slot in here without
 * changing the runtime or the connector-facing shape.
 *
 * A strategy is a function:
 *     (config, runtime) => Promise<Record<string, string>>
 *
 * where `runtime` exposes { sendInteraction, connectorName }. The returned
 * object is whatever shape the connector expects — for env-based creds,
 * it's the env-var-name → value map. For OAuth it might be
 * { access_token, refresh_token, expires_at, ... }.
 */

const strategies = new Map();

export function registerAuthStrategy(kind, resolver) {
  strategies.set(kind, resolver);
}

export function hasAuthStrategy(kind) {
  return strategies.has(kind);
}

export async function resolveAuth(config, runtime) {
  if (!config) return {};
  const { kind } = config;
  const resolver = strategies.get(kind);
  if (!resolver) throw new Error(`auth_strategy_unknown: ${kind}`);
  return resolver(config, runtime);
}

/**
 * Strategy: environment variables with INTERACTION prompt fallback.
 *
 * Shape:
 *     auth: { kind: 'env', required: [
 *       'NOTION_API_TOKEN',
 *       ['GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_TOKEN'], // alias list: first set wins
 *     ] }
 *
 * Each entry in `required` is either a string (one env var) or an array
 * (aliases — the first value that's set wins; the returned map uses the
 * primary name). Returned dict is keyed by the primary name so connectors
 * don't care which alias provided the value.
 *
 * If any primary (or alias list) is unresolved, the runtime emits an
 * INTERACTION kind='credentials' asking for the primary names and blocks
 * until a response arrives.
 *
 * Credentials whose name matches /PASSWORD|SECRET|TOKEN/i get
 * `format: 'password'` in the schema so UIs render a masked input.
 */
registerAuthStrategy('env', async function envStrategy(config, runtime) {
  const { required } = config;
  if (!Array.isArray(required) || !required.length) {
    throw new Error('auth_env_required_missing: auth.required must be a non-empty array of env-var names');
  }

  const have = {};
  const missing = [];
  for (const entry of required) {
    const aliases = Array.isArray(entry) ? entry : [entry];
    const primary = aliases[0];
    let value = null;
    for (const name of aliases) {
      if (process.env[name]) { value = process.env[name]; break; }
    }
    if (value) have[primary] = value;
    else missing.push(primary);
  }
  if (!missing.length) return have;

  const properties = {};
  for (const name of missing) {
    properties[name] = {
      type: 'string',
      description: `${name} for ${runtime.connectorName}`,
      format: /PASSWORD|SECRET|TOKEN/i.test(name) ? 'password' : undefined,
    };
  }
  const resp = await runtime.sendInteraction({
    kind: 'credentials',
    message: `${runtime.connectorName} needs: ${missing.join(', ')}. Set in .env.local for persistence.`,
    schema: { type: 'object', properties, required: missing },
    timeout_seconds: 1800,
  });
  if (resp.status !== 'success' || !resp.data) {
    throw new Error(`${runtime.connectorName}_credentials_missing`);
  }
  return { ...have, ...resp.data };
});
