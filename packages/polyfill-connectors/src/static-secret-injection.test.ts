// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCollectorConnector } from "@pdpp/collector-runtime";
import { resolveExecutionRoot } from "./execution-root.ts";
import {
	buildConnectionScopedSecretEnv,
	isStaticSecretCaptureOptional,
	isStaticSecretConnector,
	type RecoveredStaticSecret,
	STATIC_SECRET_CONNECTOR_REGISTRY,
	StaticSecretInjectionError,
} from "./static-secret-injection.ts";

// ---------------------------------------------------------------------------
// Pure construction: the env fragment is connection-scoped and guarded.
// ---------------------------------------------------------------------------

test("static-secret registry knows static-secret connectors and rejects non-static-secret connectors", () => {
	assert.equal(isStaticSecretConnector("amazon"), true);
	assert.equal(isStaticSecretConnector("chase"), true);
	assert.equal(isStaticSecretConnector("chatgpt"), true);
	assert.equal(isStaticSecretConnector("heb"), true);
	assert.equal(isStaticSecretConnector("gmail"), true);
	assert.equal(isStaticSecretConnector("github"), true);
	assert.equal(isStaticSecretConnector("ynab"), true);
	assert.equal(isStaticSecretConnector("slack"), true);
	assert.equal(isStaticSecretConnector("reddit"), true);
	assert.equal(isStaticSecretConnector("usaa"), true);
	assert.equal(isStaticSecretConnector("steam"), true);
	assert.equal(isStaticSecretConnector("jellyfin"), true);
	assert.equal(isStaticSecretConnector("apple_contacts"), true);
	assert.equal(isStaticSecretConnector("groupme"), true);
	assert.equal(isStaticSecretConnector("claude-code"), false);
});

// isStaticSecretCaptureOptional is the run-orchestration-facing predicate a
// seam with no manifest access (resolveStaticSecretRunEnv) uses to ask "does
// a missing credential here mean the owner chose manual sign-in" — see its
// doc for why this exists instead of threading the manifest itself through
// that seam.
test("isStaticSecretCaptureOptional reads captureRequired: false for venmo only, true/absent for every other connector", () => {
	assert.equal(isStaticSecretCaptureOptional("venmo"), true);
	assert.equal(
		isStaticSecretCaptureOptional("jellyfin"),
		false,
		"jellyfin has no block-level required:false fact",
	);
	assert.equal(isStaticSecretCaptureOptional("usaa"), false);
	assert.equal(isStaticSecretCaptureOptional("gmail"), false);
	assert.equal(
		isStaticSecretCaptureOptional("claude-code"),
		false,
		"a connector absent from the registry must not be misread as optional",
	);
});

test("steam injection sets the API key secret and Steam ID setup field", () => {
	const env = buildConnectionScopedSecretEnv(
		"steam",
		{ secret: "synthetic-steam-api-key", credentialKind: "api_key" },
		{
			kind: "static_secret_draft",
			setup_fields: { steamid: "76500000000000000" },
		},
	);
	assert.deepEqual(env, {
		STEAM_API_KEY: "synthetic-steam-api-key",
		STEAM_USER_ID: "76500000000000000",
	});
});

test("jellyfin injection sets the username+password secrets and base URL setup field (primary path)", () => {
	const env = buildConnectionScopedSecretEnv(
		"jellyfin",
		{
			secret: JSON.stringify({
				username: "alice",
				password: "synthetic-password",
			}),
			credentialKind: "username_password",
		},
		{
			kind: "static_secret_draft",
			setup_fields: { base_url: "https://jellyfin.example.com" },
		},
	);
	assert.deepEqual(env, {
		JELLYFIN_USERNAME: "alice",
		JELLYFIN_PASSWORD: "synthetic-password",
		JELLYFIN_BASE_URL: "https://jellyfin.example.com",
	});
});

