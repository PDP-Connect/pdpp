function freezeStaticSecretDescriptor(descriptor) {
    Object.freeze(descriptor.secretEnvVars);
    return Object.freeze(descriptor);
}
export const STATIC_SECRET_CONNECTOR_REGISTRY = Object.freeze({
    gmail: freezeStaticSecretDescriptor({
        credentialKind: "app_password",
        secretEnvVars: ["GOOGLE_APP_PASSWORD_PDPP", "GMAIL_APP_PASSWORD"],
    }),
    github: freezeStaticSecretDescriptor({
        credentialKind: "personal_access_token",
        secretEnvVars: ["GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_TOKEN"],
    }),
});
export class StaticSecretInjectionError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "StaticSecretInjectionError";
        this.code = code;
    }
}
export function isStaticSecretConnector(connectorId) {
    return Object.hasOwn(STATIC_SECRET_CONNECTOR_REGISTRY, connectorId);
}
export function buildConnectionScopedSecretEnv(connectorId, recovered) {
    const descriptor = STATIC_SECRET_CONNECTOR_REGISTRY[connectorId];
    if (!descriptor) {
        throw new StaticSecretInjectionError("not_a_static_secret_connector", `Connector '${connectorId}' is not a known static-secret connector; refusing to invent secret env vars for it.`);
    }
    if (!recovered || typeof recovered.secret !== "string" || recovered.secret.length === 0) {
        throw new StaticSecretInjectionError("recovered_secret_invalid", `Cannot inject an empty credential for connector '${connectorId}'.`);
    }
    if (recovered.credentialKind !== descriptor.credentialKind) {
        throw new StaticSecretInjectionError("credential_kind_mismatch", `Connector '${connectorId}' expects credential kind '${descriptor.credentialKind}', ` +
            `but the recovered credential is '${recovered.credentialKind}'.`);
    }
    const fragment = {};
    for (const envVar of descriptor.secretEnvVars) {
        fragment[envVar] = recovered.secret;
    }
    return fragment;
}
