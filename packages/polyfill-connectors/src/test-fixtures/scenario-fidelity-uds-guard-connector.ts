// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only connector fixture for `bin/scenario-fidelity.test.ts`'s UDS
 * bridge egress-guard proof. Runs under `writeReplayBridgePreload`'s UDS
 * transport (no namespace isolation involved — this proves the JS-layer
 * `net.Socket.prototype.connect` guard's own allowlist logic, not the OS
 * layer). Two calls:
 *
 *   1. An ordinary `fetch()` — routed by the preload over
 *      `http.request({socketPath: UDS_PATH})`, which the guard must allow
 *      since it's the bridge dialing itself.
 *   2. A raw `net.connect({socketPath: <a DIFFERENT path>})` — a connector
 *      attempting to dial a foreign Unix domain socket directly, bypassing
 *      fetch. The guard must deny this exactly like it denies a foreign TCP
 *      destination.
 *
 * Reads the foreign socket path from `PDPP_SCENARIO_FIDELITY_FOREIGN_SOCKET`
 * — a real listening UDS server the test parent owns, so a false "denied"
 * report can't be explained by ECONNREFUSED/ENOENT instead of the guard.
 *
 * NOT registered in `src/orchestrator.ts` — fixture-only, never a
 * production connector.
 */

import net from "node:net";
import type { RecordData, ValidateRecord } from "../connector-runtime.ts";
import { runConnector } from "../connector-runtime.ts";

const validateRecord: ValidateRecord = (_stream: string, data: RecordData) => ({ ok: true, data });

runConnector({
  name: "scenario-fidelity-uds-guard-connector",
  validateRecord,
  async collect({ emit, emitRecord }) {
    const baseUrl = process.env.PDPP_SCENARIO_FIDELITY_BASE_URL;
    const foreignSocketPath = process.env.PDPP_SCENARIO_FIDELITY_FOREIGN_SOCKET;
    if (!baseUrl) {
      throw new Error("scenario-fidelity-uds-guard-connector: PDPP_SCENARIO_FIDELITY_BASE_URL is not set");
    }
    if (!foreignSocketPath) {
      throw new Error("scenario-fidelity-uds-guard-connector: PDPP_SCENARIO_FIDELITY_FOREIGN_SOCKET is not set");
    }

    await emit({ type: "PROGRESS", stream: "items", message: "proving the UDS bridge guard" });

    // Own bridge, over the UDS transport: must succeed.
    const res = await fetch(new URL("/ping", baseUrl));
    const body = (await res.json()) as { ok: boolean };
    await emitRecord("items", { id: "own-bridge-fetch", ok: body.ok });

    // A foreign UDS path, dialed directly via net.connect: must be denied.
    let foreignConnectDenied = false;
    let foreignConnectErrorMessage = "";
    await new Promise<void>((resolve) => {
      try {
        const socket = net.connect({ path: foreignSocketPath }, () => {
          socket.destroy();
          resolve();
        });
        socket.on("error", (err) => {
          foreignConnectDenied = true;
          foreignConnectErrorMessage = err instanceof Error ? err.message : String(err);
          resolve();
        });
      } catch (err) {
        foreignConnectDenied = true;
        foreignConnectErrorMessage = err instanceof Error ? err.message : String(err);
        resolve();
      }
    });
    await emitRecord("items", {
      id: "foreign-uds-escape-attempt",
      foreign_connect_denied: foreignConnectDenied,
      foreign_connect_error_message: foreignConnectErrorMessage,
    });

    await emit({ type: "STATE", stream: "items", cursor: { done: true } });
  },
});
