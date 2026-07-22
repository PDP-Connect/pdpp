// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reference-local convenience defaults.
 *
 * These values are **not** part of the PDPP protocol and are **not** part of
 * the published PDPP contract. They exist so that a developer running the
 * local reference stack can bring up the AS, the dashboard, and the example
 * third-party client without manually provisioning an initial access token
 * or pre-registering the first-party clients. Any production-style deployment
 * is expected to override these through environment variables.
 */

export const DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN = "pdpp-reference-local-initial-access-token";

export interface DefaultPreRegisteredPublicClient {
  readonly client_id: string;
  readonly metadata: {
    readonly client_name: string;
    readonly token_endpoint_auth_method: string;
  };
}

export const DEFAULT_PRE_REGISTERED_PUBLIC_CLIENTS: readonly DefaultPreRegisteredPublicClient[] = Object.freeze([
  {
    client_id: "longview",
    metadata: { client_name: "Longview", token_endpoint_auth_method: "none" },
  },
  {
    client_id: "longview_planning_v1",
    metadata: { client_name: "Longview", token_endpoint_auth_method: "none" },
  },
  {
    client_id: "cli_longview",
    metadata: { client_name: "Longview CLI", token_endpoint_auth_method: "none" },
  },
  {
    client_id: "pdpp_cli",
    metadata: { client_name: "PDPP CLI", token_endpoint_auth_method: "none" },
  },
  {
    client_id: "concert_recommendation_app",
    metadata: {
      client_name: "Concert Recommendation App",
      token_endpoint_auth_method: "none",
    },
  },
  {
    client_id: "pdpp-web-dashboard",
    metadata: {
      client_name: "PDPP Reference Dashboard",
      token_endpoint_auth_method: "none",
    },
  },
  {
    client_id: "pdpp-polyfill-owner-bootstrap",
    metadata: {
      client_name: "PDPP Polyfill Owner Bootstrap",
      token_endpoint_auth_method: "none",
    },
  },
]);
