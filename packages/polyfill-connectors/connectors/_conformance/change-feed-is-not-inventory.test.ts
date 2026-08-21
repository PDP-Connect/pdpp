// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Change-feed-is-not-inventory gate.
 *
 * CONTRACT UNDER TEST
 * -------------------
 * A stream whose manifest declares `coverage_strategy: "full_inventory"` may
 * NOT prove that claim from a run whose executed code path was an incremental
 * DELTA. An empty change feed and an empty inventory are different facts, and
 * only one of them is evidence of anything.
 *
 * RFC 6578 §3.2 is normative here and makes this statically decidable: a
 * sync-collection REPORT carrying an EMPTY `<D:sync-token>` MUST return every
 * member of the collection, while one carrying a NON-EMPTY token returns only
 * what changed since that token. So "the response listed 0 resources" means
 * "0 contacts exist" in the first case and "nothing changed" in the second.
 *
 * THE DEFECT THIS PINS
 * --------------------
 * Apple Contacts declares `full_inventory` on all three of its streams, but
 * its steady-state run issues a sync-collection delta. A quiet run therefore
 * observed 0 changed resources and, before the fix, reported
 * `considered: 0, covered: 0` — which the coherence oracle reads as a
 * measured `enumeration_boundary` proving a verified-EMPTY address book. A
 * required stream holding hundreds of real contacts read Healthy with zero
 * records.
 *
 * The connector now withholds the coverage claim entirely on an incremental
 * run (`contactsBoundaryEstablished`), leaving the stream honestly unproven
 * rather than falsely complete. This gate exists so that behavior cannot
 * silently regress: it drives the REAL connector subprocess against a fake
 * CardDAV server configured to obey RFC 6578 faithfully, with a prior sync
 * token in START state, and asserts no fabricated boundary is emitted.
 *
 * WHY A CONFORMANCE TEST RATHER THAN A LINT OR A MANIFEST RULE
 * -----------------------------------------------------------
 * A manifest-validation rule cannot see which code path executes; it can only
 * read declarations, and the declaration here (`full_inventory`) is correct —
 * the address book genuinely is a full inventory. A lint would have to
 * pattern-match call sites and would be defeated by any indirection.
 *
 * The falsifiable fact is behavioral: given a prior token, does the run emit a
 * coverage boundary it did not measure? Only executing the connector answers
 * that, and this package already has the machinery to do it cheaply and
 * credential-free (`_conformance/coverage-conformance.test.ts` drives the same
 * subprocess against the same fake server). So this extends that pattern
 * rather than introducing a new mechanism.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage } from "@pdpp/connector-protocol";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";
import { buildVCard, startFakeCardDavServer } from "../apple_contacts/test-carddav-server.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BOOK_URL_KEY_SOURCE = "/addressbooks/owner/card/";

interface DetailCoverageLike {
  readonly considered?: number;
  readonly covered?: number;
  readonly stream?: string;
  readonly type?: string;
}

/** Every DETAIL_COVERAGE message the run emitted for a given stream. */
function detailCoverageFor(messages: readonly EmittedMessage[], stream: string): DetailCoverageLike[] {
  return messages.filter(
    (message): message is EmittedMessage & DetailCoverageLike =>
      (message as DetailCoverageLike).type === "DETAIL_COVERAGE" && (message as DetailCoverageLike).stream === stream
  );
}

function recordCountFor(messages: readonly EmittedMessage[], stream: string): number {
  return messages.filter((message) => {
    const shape = message as { stream?: string; type?: string };
    return shape.type === "RECORD" && shape.stream === stream;
  }).length;
}

/**
 * Drive the real Apple Contacts entrypoint against a fake CardDAV server that
 * obeys RFC 6578, optionally handing it a prior sync token so the run takes
 * the incremental path.
 */
