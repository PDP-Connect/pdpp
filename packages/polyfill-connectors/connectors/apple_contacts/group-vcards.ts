// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Recognition of Apple's group vCards, and the `contact_groups` completeness
// anchor built on it.
//
// THE PROBLEM THIS SOLVES
// -----------------------
// `contact_groups` is a manifest-REQUIRED stream that has emitted zero
// records for this owner, ever — including zero tombstones. Two very
// different worlds produce that same zero:
//
//   (a) the address book genuinely has no groups, or
//   (b) the connector cannot see the groups it has.
//
// Until now the connector could not tell them apart, and a required stream
// sitting at zero for an unfalsifiable reason is exactly the defect this
// work exists to eliminate.
//
// The connector derives groups from the standards-based vCard `CATEGORIES`
// property (RFC 6350 §6.7.1). That derivation is sound as far as it goes.
// But Apple/iCloud does not represent groups with CATEGORIES: it stores each
// group as its OWN vCard resource in the same collection, marked
// `X-ADDRESSBOOKSERVER-KIND:group`, whose members are listed as
// `X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:<uid>` lines.
//
// So for an iCloud account, (b) was the live behaviour and the connector
// reported it as (a).
//
// THE SECOND, WORSE CONSEQUENCE
// -----------------------------
// A group vCard is a real resource in the collection, so the enumeration
// fetches it and the contact emitter emits it AS A CONTACT — a phantom whose
// `display_name` is the group's name, counted as a covered contact. Nothing
// in the emit path checked `KIND`. `isGroupVCard` is what lets the caller
// keep groups out of `contacts`.
//
// THE ANCHOR
// ----------
// CardDAV enumerates the collection fully, so the set of resources is
// measured at the SOURCE boundary. Partitioning that enumerated set by KIND
// yields a real denominator for `contact_groups`: the number of group vCards
// the server actually holds. Comparing it against what was emitted turns the
// unfalsifiable zero into a checkable claim — and a zero that survives the
// check is now genuine evidence of an empty account rather than an absence
// of evidence.
//
// CEILING, stated honestly
// ------------------------
// This anchors groups as iCloud REPRESENTS them. Two group sources are
// unified here — Apple group vCards and CATEGORIES — and a group expressed
// only through CATEGORIES on contacts still has no independent server-side
// resource to count, so its denominator contribution is derived, not
// measured. `groupAnchor` reports those two populations separately for that
// reason; it never merges a derived count into the measured one.

import type { ParsedVCard } from "./vcard.ts";

/** RFC 6350 §6.1.4 defines `KIND`; Apple ships the pre-standard
 *  `X-ADDRESSBOOKSERVER-KIND` on iCloud. Both are accepted so a standards
 *  -compliant server and iCloud are read the same way. */
const KIND_PROPERTY_NAMES = ["X-ADDRESSBOOKSERVER-KIND", "KIND"];

/** Apple's member property. RFC 6350 §6.6.5 standardises `MEMBER`; iCloud
 *  ships the `X-ADDRESSBOOKSERVER-` prefixed form. */
const MEMBER_PROPERTY_NAMES = ["X-ADDRESSBOOKSERVER-MEMBER", "MEMBER"];

/** Members are listed as `urn:uuid:<uid>`. The prefix is stripped so a
 *  member uid compares equal to the `UID` the same server reports on the
 *  member's own vCard, which `vcard.ts` already strips identically. */
const URN_UUID_PREFIX_RE = /^urn:uuid:/i;

function rawValues(card: ParsedVCard, names: readonly string[]): string[] {
  const wanted = new Set(names.map((n) => n.toUpperCase()));
  return card.rawProperties.filter((p) => wanted.has(p.name.toUpperCase())).map((p) => p.value.trim());
}

/**
 * True when this vCard is a GROUP rather than a person.
 *
 * Fails SAFE toward "contact": a resource is only treated as a group when
 * the server explicitly said so. An unrecognised or absent KIND means the
 * resource keeps its existing treatment as a contact, so this predicate can
 * never silently remove a real person from `contacts`.
 */