test("jellyfin injection sets only the api_key secret when username/password are absent (secondary path)", () => {
	const env = buildConnectionScopedSecretEnv(
		"jellyfin",
		{
			secret: JSON.stringify({ secret: "synthetic-jellyfin-api-key" }),
			credentialKind: "username_password",
		},
		{
			kind: "static_secret_draft",
			setup_fields: {
				base_url: "https://jellyfin.example.com",
				jellyfin_user_id: "alice",
			},
		},
	);
	assert.deepEqual(env, {
		JELLYFIN_API_KEY: "synthetic-jellyfin-api-key",
		JELLYFIN_BASE_URL: "https://jellyfin.example.com",
		JELLYFIN_USER_ID: "alice",
	});
});

test("apple_contacts injection sets the app-specific password and both Apple ID aliases", () => {
	const env = buildConnectionScopedSecretEnv(
		"apple_contacts",
		{
			secret: "synthetic-app-specific-password",
			credentialKind: "app_password",
		},
		{
			kind: "static_secret_draft",
			setup_fields: { account_email: "owner@icloud.com" },
		},
	);
	assert.deepEqual(env, {
		APPLE_APP_SPECIFIC_PASSWORD: "synthetic-app-specific-password",
		APPLE_ID: "owner@icloud.com",
		APPLE_ID_EMAIL: "owner@icloud.com",
	});
});

test("groupme injection sets the access token secret", () => {
	const env = buildConnectionScopedSecretEnv("groupme", {
		secret: "synthetic-groupme-token",
		credentialKind: "access_token",
	});
	assert.deepEqual(env, { GROUPME_ACCESS_TOKEN: "synthetic-groupme-token" });
});

test("steam/apple_contacts/groupme registry env vars match their connector manifests", () => {
	const cases = [
		{ connectorId: "steam", secretField: "secret", setupFields: ["steamid"] },
		{
			connectorId: "apple_contacts",
			secretField: "secret",
			setupFields: ["account_email"],
		},
		{ connectorId: "groupme", secretField: "secret", setupFields: [] },
	];
	for (const { connectorId, secretField, setupFields } of cases) {
		const manifest = JSON.parse(
			readFileSync(
				new URL(`../manifests/${connectorId}.json`, import.meta.url),
				"utf8",
			),
		);
		const fields = manifest.setup.credential_capture.fields as Array<{
			name: string;
			env: string[];
		}>;
		const secretDescriptorField = fields.find(
			(field) => field.name === secretField,
		);
		const descriptor = STATIC_SECRET_CONNECTOR_REGISTRY[connectorId];
		assert.ok(descriptor, `registry must include ${connectorId}`);
		assert.deepEqual(
			descriptor.secretEnvVars,
			secretDescriptorField?.env,
			`${connectorId} secret env mismatch`,
		);
		for (const setupField of setupFields) {
			const setupDescriptorField = fields.find(
				(field) => field.name === setupField,
			);
			assert.deepEqual(
				descriptor.setupFieldEnvVars?.[setupField],
				setupDescriptorField?.env,
				`${connectorId} setup field env mismatch (${setupField})`,
			);
		}
	}
});

test("jellyfin registry secret-bundle and setup-field env vars match its connector manifest", () => {
	const manifest = JSON.parse(
		readFileSync(
			new URL("../manifests/jellyfin.json", import.meta.url),
			"utf8",
		),
	);
	const fields = manifest.setup.credential_capture.fields as Array<{
		name: string;
		env: string[];
	}>;
	const descriptor = STATIC_SECRET_CONNECTOR_REGISTRY.jellyfin;
	assert.ok(descriptor, "registry must include jellyfin");
	assert.equal(
		manifest.setup.credential_capture.required,
		undefined,
		"jellyfin's manifest omits the block-level fact entirely (this test would need updating if that changes)",
	);
	assert.equal(
		descriptor.captureRequired,
		true,
		"omitting credential_capture.required must default to true (capture-required) at the registry/injection layer too",
	);
	for (const bundleField of ["username", "password", "secret"]) {
		const manifestField = fields.find((field) => field.name === bundleField);
		assert.deepEqual(
			descriptor.secretFieldEnvVars?.[bundleField],
			manifestField?.env,
			`jellyfin secret bundle env mismatch (${bundleField})`,
		);
		assert.ok(
			descriptor.optionalSecretBundleFields?.has(bundleField),
			`jellyfin secret bundle field '${bundleField}' must be optional so either credential path can be sealed alone`,
		);
	}
	for (const setupField of ["base_url", "jellyfin_user_id"]) {
		const manifestField = fields.find((field) => field.name === setupField);
		assert.deepEqual(
			descriptor.setupFieldEnvVars?.[setupField],
			manifestField?.env,
			`jellyfin setup field env mismatch (${setupField})`,
		);
	}
});

