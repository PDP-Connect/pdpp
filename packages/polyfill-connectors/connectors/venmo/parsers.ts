// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure parsers for the Venmo connector. Kept free of fetch / Node I/O so
// they can be unit-tested in isolation (see parsers.test.ts). The HTTP
// client, login handshake, and pagination loops live in index.ts.

import type { RecordData } from "../../src/connector-runtime.ts";
import type { VenmoStory, VenmoUser } from "./types.ts";

export const API_BASE = "https://api.venmo.com/v1";

/** Venmo's `amount` is a float in major units (dollars); PDPP records integer cents. */
export function dollarsToCents(amount: number | null | undefined): number {
  if (typeof amount !== "number" || Number.isNaN(amount)) {
    return 0;
  }
  return Math.round(amount * 100);
}

export function userRecord(u: VenmoUser): RecordData {
  return {
    id: u.id,
    username: u.username ?? null,
    first_name: u.first_name ?? null,
    last_name: u.last_name ?? null,
    display_name: u.display_name ?? null,
    phone: u.phone ?? null,
    profile_picture_url: u.profile_picture_url ?? null,
    about: u.about ?? null,
    date_joined: u.date_joined ?? null,
    is_group: u.is_group ?? null,
    is_active: u.is_active ?? null,
  };
}

export function profileRecord(u: VenmoUser): RecordData {
  return {
    id: u.id,
    username: u.username ?? null,
    first_name: u.first_name ?? null,
    last_name: u.last_name ?? null,
    display_name: u.display_name ?? null,
    phone: u.phone ?? null,
    profile_picture_url: u.profile_picture_url ?? null,
    about: u.about ?? null,
    date_joined: u.date_joined ?? null,
    is_business: u.is_business ?? null,
  };
}

function counterpartyRecord(u: VenmoUser | null | undefined): RecordData | null {
  if (!u?.id) {
    return null;
  }
  return {
    id: u.id,
    username: u.username ?? null,
    display_name: u.display_name ?? null,
  };
}

/**
 * Transaction ("story") record. `ownerId` is the authenticated profile's own
 * id, used only to derive `is_owner_actor` — never persisted as a foreign
 * concept in the schema beyond that one boolean.
 *
 * Returns `null` for story types this connector does not model (refunds,
 * bank transfers, top-ups, card authorizations/withdrawals, disbursements —
 * see venmo_api/models/transaction.py's TransactionType enum). Those never
 * carry a `payment` object in the documented shape, so they cannot be
 * represented by this schema without inventing fields; skipping them is
 * honest non-support, not data loss of a stream we claim to cover.
 */
export function transactionRecord(story: VenmoStory, ownerId: string): RecordData | null {
  const { payment } = story;
  if (!(story.id && payment)) {
    return null;
  }
  const actionRaw = payment.action;
  if (actionRaw !== "pay" && actionRaw !== "charge") {
    return null;
  }
  const { date_created: dateCreated } = story;
  if (!dateCreated) {
    return null;
  }
  return {
    id: story.id,
    payment_id: payment.id ?? null,
    date_created: dateCreated,
    date_updated: story.date_updated ?? null,
    date_completed: payment.date_completed ?? null,
    payment_type: actionRaw,
    amount_cents: dollarsToCents(payment.amount),
    audience: story.audience ?? null,
    status: payment.status ?? null,
    note: payment.note ?? null,
    device_used: story.app?.name ?? null,
    actor: counterpartyRecord(payment.actor),
    target: counterpartyRecord(payment.target?.user),
    is_owner_actor: payment.actor?.id === ownerId,
  };
}
