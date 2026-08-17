// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  type ConnectorConnectionEnvironment,
  type ConnectorEnvironmentBinding,
  type ConnectorEnvironmentBindingSource,
  composeConnectorChildEnvironment,
  parseConnectorEnvironmentPolicy,
} from "./connector-child-environment.ts";

const AMBIGUOUS_WINDOWS_ENV = /ambiguous Windows environment aliases/;
const DUPLICATE_TARGET_KEY = /duplicate target key/;
const INVALID_LITERAL_VALUE = /source\.value must be a string/;
const INVALID_SOURCE_KIND = /source\.kind must be process_env, connection_env, or literal/;
const RESERVED_TARGET_KEY = /target_key is reserved/;
const CONNECTION_IDENTITY_MISMATCH = /connector identity does not match/;
const DUPLICATE_CONNECTION_KEY = /connectionEnv\.allowedKeys has duplicate key/;
const DUPLICATE_CONNECTION_VALUE_ALIAS = /connectionEnv has duplicate key alias/;
const UNSUPPORTED_CONNECTION_KEY = /connectionEnv has unsupported key/;
const UNAUTHORIZED_CONNECTION_PROXY = /connectionEnv proxy key .* requires connector-scoped operator authority/;

function compose(
  manifest: unknown,
  sourceEnv: NodeJS.ProcessEnv,
  options: {
    approvedBindings?: readonly ConnectorEnvironmentBinding[];
    approvedProxyConnectorIds?: readonly string[];
    connectionAllowedKeys?: readonly string[];
    connectionConnectorId?: string;
    connectionEnv?: Record<string, string>;
    connectorId?: string;
    explicitRunEnv?: Record<string, string>;
    platform?: NodeJS.Platform;
  } = {}
): Record<string, string> {
  return composeConnectorChildEnvironment({
    ...(options.approvedBindings ? { approvedBindings: options.approvedBindings } : {}),
    ...(options.approvedProxyConnectorIds ? { approvedProxyConnectorIds: options.approvedProxyConnectorIds } : {}),
    ...(options.connectionEnv
      ? {
          connectionEnv: {
            allowedKeys: options.connectionAllowedKeys ?? Object.keys(options.connectionEnv),
            connectorId: options.connectionConnectorId ?? options.connectorId ?? "test-connector",
            kind: "connection",
            values: options.connectionEnv,
          } satisfies ConnectorConnectionEnvironment,
        }
      : {}),
    connectorId: options.connectorId ?? "test-connector",
    explicitRunEnv: options.explicitRunEnv ?? {},
    manifest,
    platform: options.platform ?? "linux",
    sourceEnv,
  });
}