test("browser username/password connectors inject their stored credential bundles", () => {
	const cases = [
		{
			connectorId: "amazon",
			expected: {
				AMAZON_PASSWORD: "synthetic-password",
				AMAZON_USERNAME: "owner@example.com",
			},
		},
		{
			connectorId: "chase",
			expected: {
				CHASE_PASSWORD: "synthetic-password",
				CHASE_USERNAME: "owner@example.com",
			},
		},
		{
			connectorId: "heb",
			expected: {
				HEB_PASSWORD: "synthetic-password",
				HEB_USERNAME: "owner@example.com",
			},
		},
		{
			connectorId: "usaa",
			expected: {
				USAA_PASSWORD: "synthetic-password",
				USAA_USERNAME: "owner@example.com",
			},
		},
	];
	for (const { connectorId, expected } of cases) {
		assert.deepEqual(
			buildConnectionScopedSecretEnv(connectorId, {
				credentialKind: "username_password",
				secret: JSON.stringify({
					password: "synthetic-password",
					username: "owner@example.com",
				}),
			}),
			expected,
		);
	}
});

test("chatgpt injection maps a sealed username/password credential bundle", () => {
	const env = buildConnectionScopedSecretEnv("chatgpt", {
		credentialKind: "username_password",
		secret: JSON.stringify({
			password: "synthetic-password",
			username: "owner@example.com",
		}),
	});
	assert.deepEqual(env, {
		CHATGPT_PASSWORD: "synthetic-password",
		CHATGPT_USERNAME: "owner@example.com",
	});
});

test("gmail injection sets both app-password aliases to the recovered secret", () => {
	const env = buildConnectionScopedSecretEnv("gmail", {
		secret: "abcd efgh ijkl mnop",
		credentialKind: "app_password",
	});
	assert.equal(env.GOOGLE_APP_PASSWORD_PDPP, "abcd efgh ijkl mnop");
	assert.equal(env.GMAIL_APP_PASSWORD, "abcd efgh ijkl mnop");
	// Only the secret env vars are present — no mailbox address, no global leakage.
	assert.deepEqual(Object.keys(env).sort(), [
		"GMAIL_APP_PASSWORD",
		"GOOGLE_APP_PASSWORD_PDPP",
	]);
});

test("gmail injection maps connector-owned non-secret setup fields to runtime env", () => {
	const env = buildConnectionScopedSecretEnv(
		"gmail",
		{
			secret: "abcd efgh ijkl mnop",
			credentialKind: "app_password",
		},
		{
			kind: "static_secret_draft",
			setup_fields: {
				account_email: "owner@example.com",
			},
		},
	);
	assert.equal(env.GOOGLE_APP_PASSWORD_PDPP, "abcd efgh ijkl mnop");
	assert.equal(env.GMAIL_APP_PASSWORD, "abcd efgh ijkl mnop");
	assert.equal(env.GMAIL_ADDRESS, "owner@example.com");
	assert.equal(env.GMAIL_USER, "owner@example.com");
});

test("gmail runtime setup-field env mapping matches the connector manifest", () => {
	const manifest = JSON.parse(
		readFileSync(new URL("../manifests/gmail.json", import.meta.url), "utf8"),
	);
	const accountEmailField = manifest.setup.credential_capture.fields.find(
		(field: { name?: unknown }) => field.name === "account_email",
	);
	const gmailDescriptor = STATIC_SECRET_CONNECTOR_REGISTRY.gmail;
	assert.ok(gmailDescriptor);
	assert.deepEqual(
		gmailDescriptor.setupFieldEnvVars?.account_email,
		accountEmailField.env,
	);
});

test("github injection sets both token aliases to the recovered secret", () => {
	const env = buildConnectionScopedSecretEnv("github", {
		secret: "ghp_synthetic_token_value",
		credentialKind: "personal_access_token",
	});
	assert.equal(env.GITHUB_PERSONAL_ACCESS_TOKEN, "ghp_synthetic_token_value");
	assert.equal(env.GITHUB_TOKEN, "ghp_synthetic_token_value");
});