async function runAppleContacts(args: { readonly priorSyncToken?: string }): Promise<readonly EmittedMessage[]> {
  const username = "owner@example.com";
  const password = "app-specific-pw";
  const server = await startFakeCardDavServer({
    enforceRfc6578IncrementalSemantics: true,
    password,
    username,
  });
  try {
    // A real, non-empty address book. The whole point is that these contacts
    // exist while the change feed is empty.
    for (const uid of ["contact-one", "contact-two", "contact-three"]) {
      server.contacts.set(uid, {
        href: `${BOOK_URL_KEY_SOURCE}${uid}.vcf`,
        uid,
        vcard: buildVCard({ email: `${uid}@example.com`, fn: `Fixture ${uid}`, uid }),
      });
    }

    // The connector keys per-book cursor state by the book URL with trailing
    // slashes stripped (`addressBookId`), so the state key must match exactly
    // or the prior token is silently ignored and the run takes the full path.
    const bookKeySource = `${server.origin}${BOOK_URL_KEY_SOURCE}`.replace(/\/+$/, "");
    const state = args.priorSyncToken
      ? { contacts: { [bookKeySource]: { fingerprints: {}, sync_token: args.priorSyncToken } } }
      : {};

    const result = await runConnectorProtocolSubprocess({
      allowFailedDone: true,
      cwd: PACKAGE_ROOT,
      entrypoint: join(PACKAGE_ROOT, "connectors/apple_contacts/index.ts"),
      env: { APPLE_APP_SPECIFIC_PASSWORD: password, APPLE_CARDDAV_ORIGIN: server.origin, APPLE_ID: username },
      start: {
        scope: { streams: [{ name: "address_books" }, { name: "contacts" }, { name: "contact_groups" }] },
        state,
        type: "START",
      },
    });
    return result.messages;
  } finally {
    await server.close();
  }
}

test("an initial run (empty sync token) DOES prove the full inventory", async () => {
  // The control case. RFC 6578 requires an empty token to return every member,
  // so this run genuinely enumerates the collection and is entitled to claim a
  // measured boundary. If this stops holding, the gate below would pass
  // vacuously.
  const messages = await runAppleContacts({});

  assert.equal(recordCountFor(messages, "contacts"), 3, "the initial run must emit every contact");

  const coverage = detailCoverageFor(messages, "contacts");
  assert.equal(coverage.length, 1, "the initial run must emit exactly one contacts coverage claim");
  assert.equal(coverage[0]?.considered, 3, "considered must be the measured inventory size");
  assert.equal(coverage[0]?.covered, 3, "covered must satisfy the denominator");
});

test("a quiet INCREMENTAL run must not report an empty change feed as an empty inventory", async () => {
  // The regression guard for the real defect. A prior sync token puts the run
  // on the delta path; the fixture's collection is unchanged, so the change
  // feed is empty while three contacts still exist upstream.
  const messages = await runAppleContacts({ priorSyncToken: "sync-token-1" });

  // The delta legitimately carries no contact records — nothing changed.
  assert.equal(recordCountFor(messages, "contacts"), 0, "a quiet delta emits no contact records");

  const coverage = detailCoverageFor(messages, "contacts");

  // THE ASSERTION THAT MATTERS. Emitting `considered: 0, covered: 0` here is
  // exactly the defect: the coherence oracle reads a measured zero denominator
  // as a proven-empty inventory, so a populated address book would read
  // verified-empty and Healthy. Withholding the claim leaves the stream
  // honestly unproven instead.
  for (const claim of coverage) {
    assert.notEqual(
      claim.considered,
      0,
      "an incremental delta must never emit considered: 0 — that is a change feed being " +
        "reported as an inventory, which the coherence oracle reads as verified-empty"
    );
  }
  assert.equal(
    coverage.length,
    0,
    "a run that established no full boundary must emit NO contacts coverage claim at all; " +
      "silence is the honest verdict, not a fabricated zero"
  );
});

test("the incremental run still commits its cursor, so withholding coverage does not stall sync", async () => {
  // Withholding a coverage CLAIM must not be confused with failing the run.
  // The delta is real progress: its sync token has to persist or the next run
  // would re-walk from the same place forever.
  const messages = await runAppleContacts({ priorSyncToken: "sync-token-1" });

  const stateMessages = messages.filter((message) => {
    const shape = message as { stream?: string; type?: string };
    return shape.type === "STATE" && shape.stream === "contacts";
  });
  assert.ok(stateMessages.length > 0, "the incremental run must still checkpoint its sync token");

  const done = messages.find((message) => (message as { type?: string }).type === "DONE") as
    | { status?: string }
    | undefined;
  assert.equal(done?.status, "succeeded", "a quiet incremental run is a success, not a failure");
});
