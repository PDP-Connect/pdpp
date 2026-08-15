// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared resolution for a scheduler timing knob that accepts an explicit
 * value, falls back to an env var, then a default -- and where `Infinity`
 * is a deliberate "disable this budget" value (`maxRunWallClockMs`,
 * `dispatchLivenessCeilingMs`).
 *
 * An empty or whitespace-only env value is treated as UNSET, never as `0`:
 * `Number("")` coerces to `0`, and without this guard a blank env var
 * (e.g. from deployment templating) would silently resolve to a real,
 * accepted "0" value -- for these knobs, `0` disables the budget, so a
 * blank env var would silently disable a safety mechanism instead of
 * falling back to the safe default.
 */
export function resolveNonNegativeMsOrInfinity(
  value: number | undefined,
  envValue: string | undefined,
  defaultMs: number,
  optionName: string,
  envVarName: string
): number {
  if (value !== undefined) {
    if (value === Number.POSITIVE_INFINITY) {
      return value;
    }
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${optionName} must be a non-negative number or Infinity; got ${value}`);
    }
    return value;
  }
  if (envValue !== undefined && envValue.trim() !== "") {
    if (envValue === "Infinity") {
      return Number.POSITIVE_INFINITY;
    }
    const parsed = Number(envValue);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`${envVarName} must be a non-negative number or "Infinity", got ${envValue}`);
    }
    return parsed;
  }
  return defaultMs;
}
