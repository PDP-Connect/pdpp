// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export type ExploreRange = "today" | "7d" | "30d" | "all";

const RANGE_DAYS: Record<Exclude<ExploreRange, "all">, number> = { today: 0, "7d": 6, "30d": 29 };
const DAY_MS = 86_400_000;

/** ISO `since` for a relative range, or "" for "all". */
export function sinceForRange(range: ExploreRange, nowMs = Date.now()): string {
  if (range === "all") {
    return "";
  }
  const since = nowMs - RANGE_DAYS[range] * DAY_MS;
  return new Date(since).toISOString().slice(0, 10);
}

export function activeRangeKey(state: { since: string; until: string }, nowMs = Date.now()): ExploreRange | "custom" {
  if (!(state.since || state.until)) {
    return "all";
  }
  if (state.until) {
    return "custom";
  }
  for (const key of ["today", "7d", "30d"] as const) {
    if (state.since === sinceForRange(key, nowMs)) {
      return key;
    }
  }
  return "custom";
}

export function toggleIdSelection(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id];
}

/**
 * The keyboard row-action contract (design.md §6), as a pure decision so it is
 * fully unit-testable instead of buried in a JSX handler:
 *
 *   - ArrowDown / ArrowUp → move the selection (`move-down` / `move-up`).
 *   - Enter               → open the in-place PEEK (`peek`) — the desktop inspect.
 *   - Cmd/Ctrl-Enter      → escalate to the FULL record route (`open-full`) — the
 *                           same peek-vs-open distinction the row click vs Open
 *                           button makes (feedback #12).
 *   - Escape              → clear the selection / peek (`clear`).
 *   - anything else       → `none` (the handler does not preventDefault).
 *
 * Returns the action AND whether the key event should be default-prevented, so a
 * caller never has to re-derive that. Multi-select is intentionally absent — there
 * is no Shift/Cmd-click range or toggle action here (design.md §6).
 */
export type RowKeyAction = "move-down" | "move-up" | "peek" | "open-full" | "clear" | "none";

export interface RowKeyEvent {
  /** Ctrl (Windows/Linux) modifier. */
  ctrlKey?: boolean;
  key: string;
  /** Cmd (macOS) modifier. */
  metaKey?: boolean;
}

export function resolveRowKeyAction(event: RowKeyEvent): { action: RowKeyAction; preventDefault: boolean } {
  switch (event.key) {
    case "ArrowDown":
      return { action: "move-down", preventDefault: true };
    case "ArrowUp":
      return { action: "move-up", preventDefault: true };
    case "Enter":
      // The modifier ESCALATES from peek to the full record route (#12).
      return { action: event.metaKey || event.ctrlKey ? "open-full" : "peek", preventDefault: true };
    case "Escape":
      return { action: "clear", preventDefault: true };
    default:
      return { action: "none", preventDefault: false };
  }
}

export interface CompleteStreamHrefSubject {
  connectionId: string | null;
  connectorId: string;
  stream: string;
}

export interface CompleteStreamHrefState {
  exactFilters?: readonly { key: string; value: string }[];
  order?: "newest" | "oldest";
}

// Route identity for the records routes: prefer the concrete connection id so
// multi-account connector streams stay distinct; fall back to connectorId only
// for search rows that carry no connection binding yet. Single source of truth.
function recordsRouteId(subject: CompleteStreamHrefSubject): string {
  return subject.connectionId && subject.connectionId.length > 0 ? subject.connectionId : subject.connectorId;
}

/**
 * Full-page record DETAIL href: /sources/[connector]/[stream]/[recordKey].
 *
 * Built from clean encoded PATH SEGMENTS — deliberately NOT by appending the
 * record key to the stream href. The stream href carries an `?order=desc` query;
 * appending `/<recordKey>` after a query string produces the malformed
 * `.../<stream>?order=desc/<recordKey>`, where the key is swallowed into the
 * order value and the path is only `[connector]/[stream]` — so the tap lands on
 * the whole-stream LIST instead of the record (breaking mobile record-open,
 * where the desktop inspector is hidden). The detail route needs no sort param.
 */
export function buildRecordDetailHref(
  recordsBasePath: string,
  subject: CompleteStreamHrefSubject & { recordId: string }
): string {
  return [
    recordsBasePath,
    encodeURIComponent(recordsRouteId(subject)),
    encodeURIComponent(subject.stream),
    encodeURIComponent(subject.recordId),
  ].join("/");
}

export function buildCompleteStreamHref(
  recordsBasePath: string,
  subject: CompleteStreamHrefSubject,
  state: CompleteStreamHrefState = {}
): string {
  const routeId = recordsRouteId(subject);
  const path = [recordsBasePath, encodeURIComponent(routeId), encodeURIComponent(subject.stream)].join("/");
  const params = new URLSearchParams();

  for (const filter of state.exactFilters ?? []) {
    if (!(filter.key && filter.value)) {
      continue;
    }
    params.append(`filter[${filter.key}]`, filter.value);
  }
  if (state.order === "newest") {
    params.set("order", "desc");
  } else if (state.order === "oldest") {
    params.set("order", "asc");
  }

  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}
