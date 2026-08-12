// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { basicIntrospectionAuthorization } from "../../server/introspection-http.ts";
import { TEST_RS_INTROSPECTION_CREDENTIALS } from "./introspection-test-credentials.ts";

const INTROSPECTION_AUTHORIZATION = basicIntrospectionAuthorization(TEST_RS_INTROSPECTION_CREDENTIALS);

export function introspectionHeaders(contentType = "application/json"): Record<string, string> {
  return { Authorization: INTROSPECTION_AUTHORIZATION, "Content-Type": contentType };
}