test("ynab injection sets both PAT aliases to the recovered secret", () => {
	const env = buildConnectionScopedSecretEnv("ynab", {
		secret: "ynab_synthetic_pat",
		credentialKind: "personal_access_token",
	});
	assert.deepEqual(env, {
		YNAB_PAT: "ynab_synthetic_pat",
		YNAB_PERSONAL_ACCESS_TOKEN: "ynab_synthetic_pat",
	});
});

test("slack injection maps a sealed runtime credential bundle", () => {
	const env = buildConnectionScopedSecretEnv("slack", {
		credentialKind: "secret_bundle",
		secret: JSON.stringify({
			slack_workspace: "T12345",
			slack_token: "xoxc-synthetic-token",
			slack_cookie: "d=synthetic-cookie",
		}),
	});
	assert.deepEqual(env, {
		SLACK_COOKIE: "d=synthetic-cookie",
		SLACK_TOKEN: "xoxc-synthetic-token",
		SLACK_WORKSPACE: "T12345",
	});
});

test("reddit injection maps the current username/password credential bundle", () => {
	const env = buildConnectionScopedSecretEnv("reddit", {
		credentialKind: "username_password",
		secret: JSON.stringify({
			password: "synthetic-password",
			username: "dondochaka",
		}),
	});
	assert.deepEqual(env, {
		REDDIT_PASSWORD: "synthetic-password",
		REDDIT_USERNAME: "dondochaka",
	});
});

test("reddit injection still accepts the legacy sealed OAuth credential bundle", () => {
	const env = buildConnectionScopedSecretEnv("reddit", {
		credentialKind: "secret_bundle",
		secret: JSON.stringify({
			reddit_username: "dondochaka",
			reddit_password: "synthetic-password",
			reddit_client_id: "synthetic-client-id",
			reddit_client_secret: "synthetic-client-secret",
		}),
	});
	assert.deepEqual(env, {
		REDDIT_PASSWORD: "synthetic-password",
		REDDIT_USERNAME: "dondochaka",
	});
});

test("venmo injection sets both username+password secrets when the bundle is fully saved", () => {
	const env = buildConnectionScopedSecretEnv("venmo", {
		credentialKind: "username_password",
		secret: JSON.stringify({
			password: "synthetic-password",
			username: "owner@example.com",
		}),
	});
	assert.deepEqual(env, {
		VENMO_PASSWORD: "synthetic-password",
		VENMO_USERNAME: "owner@example.com",
	});
});

// Venmo's manifest marks the whole CAPTURE optional (block-level
// credential_capture.required: false) because ensureVenmoSession falls back
// to a manual browser sign-in with zero saved credentials — but both fields
// stay required:true at the FIELD level (BOTH-OR-NONE): the capture-time
// guards (console/RI) already enforce that a stored bundle is either fully
// empty or fully complete, so injection's own job is narrower — an entirely
// EMPTY bundle must inject nothing without throwing (the valid "sign in by
// hand" choice), while a genuinely PARTIAL bundle (something upstream let
// through broken) must still fail closed exactly like a required capture
// would, rather than silently starting a login attempt with half a
// credential.
test("venmo injection throws on a partial username/password bundle — BOTH-OR-NONE is fail-closed, not silently half-injected", () => {
	assert.throws(
		() =>
			buildConnectionScopedSecretEnv("venmo", {
				credentialKind: "username_password",
				secret: JSON.stringify({ username: "owner@example.com" }),
			}),
		(err: unknown) =>
			err instanceof StaticSecretInjectionError &&
			err.code === "recovered_secret_bundle_field_missing",
	);
	assert.throws(
		() =>
			buildConnectionScopedSecretEnv("venmo", {
				credentialKind: "username_password",
				secret: JSON.stringify({ password: "synthetic-password" }),
			}),
		(err: unknown) =>
			err instanceof StaticSecretInjectionError &&
			err.code === "recovered_secret_bundle_field_missing",
	);
});

