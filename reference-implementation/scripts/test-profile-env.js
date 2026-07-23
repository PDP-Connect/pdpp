// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export function storageProfileEnvironment(profile, source) {
  const environment = { ...source };
  if (profile === 'memory-default') delete environment.PDPP_TEST_POSTGRES_URL;
  return environment;
}
