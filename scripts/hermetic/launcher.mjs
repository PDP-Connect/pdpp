// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Put the test guard ahead of the test program and pass it to Node descendants.
// The preload itself stays inert unless this launcher sets the opt-in flag.
const preload = new URL("./preload.ts", import.meta.url).href;
const tsx = import.meta.resolve("tsx");
const serviceCredentialName = /(?:_TOKEN|_SECRET|_PASSWORD|_API_KEY)$|^DATABASE_URL$|^PG[A-Z_]/i;

export function hermeticTestEnvironment(inherited) {
  const environment = { ...inherited, PDPP_HERMETIC_GUARD: "1" };
  for (const name of Object.keys(environment)) {
    if (serviceCredentialName.test(name)) {
      delete environment[name];
    }
  }
  const options = inherited.NODE_OPTIONS ?? "";
  environment.NODE_OPTIONS = options.includes(preload)
    ? options
    : `--import ${tsx} --import ${preload}${options ? ` ${options}` : ""}`;
  return environment;
}
