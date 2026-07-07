function freezeStaticSecretDescriptor(descriptor) {
    const freezeMapping = (mapping) => {
        if (mapping.secretEnvVars) {
            Object.freeze(mapping.secretEnvVars);
        }
        if (mapping.secretFieldEnvVars) {
            for (const value of Object.values(mapping.secretFieldEnvVars)) {
                Object.freeze(value);
            }
            Object.freeze(mapping.secretFieldEnvVars);
        }
        if (mapping.setupFieldEnvVars) {
            for (const value of Object.values(mapping.setupFieldEnvVars)) {
                Object.freeze(value);
            }
            Object.freeze(mapping.setupFieldEnvVars);
        }
        return Object.freeze(mapping);
    };
    if (descriptor.secretEnvVars) {
        Object.freeze(descriptor.secretEnvVars);
    }
    if (descriptor.secretFieldEnvVars) {
        for (const value of Object.values(descriptor.secretFieldEnvVars)) {
            Object.freeze(value);
        }
        Object.freeze(descriptor.secretFieldEnvVars);
    }
    if (descriptor.setupFieldEnvVars) {
        for (const value of Object.values(descriptor.setupFieldEnvVars)) {
            Object.freeze(value);
        }
        Object.freeze(descriptor.setupFieldEnvVars);
    }
    if (descriptor.acceptedCredentialVariants) {
        for (const variant of descriptor.acceptedCredentialVariants) {
            freezeMapping(variant);
        }
        Object.freeze(descriptor.acceptedCredentialVariants);
    }
    return Object.freeze(descriptor);
}
export const STATIC_SECRET_CONNECTOR_REGISTRY = Object.freeze({
    amazon: freezeStaticSecretDescriptor({
        credentialKind: "username_password",
        secretFieldEnvVars: {
            password: ["AMAZON_PASSWORD"],
            username: ["AMAZON_USERNAME"],
        },
    }),
    chatgpt: freezeStaticSecretDescriptor({
        credentialKind: "username_password",
        secretFieldEnvVars: {
            password: ["CHATGPT_PASSWORD"],
            username: ["CHATGPT_USERNAME"],
        },
    }),
    gmail: freezeStaticSecretDescriptor({
        credentialKind: "app_password",
        secretEnvVars: ["GOOGLE_APP_PASSWORD_PDPP", "GMAIL_APP_PASSWORD"],
        setupFieldEnvVars: {
            account_email: ["GMAIL_ADDRESS", "GMAIL_USER"],
        },
    }),
    github: freezeStaticSecretDescriptor({
        credentialKind: "personal_access_token",
        secretEnvVars: ["GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_TOKEN"],
    }),
    ynab: freezeStaticSecretDescriptor({
        credentialKind: "personal_access_token",
        secretEnvVars: ["YNAB_PERSONAL_ACCESS_TOKEN", "YNAB_PAT"],
    }),
    slack: freezeStaticSecretDescriptor({
        credentialKind: "secret_bundle",
        secretFieldEnvVars: {
            slack_workspace: ["SLACK_WORKSPACE"],
            slack_token: ["SLACK_TOKEN"],
            slack_cookie: ["SLACK_COOKIE"],
        },
    }),
    oura: freezeStaticSecretDescriptor({
        credentialKind: "personal_access_token",
        secretEnvVars: ["OURA_PERSONAL_ACCESS_TOKEN"],
    }),
    notion: freezeStaticSecretDescriptor({
        credentialKind: "personal_access_token",
        secretEnvVars: ["NOTION_API_TOKEN"],
    }),
    reddit: freezeStaticSecretDescriptor({
        credentialKind: "username_password",
        acceptedCredentialVariants: [
            {
                credentialKind: "secret_bundle",
                secretFieldEnvVars: {
                    reddit_password: ["REDDIT_PASSWORD"],
                    reddit_username: ["REDDIT_USERNAME"],
                },
            },
        ],
        secretFieldEnvVars: {
            password: ["REDDIT_PASSWORD"],
            username: ["REDDIT_USERNAME"],
        },
    }),
    chase: freezeStaticSecretDescriptor({
        credentialKind: "username_password",
        secretFieldEnvVars: {
            password: ["CHASE_PASSWORD"],
            username: ["CHASE_USERNAME"],
        },
    }),
    usaa: freezeStaticSecretDescriptor({
        credentialKind: "username_password",
        secretFieldEnvVars: {
            password: ["USAA_PASSWORD"],
            username: ["USAA_USERNAME"],
        },
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
function setupFieldsFromSourceBinding(sourceBinding) {
    if (!sourceBinding || typeof sourceBinding !== "object" || Array.isArray(sourceBinding)) {
        return {};
    }
    const raw = sourceBinding.setup_fields;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return {};
    }
    const fields = {};
    for (const [key, value] of Object.entries(raw)) {
        if (typeof value === "string" && value.trim().length > 0) {
            fields[key] = value.trim();
        }
    }
    return fields;
}
function secretBundleFields(connectorId, secret) {
    let parsed;
    try {
        parsed = JSON.parse(secret);
    }
    catch {
        throw new StaticSecretInjectionError("recovered_secret_bundle_invalid", `Connector '${connectorId}' expects a sealed JSON credential bundle; recovered secret was not valid JSON.`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new StaticSecretInjectionError("recovered_secret_bundle_invalid", `Connector '${connectorId}' expects a sealed JSON credential bundle object.`);
    }
    const fields = {};
    for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string" && value.trim().length > 0) {
            fields[key] = value.trim();
        }
    }
    return fields;
}
function injectionMappingForRecoveredSecret(connectorId, descriptor, recovered) {
    if (!recovered || typeof recovered.secret !== "string" || recovered.secret.length === 0) {
        throw new StaticSecretInjectionError("recovered_secret_invalid", `Cannot inject an empty credential for connector '${connectorId}'.`);
    }
    if (recovered.credentialKind === descriptor.credentialKind) {
        return descriptor;
    }
    const variant = descriptor.acceptedCredentialVariants?.find((candidate) => candidate.credentialKind === recovered.credentialKind);
    if (variant) {
        return variant;
    }
    const expectedKinds = [
        descriptor.credentialKind,
        ...(descriptor.acceptedCredentialVariants ?? []).map((v) => v.credentialKind),
    ];
    if (!expectedKinds.includes(recovered.credentialKind)) {
        throw new StaticSecretInjectionError("credential_kind_mismatch", `Connector '${connectorId}' expects credential kind '${expectedKinds.join("' or '")}', ` +
            `but the recovered credential is '${recovered.credentialKind}'.`);
    }
    return descriptor;
}
function injectSingleSecret(fragment, envVars, secret) {
    for (const envVar of envVars ?? []) {
        fragment[envVar] = secret;
    }
}
function injectSecretBundle(fragment, connectorId, secret, secretFieldEnvVars) {
    if (!secretFieldEnvVars) {
        return;
    }
    const bundle = secretBundleFields(connectorId, secret);
    for (const [fieldName, envVars] of Object.entries(secretFieldEnvVars)) {
        const value = bundle[fieldName];
        if (!value) {
            throw new StaticSecretInjectionError("recovered_secret_bundle_field_missing", `Connector '${connectorId}' credential bundle is missing required field '${fieldName}'.`);
        }
        for (const envVar of envVars) {
            fragment[envVar] = value;
        }
    }
}
function injectSetupFields(fragment, setupFieldEnvVars, sourceBinding) {
    const setupFields = setupFieldsFromSourceBinding(sourceBinding);
    for (const [fieldName, envVars] of Object.entries(setupFieldEnvVars ?? {})) {
        const value = setupFields[fieldName];
        if (!value) {
            continue;
        }
        for (const envVar of envVars) {
            fragment[envVar] = value;
        }
    }
}
export function buildConnectionScopedSecretEnv(connectorId, recovered, sourceBinding) {
    const descriptor = STATIC_SECRET_CONNECTOR_REGISTRY[connectorId];
    if (!descriptor) {
        throw new StaticSecretInjectionError("not_a_static_secret_connector", `Connector '${connectorId}' is not a known static-secret connector; refusing to invent secret env vars for it.`);
    }
    const mapping = injectionMappingForRecoveredSecret(connectorId, descriptor, recovered);
    const fragment = {};
    injectSingleSecret(fragment, mapping.secretEnvVars, recovered.secret);
    injectSecretBundle(fragment, connectorId, recovered.secret, mapping.secretFieldEnvVars);
    injectSetupFields(fragment, mapping.setupFieldEnvVars, sourceBinding);
    return fragment;
}