test("venmo injection sets nothing for a fully empty bundle, never throwing (browser sign-in is always valid)", () => {
	const env = buildConnectionScopedSecretEnv("venmo", {
		credentialKind: "username_password",
		secret: "{}",
	});
	assert.deepEqual(env, {});
});

test("venmo registry secret-bundle env vars match its connector manifest — fields stay required, only the block-level capture is optional", () => {
	const manifest = JSON.parse(
		readFileSync(new URL("../manifests/venmo.json", import.meta.url), "utf8"),
	);
	const fields = manifest.setup.credential_capture.fields as Array<{
		name: string;
		env: string[];
		required: boolean;
	}>;
	const descriptor = STATIC_SECRET_CONNECTOR_REGISTRY.venmo;
	assert.ok(descriptor, "registry must include venmo");
	assert.equal(
		manifest.setup.credential_capture.required,
		false,
		"venmo's BLOCK-level credential_capture.required must be false",
	);
	assert.equal(
		descriptor.captureRequired,
		false,
		"the registry must carry the block-level fact through",
	);
	for (const bundleField of ["username", "password"]) {
		const manifestField = fields.find((field) => field.name === bundleField);
		assert.equal(
			manifestField?.required,
			true,
			`venmo manifest field '${bundleField}' must stay required:true (BOTH-OR-NONE)`,
		);
		assert.deepEqual(
			descriptor.secretFieldEnvVars?.[bundleField],
			manifestField?.env,
			`venmo secret bundle env mismatch (${bundleField})`,
		);
		assert.ok(
			!descriptor.optionalSecretBundleFields?.has(bundleField),
			`venmo secret bundle field '${bundleField}' must NOT be individually optional — the capture as a whole is, via captureRequired`,
		);
	}
});

test("sealed bundle injection refuses invalid and incomplete recovered bundles", () => {
	assert.throws(
		() =>
			buildConnectionScopedSecretEnv("slack", {
				credentialKind: "secret_bundle",
				secret: "not json",
			}),
		(err) =>
			err instanceof StaticSecretInjectionError &&
			err.code === "recovered_secret_bundle_invalid",
	);
	assert.throws(
		() =>
			buildConnectionScopedSecretEnv("slack", {
				credentialKind: "secret_bundle",
				secret: JSON.stringify({
					slack_workspace: "T12345",
					slack_token: "xoxc-synthetic-token",
				}),
			}),
		(err) =>
			err instanceof StaticSecretInjectionError &&
			err.code === "recovered_secret_bundle_field_missing",
	);
});

test("two connections for one connector build two distinct, non-colliding fragments", () => {
	const personal = buildConnectionScopedSecretEnv("gmail", {
		secret: "personal-secret",
		credentialKind: "app_password",
	});
	const work = buildConnectionScopedSecretEnv("gmail", {
		secret: "work-secret",
		credentialKind: "app_password",
	});
	assert.notEqual(
		personal.GOOGLE_APP_PASSWORD_PDPP,
		work.GOOGLE_APP_PASSWORD_PDPP,
	);
	assert.equal(personal.GOOGLE_APP_PASSWORD_PDPP, "personal-secret");
	assert.equal(work.GOOGLE_APP_PASSWORD_PDPP, "work-secret");
});

test("injection refuses unknown connectors instead of inventing env vars", () => {
	assert.throws(
		() =>
			buildConnectionScopedSecretEnv("claude-code", {
				secret: "x",
				credentialKind: "app_password",
			}),
		(err) =>
			err instanceof StaticSecretInjectionError &&
			err.code === "not_a_static_secret_connector",
	);
});

test("injection refuses a credential kind that does not match the connector", () => {
	assert.throws(
		() =>
			buildConnectionScopedSecretEnv("gmail", {
				secret: "x",
				credentialKind: "personal_access_token",
			}),
		(err) =>
			err instanceof StaticSecretInjectionError &&
			err.code === "credential_kind_mismatch",
	);
});

test("injection refuses an empty recovered secret", () => {
	assert.throws(
		() =>
			buildConnectionScopedSecretEnv("gmail", {
				secret: "",
				credentialKind: "app_password",
			} as RecoveredStaticSecret),
		(err) =>
			err instanceof StaticSecretInjectionError &&
			err.code === "recovered_secret_invalid",
	);
});

