const strategies = new Map();
export function registerAuthStrategy(kind, resolver) {
    strategies.set(kind, resolver);
}
export function hasAuthStrategy(kind) {
    return strategies.has(kind);
}
export function resolveAuth(config, runtime) {
    if (!config) {
        return Promise.resolve({});
    }
    const resolver = strategies.get(config.kind);
    if (!resolver) {
        return Promise.reject(new Error(`auth_strategy_unknown: ${config.kind}`));
    }
    return resolver(config, runtime);
}
const SECRET_NAME = /PASSWORD|SECRET|TOKEN/i;
function resolveEnvEntry(entry) {
    const aliases = Array.isArray(entry) ? entry : [entry];
    const primary = aliases[0];
    if (!primary) {
        return null;
    }
    for (const name of aliases) {
        const candidate = process.env[name];
        if (candidate) {
            return { primary, value: candidate };
        }
    }
    return { primary, value: undefined };
}
function buildCredentialSchema(missing, connectorName) {
    const properties = {};
    for (const name of missing) {
        const base = {
            type: "string",
            description: `${name} for ${connectorName}`,
        };
        properties[name] = SECRET_NAME.test(name) ? { ...base, format: "password" } : base;
    }
    return { type: "object", properties, required: missing };
}
registerAuthStrategy("env", async (config, runtime) => {
    const { required } = config;
    if (!Array.isArray(required) || required.length === 0) {
        throw new Error("auth_env_required_missing: auth.required must be a non-empty array");
    }
    const have = {};
    const missing = [];
    for (const entry of required) {
        const resolved = resolveEnvEntry(entry);
        if (!resolved) {
            continue;
        }
        if (resolved.value === undefined) {
            missing.push(resolved.primary);
        }
        else {
            have[resolved.primary] = resolved.value;
        }
    }
    if (missing.length === 0) {
        return have;
    }
    const resp = await runtime.sendInteraction({
        kind: "credentials",
        message: `${runtime.connectorName} needs: ${missing.join(", ")}. Set in .env.local for persistence.`,
        schema: buildCredentialSchema(missing, runtime.connectorName),
        timeout_seconds: 1800,
    });
    if (resp.status !== "success" || !resp.data) {
        throw new Error(`${runtime.connectorName}_credentials_missing`);
    }
    return { ...have, ...resp.data };
});
