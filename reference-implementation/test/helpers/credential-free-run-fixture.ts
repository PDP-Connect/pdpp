// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Generic run-route fixtures exercise controller behavior, not provider
 * authentication. Injecting this resolver keeps those tests independent of
 * whichever shipped manifest supplies their connector identity.
 */
export function resolveCredentialFreeFixtureRunEnv(): Promise<null> {
  return Promise.resolve(null);
}
