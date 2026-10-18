// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// RFC 3339 `full-date` and `date-time` parsing for the bundled target's
// time-range checks (Core Section 6 "Time range bounds", Section 8 "Time
// constraint semantics"). JSON Schema `format` is an annotation, so the target
// applies the grammar itself.

const FULL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function validDate(year: number, month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/** A `full-date` as its calendar-order key, or null when it is not a valid RFC 3339 `full-date`. */
export function parseFullDate(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = FULL_DATE.exec(value);
  if (!match) {
    return null;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return validDate(year, month, day) ? value : null;
}

/**
 * A `date-time` as an exact instant (epoch milliseconds plus the sub-millisecond
 * fraction digits), or null when it is not a valid RFC 3339 `date-time`.
 * A leap second is not accepted.
 */
export function parseDateTime(value: unknown): { readonly ms: number; readonly fraction: string } | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = DATE_TIME.exec(value);
  if (!match) {
    return null;
  }
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (!validDate(year, month, day) || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const zone = match[8] as string;
  let offsetMinutes = 0;
  if (zone !== "Z" && zone !== "z") {
    const [oh, om] = [Number(zone.slice(1, 3)), Number(zone.slice(4, 6))];
    if (oh > 23 || om > 59) {
      return null;
    }
    offsetMinutes = (zone.startsWith("-") ? -1 : 1) * (oh * 60 + om);
  }
  const ms = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000;
  return { ms, fraction: (match[7] ?? "").slice(1) };
}

/** Order two `date-time` instants at full stated precision: negative when a is earlier. */
export function compareDateTimes(
  a: { readonly ms: number; readonly fraction: string },
  b: { readonly ms: number; readonly fraction: string }
): number {
  if (a.ms !== b.ms) {
    return a.ms - b.ms;
  }
  const width = Math.max(a.fraction.length, b.fraction.length);
  const [fa, fb] = [a.fraction.padEnd(width, "0"), b.fraction.padEnd(width, "0")];
  if (fa === fb) {
    return 0;
  }
  return fa < fb ? -1 : 1;
}
