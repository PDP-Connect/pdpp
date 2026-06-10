import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCollectorConnector } from "./collector-runner.ts";
import {
  buildConnectionScopedSecretEnv,
  isStaticSecretConnector,
  type RecoveredStaticSecret,
  STATIC_SECRET_CONNECTOR_REGISTRY,
  StaticSecretInjectionError,
} from "./static-secret-injection.ts";

// ---------------------------------------------------------------------------
// Pure construction: the env fragment is connection-scoped and guarded.
// ---------------------------------------------------------------------------

test("static-secret registry knows static-secret connectors and rejects non-static-secret connectors", () => {
  assert.equal(isStaticSecretConnector("gmail"), true);
  assert.equal(isStaticSecretConnector("github"), true);
  assert.equal(isStaticSecretConnector("ynab"), true);
  assert.equal(isStaticSecretConnector("slack"), true);
  assert.equal(isStaticSecretConnector("reddit"), true);
  assert.equal(isStaticSecretConnector("amazon"), false);
  assert.equal(isStaticSecretConnector("claude-code"), false);
});

test("gmail injection sets both app-password aliases to the recovered secret", () => {
  const env = buildConnectionScopedSecretEnv("gmail", {
    secret: "abcd efgh ijkl mnop",
    credentialKind: "app_password",
  });
  assert.equal(env.GOOGLE_APP_PASSWORD_PDPP, "abcd efgh ijkl mnop");
  assert.equal(env.GMAIL_APP_PASSWORD, "abcd efgh ijkl mnop");
  // Only the secret env vars are present — no mailbox address, no global leakage.
  assert.deepEqual(Object.keys(env).sort(), ["GMAIL_APP_PASSWORD", "GOOGLE_APP_PASSWORD_PDPP"]);
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
    }
  );
  assert.equal(env.GOOGLE_APP_PASSWORD_PDPP, "abcd efgh ijkl mnop");
  assert.equal(env.GMAIL_APP_PASSWORD, "abcd efgh ijkl mnop");
  assert.equal(env.GMAIL_ADDRESS, "owner@example.com");
  assert.equal(env.GMAIL_USER, "owner@example.com");
});