export function isGroupVCard(card: ParsedVCard): boolean {
  return rawValues(card, KIND_PROPERTY_NAMES).some((v) => v.toLowerCase() === "group");
}

/**
 * The member UIDs a group vCard lists, `urn:uuid:` prefix stripped and
 * blanks dropped. Order is preserved and duplicates are removed, so the
 * result is a stable set-like list suitable for a record body.
 */
export function groupMemberUids(card: ParsedVCard): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of rawValues(card, MEMBER_PROPERTY_NAMES)) {
    const uid = value.replace(URN_UUID_PREFIX_RE, "").trim();
    if (uid && !seen.has(uid)) {
      seen.add(uid);
      out.push(uid);
    }
  }
  return out;
}

/** The enumerated collection, partitioned by what each resource actually is. */
export interface VCardPartition<T> {
  contacts: T[];
  groups: T[];
}

/**
 * Split an enumerated collection into person vCards and group vCards.
 *
 * This is the single place that decides what a resource IS, so the contact
 * emitter and the group anchor cannot disagree about it — the phantom-contact
 * defect was precisely such a disagreement, with no partition at all.
 */
export function partitionVCards<T extends { card: ParsedVCard }>(resources: readonly T[]): VCardPartition<T> {
  const contacts: T[] = [];
  const groups: T[] = [];
  for (const resource of resources) {
    if (isGroupVCard(resource.card)) {
      groups.push(resource);
    } else {
      contacts.push(resource);
    }
  }
  return { contacts, groups };
}

/**
 * The `contact_groups` completeness anchor for one address book.
 *
 * `serverGroupVCards` is the MEASURED denominator: group resources the
 * server itself enumerated. `derivedCategoryGroups` is reported alongside it
 * but deliberately kept separate — it is derived from contact bodies, not
 * measured at the boundary, and merging the two would manufacture a
 * denominator partly out of the data it is meant to verify.
 */
export interface GroupAnchor {
  /** True only when the enumeration reached a complete boundary. */
  boundaryEstablished: boolean;
  /** Distinct group names derived from contacts' CATEGORIES. Derived, not measured. */
  derivedCategoryGroups: number;
  /** Group records actually emitted this run. */
  emitted: number;
  /** Group vCards the server enumerated. Measured at the source boundary. */
  serverGroupVCards: number;
}

export type GroupAnchorVerdict =
  /** Enumeration was incomplete; no claim about completeness is possible. */
  | { status: "unproven"; reason: "boundary_not_established" }
  /** The server enumerated no groups and no CATEGORIES groups were derived.
   *  This is a CHECKED zero — genuine evidence of an empty account. */
  | { status: "empty_confirmed" }
  /** Every group the server holds is accounted for in what was emitted. */
  | { status: "complete"; considered: number; covered: number }
  /** The server holds groups that were not emitted. */
  | { status: "short"; considered: number; covered: number; missing: number };

/**
 * Turn the measured anchor into a verdict.
 *
 * The comparison is one-directional on purpose. Emitting MORE groups than
 * the server enumerated as group vCards is normal and correct: CATEGORIES
 * groups have no server-side resource, so they legitimately add to the
 * emitted count without adding to the measured denominator. Only "the server
 * holds groups we did not emit" is a gap.
 *
 * This mirrors the deletion-safe reasoning used elsewhere in the fleet: a
 * two-way equality would flag correct behaviour as failure.
 */
export function groupAnchorVerdict(anchor: GroupAnchor): GroupAnchorVerdict {
  if (!anchor.boundaryEstablished) {
    return { status: "unproven", reason: "boundary_not_established" };
  }
  if (anchor.serverGroupVCards === 0 && anchor.derivedCategoryGroups === 0 && anchor.emitted === 0) {
    return { status: "empty_confirmed" };
  }
  const considered = anchor.serverGroupVCards;
  const covered = Math.min(anchor.emitted, considered);
  if (covered < considered) {
    return { status: "short", considered, covered, missing: considered - covered };
  }
  return { status: "complete", considered, covered };
}