test("registry is frozen so the env var ground truth cannot be mutated at runtime", () => {
	assert.ok(Object.isFrozen(STATIC_SECRET_CONNECTOR_REGISTRY));
	const { amazon } = STATIC_SECRET_CONNECTOR_REGISTRY;
	const { chase } = STATIC_SECRET_CONNECTOR_REGISTRY;
	const { gmail } = STATIC_SECRET_CONNECTOR_REGISTRY;
	const { github } = STATIC_SECRET_CONNECTOR_REGISTRY;
	const { slack } = STATIC_SECRET_CONNECTOR_REGISTRY;
	const { reddit } = STATIC_SECRET_CONNECTOR_REGISTRY;
	const { chatgpt } = STATIC_SECRET_CONNECTOR_REGISTRY;
	const { usaa } = STATIC_SECRET_CONNECTOR_REGISTRY;
	assert.ok(amazon);
	assert.ok(chase);
	assert.ok(chatgpt);
	assert.ok(gmail);
	assert.ok(github);
	assert.ok(slack);
	assert.ok(reddit);
	assert.ok(usaa);
	assert.ok(Object.isFrozen(amazon));
	assert.ok(Object.isFrozen(amazon.secretFieldEnvVars));
	assert.ok(Object.isFrozen(amazon.secretFieldEnvVars?.password));
	assert.ok(Object.isFrozen(amazon.secretFieldEnvVars?.username));
	assert.ok(Object.isFrozen(chase));
	assert.ok(Object.isFrozen(chase.secretFieldEnvVars));
	assert.ok(Object.isFrozen(chase.secretFieldEnvVars?.password));
	assert.ok(Object.isFrozen(chase.secretFieldEnvVars?.username));
	assert.ok(Object.isFrozen(chatgpt));
	assert.ok(Object.isFrozen(chatgpt.secretFieldEnvVars));
	assert.ok(Object.isFrozen(chatgpt.secretFieldEnvVars?.password));
	assert.ok(Object.isFrozen(chatgpt.secretFieldEnvVars?.username));
	assert.ok(Object.isFrozen(gmail));
	assert.ok(Object.isFrozen(gmail.secretEnvVars));
	assert.ok(Object.isFrozen(github));
	assert.ok(Object.isFrozen(github.secretEnvVars));
	assert.ok(Object.isFrozen(slack));
	assert.ok(Object.isFrozen(slack.secretFieldEnvVars));
	assert.ok(Object.isFrozen(slack.secretFieldEnvVars?.slack_token));
	assert.ok(Object.isFrozen(reddit));
	assert.ok(Object.isFrozen(reddit.secretFieldEnvVars));
	assert.ok(Object.isFrozen(reddit.acceptedCredentialVariants));
	assert.ok(Object.isFrozen(reddit.acceptedCredentialVariants?.[0]));
	assert.ok(
		Object.isFrozen(reddit.acceptedCredentialVariants?.[0]?.secretFieldEnvVars),
	);
	assert.ok(Object.isFrozen(usaa));
	assert.ok(Object.isFrozen(usaa.secretFieldEnvVars));
	assert.ok(Object.isFrozen(usaa.secretFieldEnvVars?.password));
	assert.ok(Object.isFrozen(usaa.secretFieldEnvVars?.username));
});

// ---------------------------------------------------------------------------
// Runtime scoping: the secret reaches the child via the real runner spawn path,
// scoped to one run, and two runs never collide on a process-global secret.
//
// A stub connector echoes its observed GOOGLE_APP_PASSWORD_PDPP back as a record
// so we can assert each run authenticated with only its own connection's secret,
// without any live Gmail/IMAP dependency.
// ---------------------------------------------------------------------------

interface MiniHarness {
	close: () => Promise<void>;
	ingestedSecrets: string[];
	url: string;
}

