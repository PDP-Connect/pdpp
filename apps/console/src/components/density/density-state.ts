// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export const DENSITY_KEY = "pdpp-density";

export const DENSITY_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export type Density = "comfortable" | "compact";

export function normalizeDensity(value: unknown): Density {
  return value === "compact" ? "compact" : "comfortable";
}

export function buildDensityCookie(density: Density, secure: boolean): string {
  const secureAttribute = secure ? "; Secure" : "";

  if (density === "comfortable") {
    return `${DENSITY_KEY}=; Path=/; SameSite=Lax; Max-Age=0${secureAttribute}`;
  }

  return `${DENSITY_KEY}=compact; Path=/; SameSite=Lax; Max-Age=${DENSITY_COOKIE_MAX_AGE_SECONDS}${secureAttribute}`;
}
