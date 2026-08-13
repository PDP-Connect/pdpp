// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { resolveConnectorEnvironmentPolicy } from "../server/index.ts";

const INVALID_SOURCE_KIND = /source\.kind must be process_env, connection_env, or literal/;

test("reference-server policy seam resolves one operator map for controller and scheduler wiring", () => {
  const policy = resolveConnectorEnvironmentPolicy({
    connectorEnvironmentPolicy: {
      approvedBindings: [
        {
          connectorId: "github",
          logicalKey: "github.token",
          source: { key: "GITHUB_PERSONAL_ACCESS_TOKEN", kind: "process_env" },
          targetKey: "GITHUB_PERSONAL_ACCESS_TOKEN",
        },
      ],
      approvedProxyConnectorIds: ["github"],
    },
  });

  assert.deepEqual(policy, {
    approvedBindings: [
      {
        connectorId: "github",
        logicalKey: "github.token",
        source: { key: "GITHUB_PERSONAL_ACCESS_TOKEN", kind: "process_env" },
        targetKey: "GITHUB_PERSONAL_ACCESS_TOKEN",
      },
    ],
    approvedProxyConnectorIds: ["github"],
  });
});

test("reference-server policy seam rejects malformed operator configuration before construction", () => {
  assert.throws(
    () =>
      resolveConnectorEnvironmentPolicy({
        connectorEnvironmentPolicy: JSON.parse(
          '{"bindings":[{"connector_id":"github","logical_key":"x","source":{"kind":"bad"},"target_key":"X"}]}'
        ),
      }),
    INVALID_SOURCE_KIND
  );
});