async function startEchoIngestHarness(): Promise<MiniHarness> {
	const ingestedSecrets: string[] = [];
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", () => {
			const url = req.url ?? "";
			if (url.includes("/ingest-batches") && req.method === "POST") {
				try {
					const parsed = JSON.parse(body || "{}");
					for (const record of parsed.records ?? []) {
						const observed = record?.data?.observed_secret;
						if (typeof observed === "string") {
							ingestedSecrets.push(observed);
						}
					}
				} catch {
					// ignore malformed bodies in this stub
				}
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
				return;
			}
			if (url.includes("/state")) {
				// Prior-state read: return the well-formed empty-state shape the runner
				// expects so it proceeds to spawn the connector.
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						object: "device_source_instance_state",
						device_id: "device-1",
						source_instance_id: "src",
						state: {},
						updated_at: null,
					}),
				);
				return;
			}
			// Any other endpoint (gap acks, heartbeat): no-op ok.
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, resolve));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	return {
		url: `http://127.0.0.1:${port}`,
		ingestedSecrets,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	};
}

async function writeEchoConnector(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pdpp-static-secret-echo-"));
	const path = join(dir, "echo.mjs");
	// The connector reads ONLY its env-provided secret and echoes it. It does not
	// read process-global state; what it observes is exactly what was injected
	// into this run's connector.env.
	await writeFile(
		path,
		`
    await new Promise((r) => {
      let buf = "";
      process.stdin.on("data", (c) => { buf += c; if (buf.includes("\\n")) r(); });
      process.stdin.on("end", r);
    });
    const observed = process.env.GOOGLE_APP_PASSWORD_PDPP ?? "<none>";
    process.stdout.write(JSON.stringify({
      type: "RECORD", stream: "messages", key: "echo",
      data: { id: "echo", observed_secret: observed },
      emitted_at: "2026-06-01T00:00:00.000Z",
    }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "DONE", status: "succeeded", records_emitted: 1 }) + "\\n");
    `,
	);
	return path;
}

async function tempQueuePath(): Promise<string> {
	return join(
		await mkdtemp(join(tmpdir(), "pdpp-static-secret-queue-")),
		"queue.json",
	);
}

test("two gmail connections run with distinct injected secrets, scoped per run, no process.env collision", async () => {
	const harness = await startEchoIngestHarness();
	const echo = await writeEchoConnector();
	// Pollute process.env with a third, WRONG secret to prove the per-run
	// connector.env fragment overrides the process-global value.
	const priorGlobal = process.env.GOOGLE_APP_PASSWORD_PDPP;
	process.env.GOOGLE_APP_PASSWORD_PDPP = "PROCESS-GLOBAL-WRONG-SECRET";
	try {
		const runConnection = async (
			sourceInstanceId: string,
			recovered: RecoveredStaticSecret,
		): Promise<void> => {
			const secretEnv = buildConnectionScopedSecretEnv("gmail", recovered);
			await runCollectorConnector({
				baseUrl: harness.url,
				batchSize: 1,
				connector: {
					args: [echo],
					command: "node",
					connector_id: "gmail",
					// Connection-scoped injection: this run's secret only.
					env: { ...secretEnv },
					runtime_requirements: { bindings: { network: { required: true } } },
					streams: ["messages"],
				},
				deviceId: "device-1",
				deviceToken: "device-token",
				executionRoot: resolveExecutionRoot({ args: [echo] }),
				queuePath: await tempQueuePath(),
				sourceInstanceId,
			});
		};

		await runConnection("cin_personal", {
			secret: "personal-mailbox-secret",
			credentialKind: "app_password",
		});
		await runConnection("cin_work", {
			secret: "work-mailbox-secret",
			credentialKind: "app_password",
		});

		assert.deepEqual(
			harness.ingestedSecrets.sort((a, b) => {
				if (a < b) {
					return -1;
				}
				return a > b ? 1 : 0;
			}),
			["personal-mailbox-secret", "work-mailbox-secret"],
			"each run authenticated with only its own connection's secret",
		);
		assert.ok(
			!harness.ingestedSecrets.includes("PROCESS-GLOBAL-WRONG-SECRET"),
			"the per-run injected secret must override the process-global env",
		);
	} finally {
		if (priorGlobal === undefined) {
			delete process.env.GOOGLE_APP_PASSWORD_PDPP;
		} else {
			process.env.GOOGLE_APP_PASSWORD_PDPP = priorGlobal;
		}
		await harness.close();
	}
});
