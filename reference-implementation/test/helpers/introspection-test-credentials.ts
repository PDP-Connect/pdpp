// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { IntrospectionCallerCredentials } from "../../server/introspection-http.ts";

export const TEST_RS_INTROSPECTION_CREDENTIALS: IntrospectionCallerCredentials = {
  clientId: "pr89-rs-test",
  clientSecret: "pr89-rs-test-secret",
};

export const TEST_INTROSPECTION_SERVER_OPTS = {
  introspectionCallerCredentials: TEST_RS_INTROSPECTION_CREDENTIALS,
  rsIntrospectionCredentials: TEST_RS_INTROSPECTION_CREDENTIALS,
} as const;
