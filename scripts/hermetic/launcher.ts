// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Put the test guard ahead of the test program and pass it to Node descendants.
// The preload itself stays inert unless this launcher sets the opt-in flag.
const preload = new URL("./preload.mjs", import.meta.url).href;
const serviceCredentialName = /(?:_TOKEN|_SECRET|_PASSWORD|_API_KEY)$|^PGPASSWORD$/i;

// Remove inherited service credentials. A launcher that merges a suite's own
// environment calls this first, so the values the suite declares survive.
export function withoutServiceCredentials(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...inherited };
  for (const name of Object.keys(environment)) {
    if (serviceCredentialName.test(name)) {
      delete environment[name];
    }
  }
  return environment;
}

// Install the guard last, so no later environment layer can switch it off.
export function withTestGuard(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const options = environment.NODE_OPTIONS ?? "";
  return {
    ...environment,
    NODE_OPTIONS: options.includes(preload) ? options : `--import ${preload}${options ? ` ${options}` : ""}`,
    PDPP_HERMETIC_GUARD: "1",
  };
}

export function hermeticTestEnvironment(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return withTestGuard(withoutServiceCredentials(inherited));
}
