// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  basicIntrospectionAuthorization,
  LOCAL_RS_INTROSPECTION_CLIENT_ID,
  LOCAL_RS_INTROSPECTION_CLIENT_SECRET,
} from "../../server/introspection-http.ts";

const INTROSPECTION_AUTHORIZATION = basicIntrospectionAuthorization({
  clientId: LOCAL_RS_INTROSPECTION_CLIENT_ID,
  clientSecret: LOCAL_RS_INTROSPECTION_CLIENT_SECRET,
});

export function introspectionHeaders(contentType = "application/json"): Record<string, string> {
  return { Authorization: INTROSPECTION_AUTHORIZATION, "Content-Type": contentType };
}