function shippedManifest(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../packages/polyfill-connectors/manifests/${name}.json`, import.meta.url), "utf8")
  );
}

function processBinding(
  logicalKey: string,
  targetKey: string,
  sourceKey: string,
  connectorId = "test-connector"
): ConnectorEnvironmentBinding {
  return { connectorId, logicalKey, source: { key: sourceKey, kind: "process_env" }, targetKey };
}

test("empty operator policy values mean no policy", () => {
  const empty = { approvedBindings: [], approvedProxyConnectorIds: [] };
  assert.deepEqual(parseConnectorEnvironmentPolicy(""), empty);
  assert.deepEqual(parseConnectorEnvironmentPolicy(" \t\n"), empty);
});

test("operator policy parsing fails closed on malformed sources and collisions", () => {
  assert.throws(
    () =>
      parseConnectorEnvironmentPolicy(
        {
          bindings: [
            { connector_id: "test-connector", logical_key: "need", source: { kind: "ambient" }, target_key: "TARGET" },
          ],
        },
        "test policy"
      ),
    INVALID_SOURCE_KIND
  );
  assert.throws(
    () =>
      parseConnectorEnvironmentPolicy(
        {
          bindings: [
            {
              connector_id: "test-connector",
              logical_key: "need",
              source: { kind: "literal", value: 42 },
              target_key: "TARGET",
            },
          ],
        },
        "test policy"
      ),
    INVALID_LITERAL_VALUE
  );
  assert.throws(
    () =>
      parseConnectorEnvironmentPolicy(
        {
          bindings: [
            {
              connector_id: "test-connector",
              logical_key: "one",
              source: { kind: "literal", value: "1" },
              target_key: "TARGET",
            },
            {
              connector_id: "test-connector",
              logical_key: "two",
              source: { kind: "literal", value: "2" },
              target_key: "target",
            },
          ],
        },
        "test policy"
      ),
    DUPLICATE_TARGET_KEY
  );
});

test("manifest-selected ambient secrets do not cross the child boundary", () => {
  const secretValues = ["aws-secret", "openai-secret", "private-config"];
  const env = compose(
    {
      capabilities: {
        auth: {
          deployment_config: [{ env_alias: "OPENAI_API_KEY", logical_key: "oauth.client_secret" }],
          required: ["AWS_SECRET_ACCESS_KEY"],
        },
      },
      runtime_requirements: {
        environment_variables: [{ logical_key: "connector.runtime_config" }],
      },
    },
    {
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      CONNECTOR_RUNTIME_CONFIG: "private-config",
      OPENAI_API_KEY: "openai-secret",
    }
  );

  assert.deepEqual(env, {});
  assert.equal(
    secretValues.some((value) => JSON.stringify(env).includes(value)),
    false
  );
});

test("an operator binding can authorize a logical need without giving the manifest source authority", () => {
  const env = compose(
    {
      runtime_requirements: {
        environment_variables: [{ logical_key: "connector.import_dir" }],
      },
    },
    {
      AWS_SECRET_ACCESS_KEY: "must-not-cross",
      INSTALLATION_IMPORT_DIR: "/imports/owner",
    },
    {
      approvedBindings: [processBinding("connector.import_dir", "IMPORT_DIR", "INSTALLATION_IMPORT_DIR")],
    }
  );

  assert.deepEqual(env, { IMPORT_DIR: "/imports/owner" });
});

test("connection and literal bindings are explicit sources and reserved targets fail closed", () => {
  assert.throws(
    () =>
      compose(
        {
          runtime_requirements: {
            environment_variables: [
              { logical_key: "connection.token" },
              { logical_key: "installation.mode" },
              { logical_key: "attempt.owner_token" },
            ],
          },
        },
        { AMBIENT_TOKEN: "ambient" },
        {
          approvedBindings: [
            {
              connectorId: "test-connector",
              logicalKey: "connection.token",
              source: { key: "CONNECTION_TOKEN", kind: "connection_env" },
              targetKey: "CONNECTOR_TOKEN",
            },
            {
              connectorId: "test-connector",
              logicalKey: "installation.mode",
              source: { kind: "literal", value: "safe" },
              targetKey: "CONNECTOR_MODE",
            },
            {
              connectorId: "test-connector",
              logicalKey: "attempt.owner_token",
              source: { kind: "literal", value: "attack" },
              targetKey: "PDPP_OWNER_TOKEN",
            },
          ],
          connectionEnv: { CONNECTION_TOKEN: "connection-value" },
        }
      ),
    RESERVED_TARGET_KEY
  );

  const env = compose(
    {
      runtime_requirements: {
        environment_variables: [{ logical_key: "connection.token" }, { logical_key: "installation.mode" }],
      },
    },
    { AMBIENT_TOKEN: "ambient" },
    {
      approvedBindings: [
        {
          connectorId: "test-connector",
          logicalKey: "connection.token",
          source: { key: "CONNECTION_TOKEN", kind: "connection_env" },
          targetKey: "CONNECTOR_TOKEN",
        },
        {
          connectorId: "test-connector",
          logicalKey: "installation.mode",
          source: { kind: "literal", value: "safe" },
          targetKey: "CONNECTOR_MODE",
        },
      ],
      connectionEnv: { CONNECTION_TOKEN: "connection-value" },
    }
  );

  assert.deepEqual(env, {
    CONNECTION_TOKEN: "connection-value",
    CONNECTOR_MODE: "safe",
    CONNECTOR_TOKEN: "connection-value",
  });
});

test("Windows bindings resolve source names case-insensitively and collapse target aliases", () => {
  const env = compose(
    {
      runtime_requirements: {
        environment_variables: [{ logical_key: "connector.name" }],
      },
    },
    { cOnNeCtOr_SeCrEt: "from-process", Path: "C:\\Windows" },
    {
      approvedBindings: [processBinding("connector.name", "Connector_Secret", "CONNECTOR_SECRET")],
      connectionEnv: { connector_secret: "from-connection" },
      explicitRunEnv: { cOnNeCtOr_SeCrEt: "from-run" },
      platform: "win32",
    }
  );

  assert.equal(Object.keys(env).filter((key) => key.toUpperCase() === "CONNECTOR_SECRET").length, 1);
  assert.equal(env.cOnNeCtOr_SeCrEt, "from-run");
  assert.equal(Object.keys(env).filter((key) => key.toUpperCase() === "PATH").length, 1);
  assert.equal(env.Path, "C:\\Windows");
});

test("Windows ambient aliases with conflicting casing fail closed", () => {
  assert.throws(
    () => compose({}, { PATH: "C:\\Other", Path: "C:\\Windows" }, { platform: "win32" }),
    AMBIGUOUS_WINDOWS_ENV
  );
});

test("proxy aliases require connector-scoped operator authority", () => {
  const env = compose(
    {},
    {
      HTTP_PROXY: "upper",
      http_proxy: "lower",
      PDPP_CHATGPT_BROWSER_LOGIN_TIMEOUT_MS: "30000",
      PDPP_CHATGPT_DETAIL_INITIAL_CONCURRENCY_PROBE: "10",
      PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS: "10000",
    }
  );

  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.http_proxy, undefined);
  const authorized = compose(
    {},
    { HTTP_PROXY: "upper", http_proxy: "lower" },
    { approvedProxyConnectorIds: ["networked"], connectorId: "networked" }
  );
  assert.equal(authorized.HTTP_PROXY, "upper");
  assert.equal(authorized.http_proxy, "lower");
  assert.equal(env.PDPP_CHATGPT_BROWSER_LOGIN_TIMEOUT_MS, "30000");
  assert.equal(env.PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS, "10000");
  assert.equal(env.PDPP_CHATGPT_DETAIL_INITIAL_CONCURRENCY_PROBE, undefined);
});

test("connection fragments are reduced to connector-owned keys", () => {
  assert.throws(
    () =>
      compose(
        { capabilities: { auth: { required: ["AWS_SECRET_ACCESS_KEY"] } } },
        { AWS_SECRET_ACCESS_KEY: "ambient" },
        {
          connectionAllowedKeys: ["SAFE_CONNECTION_TOKEN"],
          connectionEnv: {
            AWS_SECRET_ACCESS_KEY: "connection-aws",
            OPENAI_API_KEY: "connection-openai",
            SIBLING_SECRET: "connection-sibling",
          },
        }
      ),
    UNSUPPORTED_CONNECTION_KEY
  );

  assert.throws(
    () =>
      compose(
        {},
        {},
        {
          connectionAllowedKeys: ["TOKEN", "token"],
          connectionEnv: { TOKEN: "value" },
        }
      ),
    DUPLICATE_CONNECTION_KEY
  );

  assert.throws(
    () =>
      compose(
        {},
        {},
        {
          connectionAllowedKeys: ["TOKEN"],
          connectionEnv: { TOKEN: "one", token: "two" },
        }
      ),
    DUPLICATE_CONNECTION_VALUE_ALIAS
  );

  assert.throws(
    () =>
      compose(
        {},
        {},
        {
          connectionAllowedKeys: ["HTTP_PROXY"],
          connectionEnv: { HTTP_PROXY: "http://connection@proxy" },
        }
      ),
    UNAUTHORIZED_CONNECTION_PROXY
  );

  const shipped = compose(
    shippedManifest("notion"),
    {},
    {
      connectionAllowedKeys: ["NOTION_API_TOKEN"],
      connectionEnv: { NOTION_API_TOKEN: "notion-token" },
      connectorId: "notion",
    }
  );
  assert.deepEqual(shipped, { NOTION_API_TOKEN: "notion-token" });

  assert.throws(
    () =>
      compose(
        {},
        {},
        {
          connectionAllowedKeys: ["NOTION_API_TOKEN"],
          connectionConnectorId: "notion",
          connectionEnv: { NOTION_API_TOKEN: "replayed" },
          connectorId: "sibling",
        }
      ),
    CONNECTION_IDENTITY_MISMATCH
  );
});

test("every proxy binding source requires connector-scoped authority", () => {
  const manifest = { runtime_requirements: { environment_variables: [{ logical_key: "proxy.need" }] } };
  const cases: readonly [ConnectorEnvironmentBindingSource, NodeJS.ProcessEnv, Record<string, string>][] = [
    [{ key: "HTTP_PROXY", kind: "process_env" }, { HTTP_PROXY: "http://process@proxy" }, {}],
    [{ key: "HTTP_PROXY", kind: "connection_env" }, {}, { HTTP_PROXY: "http://connection@proxy" }],
    [{ kind: "literal", value: "http://literal@proxy" }, {}, {}],
  ];
  for (const [source, sourceEnv, connectionEnv] of cases) {
    const binding = { connectorId: "evil", logicalKey: "proxy.need", source, targetKey: "HTTP_PROXY" };
    if (source.kind === "connection_env") {
      assert.throws(
        () =>
          compose(manifest, sourceEnv, {
            approvedBindings: [binding],
            connectionEnv,
            connectorId: "evil",
          }),
        UNAUTHORIZED_CONNECTION_PROXY
      );
    } else {
      const unauthorized = compose(manifest, sourceEnv, {
        approvedBindings: [binding],
        connectionEnv,
        connectorId: "evil",
      });
      assert.equal(unauthorized.HTTP_PROXY, undefined);
    }

    const authorized = compose(manifest, sourceEnv, {
      approvedBindings: [binding],
      approvedProxyConnectorIds: ["evil"],
      connectionEnv,
      connectorId: "evil",
    });
    assert.equal(
      authorized.HTTP_PROXY,
      source.kind === "literal" ? source.value : (Object.values(sourceEnv)[0] ?? Object.values(connectionEnv)[0])
    );
  }
});

test("shipped manifests keep logical declarations compatible while rejecting auth env aliases", () => {
  const google = compose(
    shippedManifest("google_maps_data_portability"),
    {
      AWS_SECRET_ACCESS_KEY: "must-not-cross",
      GOOGLE_DATAPORTABILITY_CLIENT_ID: "dataportability-client-id",
      GOOGLE_DATAPORTABILITY_CLIENT_SECRET: "dataportability-client-secret",
    },
    {
      approvedBindings: [
        processBinding(
          "GOOGLE_DATAPORTABILITY_CLIENT_ID",
          "GOOGLE_DATAPORTABILITY_CLIENT_ID",
          "GOOGLE_DATAPORTABILITY_CLIENT_ID",
          "google-maps-data-portability"
        ),
        processBinding(
          "GOOGLE_DATAPORTABILITY_CLIENT_SECRET",
          "GOOGLE_DATAPORTABILITY_CLIENT_SECRET",
          "GOOGLE_DATAPORTABILITY_CLIENT_SECRET",
          "google-maps-data-portability"
        ),
        processBinding(
          "GOOGLE_DATAPORTABILITY_REDIRECT_URI",
          "GOOGLE_DATAPORTABILITY_REDIRECT_URI",
          "GOOGLE_DATAPORTABILITY_REDIRECT_URI",
          "google-maps-data-portability"
        ),
      ],
      connectorId: "google-maps-data-portability",
    }
  );
  assert.equal(google.GOOGLE_DATAPORTABILITY_CLIENT_ID, "dataportability-client-id");
  assert.equal(google.GOOGLE_DATAPORTABILITY_CLIENT_SECRET, "dataportability-client-secret");
  assert.equal(google.GOOGLE_DATAPORTABILITY_REDIRECT_URI, undefined);
  assert.equal(google.AWS_SECRET_ACCESS_KEY, undefined);

  const notion = compose(shippedManifest("notion"), { NOTION_API_TOKEN: "ambient-token" });
  assert.equal(notion.NOTION_API_TOKEN, undefined);

  const notionWithBinding = compose(
    shippedManifest("notion"),
    { NOTION_API_TOKEN: "operator-token" },
    {
      approvedBindings: [processBinding("NOTION_API_TOKEN", "NOTION_API_TOKEN", "NOTION_API_TOKEN", "notion")],
      connectorId: "notion",
    }
  );
  assert.equal(notionWithBinding.NOTION_API_TOKEN, "operator-token");

  const slack = compose(
    shippedManifest("slack"),
    { SIBLING_SECRET: "must-not-cross", SLACK_TOKEN: "operator-token" },
    {
      approvedBindings: [processBinding("SLACK_TOKEN", "SLACK_TOKEN", "SLACK_TOKEN", "slack")],
      connectorId: "slack",
    }
  );
  assert.equal(slack.SLACK_TOKEN, "operator-token");
  assert.equal(slack.SIBLING_SECRET, undefined);

  const whatsapp = compose(
    shippedManifest("whatsapp"),
    { WHATSAPP_EXPORT_DIR: "/imports/whatsapp" },
    {
      approvedBindings: [
        processBinding("WHATSAPP_EXPORT_DIR", "WHATSAPP_EXPORT_DIR", "WHATSAPP_EXPORT_DIR", "whatsapp"),
      ],
      connectorId: "whatsapp",
    }
  );
  assert.equal(whatsapp.WHATSAPP_EXPORT_DIR, "/imports/whatsapp");

  const googleConnection = compose(
    shippedManifest("google_maps_data_portability"),
    {},
    {
      connectionEnv: { GOOGLE_DATAPORTABILITY_REDIRECT_URI: "https://owner.example/oauth/callback" },
    }
  );
  assert.equal(googleConnection.GOOGLE_DATAPORTABILITY_REDIRECT_URI, "https://owner.example/oauth/callback");
});

test("a sibling shipped manifest cannot consume another connector's approved logical binding", () => {
  const notionBinding = processBinding("NOTION_API_TOKEN", "NOTION_API_TOKEN", "NOTION_API_TOKEN", "notion");
  const sibling = compose(
    shippedManifest("strava"),
    { NOTION_API_TOKEN: "notion-secret", STRAVA_ACCESS_TOKEN: "strava-secret" },
    { approvedBindings: [notionBinding], connectorId: "strava" }
  );
  assert.equal(sibling.NOTION_API_TOKEN, undefined);
  assert.equal(sibling.STRAVA_ACCESS_TOKEN, undefined);

  const owner = compose(
    shippedManifest("notion"),
    { NOTION_API_TOKEN: "notion-secret" },
    { approvedBindings: [notionBinding], connectorId: "notion" }
  );
  assert.equal(owner.NOTION_API_TOKEN, "notion-secret");
});

test("legacy string declarations and credential aliases cannot opt into ambient lookup", () => {
  const env = compose(
    {
      capabilities: { auth: { required: ["STRAVA_ACCESS_TOKEN"] } },
      runtime_requirements: { environment_variables: ["GOOGLE_TAKEOUT_DIR"] },
      setup: { credential_capture: { fields: [{ env: ["PASSWORD"] }] } },
    },
    {
      GOOGLE_TAKEOUT_DIR: "/imports/takeout",
      PASSWORD: "secret",
      STRAVA_ACCESS_TOKEN: "token",
    }
  );

  assert.deepEqual(env, {});
});

test("manifest-declared local path overrides cross the child boundary without ambient env", () => {
  const env = compose(
    {
      runtime_requirements: {
        local_paths: {
          home_env_override: "CLAUDE_CODE_HOME",
          paths: [{ env_override: "CLAUDE_CODE_PROJECTS_DIR" }],
        },
      },
    },
    { CLAUDE_CODE_HOME: "/fixture/home", CLAUDE_CODE_PROJECTS_DIR: "/fixture/projects", SECRET: "hidden" }
  );
  assert.equal(env.CLAUDE_CODE_HOME, "/fixture/home");
  assert.equal(env.CLAUDE_CODE_PROJECTS_DIR, "/fixture/projects");
  assert.equal(env.SECRET, undefined);
});
