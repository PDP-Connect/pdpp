// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { USAA_SAFE_DIAGNOSTICS_POLICY } from "../../connectors/usaa/index.ts";
import { runConnector, TerminalError } from "../connector-runtime.ts";

runConnector({
  name: "usaa",
  captureMode: "safe",
  safeDiagnosticsPolicy: USAA_SAFE_DIAGNOSTICS_POLICY,
  browser: { headless: true, profileName: "protocol-subprocess-usaa-session-required" },
  ensureSession() {
    throw new TerminalError(
      "USAA login completed but no verified authenticated dashboard session was detected url=https://www.usaa.com/my/usaa",
      { code: "session_required" }
    );
  },
  collect() {
    throw new Error("collect must not run after ensureSession fails");
  },
});
