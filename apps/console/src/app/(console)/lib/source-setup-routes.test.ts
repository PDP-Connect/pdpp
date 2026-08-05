// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ConnectorCatalogEntry } from "./connection-catalog.ts";
import { sourceSetupAction, sourceSetupSecondaryAction } from "./source-setup-presentation.ts";

const CONSOLE_APP = fileURLToPath(new URL("../../../", import.meta.url));

function entry(overrides: Partial<ConnectorCatalogEntry>): ConnectorCatalogEntry {
  return {
    acquisitionPaths: [],
    connectorKey: "sample",
    deploymentReadiness: { blockers: [], state: "ready" },
    displayName: "Sample",
    disposition: "static_secret_connect",
    modality: "network",
    nextStepKind: "credential_capture",
    proofGate: null,
    runbookPath: null,
    setupModality: "static_secret",
    supportState: "supported",
    ...overrides,
  } as ConnectorCatalogEntry;
}

async function routeExists(route: string): Promise<void> {
  await access(`${CONSOLE_APP}app/(console)${route}`);
}

test("every packaged add-source action points at a checked-in Next route", async () => {
  const cases = [
    [
      entry({ connectorKey: "amazon", disposition: "browser_collector_manual", enrollmentKey: "amazon" }),
      "/connect/browser-session/[connectorId]/page.tsx",
    ],
    [entry({ connectorKey: "github" }), "/connect/static-secret/[connectorId]/page.tsx"],
    [
      entry({ connectorKey: "whatsapp", disposition: "manual_upload_connect" }),
      "/connect/manual-upload/[connectorId]/page.tsx",
    ],
    [entry({ connectorKey: "gmail" }), "/connect/static-secret/[connectorId]/page.tsx"],
    [entry({ connectorKey: "slack" }), "/connect/static-secret/[connectorId]/page.tsx"],
  ] as const;

  await Promise.all(
    cases.map(async ([catalogEntry, route]) => {
      assert.ok(sourceSetupAction(catalogEntry)?.href, catalogEntry.connectorKey);
      await routeExists(route);
    })
  );
});

test("browser credentials retain an explicit alternate save-details route", async () => {
  const action = sourceSetupSecondaryAction(
    entry({ connectorKey: "amazon", modality: "browser_bound", setupModality: "static_secret" })
  );
  assert.equal(action?.href, "/connect/static-secret/amazon");
  await routeExists("/connect/static-secret/[connectorId]/page.tsx");
});