test("gmail runtime setup-field env mapping matches the connector manifest", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifests/gmail.json", import.meta.url), "utf8"));
  const accountEmailField = manifest.setup.credential_capture.fields.find(
    (field: { name?: unknown }) => field.name === "account_email"
  );
  const gmailDescriptor = STATIC_SECRET_CONNECTOR_REGISTRY.gmail;
  assert.ok(gmailDescriptor);
  assert.deepEqual(gmailDescriptor.setupFieldEnvVars?.account_email, accountEmailField.env);
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

test("slack injection maps a sealed bundle plus workspace setup fields", () => {
  const env = buildConnectionScopedSecretEnv(
    "slack",
    {
      credentialKind: "secret_bundle",
      secret: JSON.stringify({
        slack_token: "xoxc-synthetic-token",
        slack_cookie: "d=synthetic-cookie",
      }),
    },
    {
      kind: "static_secret_draft",
      setup_fields: {
        slack_workspace: "T12345",
      },
    }
  );
  assert.deepEqual(env, {
    SLACK_COOKIE: "d=synthetic-cookie",
    SLACK_TOKEN: "xoxc-synthetic-token",
    SLACK_WORKSPACE: "T12345",
  });
});

test("reddit injection maps OAuth bundle secrets and non-secret setup identity", () => {
  const env = buildConnectionScopedSecretEnv(
    "reddit",
    {
      credentialKind: "secret_bundle",
      secret: JSON.stringify({
        reddit_password: "synthetic-password",
        reddit_client_secret: "synthetic-client-secret",
      }),
    },
    {
      kind: "static_secret_draft",
      setup_fields: {
        reddit_username: "dondochaka",
        reddit_client_id: "synthetic-client-id",
      },
    }
  );
  assert.deepEqual(env, {
    REDDIT_CLIENT_ID: "synthetic-client-id",
    REDDIT_CLIENT_SECRET: "synthetic-client-secret",
    REDDIT_PASSWORD: "synthetic-password",
    REDDIT_USERNAME: "dondochaka",
  });
});

test("sealed bundle injection refuses invalid and incomplete recovered bundles", () => {
  assert.throws(
    () => buildConnectionScopedSecretEnv("slack", { credentialKind: "secret_bundle", secret: "not json" }),
    (err) => err instanceof StaticSecretInjectionError && err.code === "recovered_secret_bundle_invalid"
  );
  assert.throws(
    () =>
      buildConnectionScopedSecretEnv("slack", {
        credentialKind: "secret_bundle",
        secret: JSON.stringify({ slack_token: "xoxc-synthetic-token" }),
      }),
    (err) => err instanceof StaticSecretInjectionError && err.code === "recovered_secret_bundle_field_missing"
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
  assert.notEqual(personal.GOOGLE_APP_PASSWORD_PDPP, work.GOOGLE_APP_PASSWORD_PDPP);
  assert.equal(personal.GOOGLE_APP_PASSWORD_PDPP, "personal-secret");
  assert.equal(work.GOOGLE_APP_PASSWORD_PDPP, "work-secret");
});

test("injection refuses unknown connectors instead of inventing env vars", () => {
  assert.throws(
    () => buildConnectionScopedSecretEnv("amazon", { secret: "x", credentialKind: "app_password" }),
    (err) => err instanceof StaticSecretInjectionError && err.code === "not_a_static_secret_connector"
  );
});

test("injection refuses a credential kind that does not match the connector", () => {
  assert.throws(
    () =>
      buildConnectionScopedSecretEnv("gmail", {
        secret: "x",
        credentialKind: "personal_access_token",
      }),
    (err) => err instanceof StaticSecretInjectionError && err.code === "credential_kind_mismatch"
  );
});

test("injection refuses an empty recovered secret", () => {
  assert.throws(
    () =>
      buildConnectionScopedSecretEnv("gmail", { secret: "", credentialKind: "app_password" } as RecoveredStaticSecret),
    (err) => err instanceof StaticSecretInjectionError && err.code === "recovered_secret_invalid"
  );
});

test("registry is frozen so the env var ground truth cannot be mutated at runtime", () => {
  assert.ok(Object.isFrozen(STATIC_SECRET_CONNECTOR_REGISTRY));
  const gmail = STATIC_SECRET_CONNECTOR_REGISTRY.gmail;
  const github = STATIC_SECRET_CONNECTOR_REGISTRY.github;
  const slack = STATIC_SECRET_CONNECTOR_REGISTRY.slack;
  const reddit = STATIC_SECRET_CONNECTOR_REGISTRY.reddit;
  assert.ok(gmail);
  assert.ok(github);
  assert.ok(slack);
  assert.ok(reddit);
  assert.ok(Object.isFrozen(gmail));
  assert.ok(Object.isFrozen(gmail.secretEnvVars));
  assert.ok(Object.isFrozen(github));
  assert.ok(Object.isFrozen(github.secretEnvVars));
  assert.ok(Object.isFrozen(slack));
  assert.ok(Object.isFrozen(slack.secretFieldEnvVars));
  assert.ok(Object.isFrozen(slack.secretFieldEnvVars?.slack_token));
  assert.ok(Object.isFrozen(slack.setupFieldEnvVars));
  assert.ok(Object.isFrozen(slack.setupFieldEnvVars?.slack_workspace));
  assert.ok(Object.isFrozen(reddit));
  assert.ok(Object.isFrozen(reddit.secretFieldEnvVars));
  assert.ok(Object.isFrozen(reddit.setupFieldEnvVars));
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
          })
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
    `
  );
  return path;
}

async function tempQueuePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "pdpp-static-secret-queue-")), "queue.json");
}

test("two gmail connections run with distinct injected secrets, scoped per run, no process.env collision", async () => {
  const harness = await startEchoIngestHarness();
  const echo = await writeEchoConnector();
  // Pollute process.env with a third, WRONG secret to prove the per-run
  // connector.env fragment overrides the process-global value.
  const priorGlobal = process.env.GOOGLE_APP_PASSWORD_PDPP;
  process.env.GOOGLE_APP_PASSWORD_PDPP = "PROCESS-GLOBAL-WRONG-SECRET";
  try {
    const runConnection = async (sourceInstanceId: string, recovered: RecoveredStaticSecret): Promise<void> => {
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
        queuePath: await tempQueuePath(),
        sourceInstanceId,
      });
    };

    await runConnection("cin_personal", { secret: "personal-mailbox-secret", credentialKind: "app_password" });
    await runConnection("cin_work", { secret: "work-mailbox-secret", credentialKind: "app_password" });

    assert.deepEqual(
      harness.ingestedSecrets.sort(),
      ["personal-mailbox-secret", "work-mailbox-secret"],
      "each run authenticated with only its own connection's secret"
    );
    assert.ok(
      !harness.ingestedSecrets.includes("PROCESS-GLOBAL-WRONG-SECRET"),
      "the per-run injected secret must override the process-global env"
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
