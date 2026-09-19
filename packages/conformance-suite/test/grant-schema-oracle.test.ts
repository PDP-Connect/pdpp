// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Discrimination proof for the Section 7 grant schema validator that AS-3's
// `issued-grant-artifact-matches-section-7-schema` case uses as its oracle.
//
// Protected risk: a validator that accepts everything. AS-3 reports `pass` on an
// empty violation list, so a validator with a typo'd key name, a check behind an
// unreachable branch, or a rule it never wrote would certify a malformed grant as
// Section 7 conforming — the exact failure that makes a conformance report worse
// than no report.
//
// The oracle is independent of the validator's own code: the conforming baseline
// is transcribed from spec-core.md Section 7's normative grant example, and each
// mutant below names the spec rule it breaks plus the artifact path the validator
// must point at. A validator that stops enforcing a row fails here rather than
// silently widening what AS-3 accepts. Cheaper alternatives do not work: reading
// the validator's source cannot show a branch is reachable, and running AS-3
// against the Vana target only exercises the missing-artifact skip path, because
// that target's approval route returns no grant body.
//
// Deliberately NOT used as the oracle: the reference implementation's own grant
// validator. An implementation cannot be the conformance oracle for itself.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { grantSchemaViolations } from "../src/harness/grant-schema.ts";
import { makeContext, runCase } from "../src/harness/runner.ts";
import { ReferenceTargetAdapter } from "../src/targets/reference-adapter.ts";
import { AUTHORIZATION_SERVER_CASES } from "../src/tests/authorization-server.ts";

/** Hoisted per useTopLevelRegex: the missing-version mutant must name the field. */
const VERSION_MENTIONED = /version/;

/**
 * spec-core.md Section 7 "### Grant fields", the normative example, transcribed
 * verbatim. Every mutant below is this object with one rule broken.
 */
function conformingGrant(): Record<string, unknown> {
  return {
    version: "0.1.0",
    grant_id: "grt_8f72a1b3",
    issued_at: "2026-04-06T15:00:00Z",
    subject: { id: "user_abc123" },
    client: { client_id: "music_recommendations" },
    source: { kind: "connector", id: "https://registry.pdpp.dev/connectors/spotify" },
    source_declaration: { version: "2026-08-11" },
    purpose_code: "https://pdpp.dev/purpose/personalization",
    purpose_description: "Recommend concerts based on your listening history",
    access_mode: "single_use",
    streams: [
      {
        name: "top_artists",
        instance_ids: ["spotify-account-a"],
        fields: ["id", "name", "genres", "popularity", "source_updated_at"],
        time_constraint: { field: "source_updated_at", since: "2025-09-28T00:00:00Z" },
      },
    ],
    retention: { max_duration: "P1Y", on_expiry: "delete" },
    expires_at: "2027-04-06T00:00:00Z",
  };
}

/** Apply a single mutation to a fresh copy of the conforming baseline. */
function mutate(apply: (grant: Record<string, unknown>) => void): unknown {
  const grant = conformingGrant();
  apply(grant);
  return grant;
}

function firstStream(grant: Record<string, unknown>): Record<string, unknown> {
  const [stream] = grant.streams as Record<string, unknown>[];
  assert.ok(stream, "The baseline grant always carries one stream.");
  return stream;
}

/**
 * Remove keys entirely. An `undefined` assignment will not do: Section 7's
 * required rows are about key ABSENCE, and a validator checking `in` rather than
 * the value would see a present key and let the mutant through.
 */
function without(target: Record<string, unknown>, ...keys: readonly string[]): void {
  for (const key of keys) {
    Reflect.deleteProperty(target, key);
  }
}

/**
 * Each row states the Section 7 rule broken, the mutation, and the artifact path
 * the validator must name. `path` is asserted so a validator that rejects the
 * mutant for an unrelated reason does not count as discriminating.
 */
const MUTANTS: readonly {
  readonly rule: string;
  readonly path: string;
  readonly mutate: (grant: Record<string, unknown>) => void;
}[] = [
  // --- Grant fields table ---
  {
    rule: "`version` must be exactly 0.1.0",
    path: "version",
    mutate: (g) => {
      g.version = "0.2.0";
    },
  },
  {
    rule: "`grant_id` is required",
    path: "grant_id",
    mutate: (g) => {
      without(g, "grant_id");
    },
  },
  {
    rule: "`issued_at` is required",
    path: "issued_at",
    mutate: (g) => {
      without(g, "issued_at");
    },
  },
  {
    rule: "`issued_at` is a string, not a number of epoch seconds",
    path: "issued_at",
    mutate: (g) => {
      g.issued_at = 1_775_487_600;
    },
  },
  {
    rule: "`subject` is exactly `{ id }`",
    path: "subject.id",
    mutate: (g) => {
      g.subject = {};
    },
  },
  {
    rule: "`subject` carries no key beyond `id`",
    path: "subject.email",
    mutate: (g) => {
      g.subject = { id: "user_abc123", email: "owner@example.test" };
    },
  },
  {
    rule: "`client` is exactly `{ client_id }` or `{ client_id, client_display }`",
    path: "client.client_id",
    mutate: (g) => {
      g.client = { client_display: { name: "Music" } };
    },
  },
  {
    rule: "`source` is exactly `{ kind, id }`",
    path: "source.kind",
    mutate: (g) => {
      g.source = { id: "https://registry.pdpp.dev/connectors/spotify" };
    },
  },
  {
    rule: "`source_declaration` is `{ version }`",
    path: "source_declaration.version",
    mutate: (g) => {
      g.source_declaration = {};
    },
  },
  {
    rule: "`purpose_code` is a required URI",
    path: "purpose_code",
    mutate: (g) => {
      without(g, "purpose_code");
    },
  },
  {
    rule: "`access_mode` is `single_use` or `continuous`",
    path: "access_mode",
    mutate: (g) => {
      g.access_mode = "recurring";
    },
  },
  {
    rule: "`streams` is a required non-empty array",
    path: "streams",
    mutate: (g) => {
      g.streams = [];
    },
  },
  {
    rule: "`retention.on_expiry` excludes `archive` in v0.1",
    path: "retention.on_expiry",
    mutate: (g) => {
      g.retention = { max_duration: "P1Y", on_expiry: "archive" };
    },
  },
  {
    rule: "`retention.max_duration` is required whenever `retention` is present",
    path: "retention.max_duration",
    mutate: (g) => {
      g.retention = { on_expiry: "delete" };
    },
  },
  {
    rule: "`retention` is an object, not a bare duration string",
    path: "retention",
    mutate: (g) => {
      g.retention = "P1Y";
    },
  },
  {
    rule: "`expires_at`, when present, is a string — `null` is not how Section 7 spells no expiry (absence is)",
    path: "expires_at",
    mutate: (g) => {
      g.expires_at = null;
    },
  },
  {
    rule: "`client_claims` must remain outside the resolved grant",
    path: "client_claims",
    mutate: (g) => {
      g.client_claims = { attributed_to: "Music", commitments: ["we will be careful"] };
    },
  },
  // --- StreamGrant fields table ---
  {
    rule: "StreamGrant `name` is always concrete; no wildcards in issued grants",
    path: "streams[0].name",
    mutate: (g) => {
      firstStream(g).name = "*";
    },
  },
  {
    rule: "StreamGrant `name` is required",
    path: "streams[0].name",
    mutate: (g) => {
      without(firstStream(g), "name");
    },
  },
  {
    rule: "StreamGrant `instance_ids` is required",
    path: "streams[0].instance_ids",
    mutate: (g) => {
      without(firstStream(g), "instance_ids");
    },
  },
  {
    rule: "StreamGrant `instance_ids` is non-empty — an empty list means fan-in was never resolved",
    path: "streams[0].instance_ids",
    mutate: (g) => {
      firstStream(g).instance_ids = [];
    },
  },
  {
    rule: "StreamGrant `instance_ids` members are unique",
    path: "streams[0].instance_ids",
    mutate: (g) => {
      firstStream(g).instance_ids = ["spotify-account-a", "spotify-account-a"];
    },
  },
  {
    rule: "StreamGrant `fields` is required",
    path: "streams[0].fields",
    mutate: (g) => {
      without(firstStream(g), "fields");
    },
  },
  {
    rule: "StreamGrant `fields` is non-empty",
    path: "streams[0].fields",
    mutate: (g) => {
      firstStream(g).fields = [];
    },
  },
  {
    rule: "StreamGrant `fields` is resolved; a wildcard is not a resolved allowlist",
    path: "streams[0].fields",
    mutate: (g) => {
      firstStream(g).fields = ["*"];
    },
  },
  {
    rule: "StreamGrant `fields` members are unique",
    path: "streams[0].fields",
    mutate: (g) => {
      firstStream(g).fields = ["id", "id"];
    },
  },
  {
    rule: "`time_constraint.field` is required whenever `time_constraint` is present",
    path: "streams[0].time_constraint.field",
    mutate: (g) => {
      firstStream(g).time_constraint = { since: "2025-09-28T00:00:00Z" };
    },
  },
  {
    rule: "`time_constraint` carries at least one of `since`/`until`",
    path: "streams[0].time_constraint",
    mutate: (g) => {
      firstStream(g).time_constraint = { field: "source_updated_at" };
    },
  },
  {
    rule: "`time_constraint` bounds, when present, are strings",
    path: "streams[0].time_constraint.until",
    mutate: (g) => {
      firstStream(g).time_constraint = { field: "source_updated_at", until: 1_775_487_600 };
    },
  },
  {
    rule: "`resources`, when present, is a `string[]` — not a bare string",
    path: "streams[0].resources",
    mutate: (g) => {
      firstStream(g).resources = "record-1";
    },
  },
  {
    rule: "`resources` members are strings",
    path: "streams[0].resources",
    mutate: (g) => {
      firstStream(g).resources = [7];
    },
  },
  {
    rule: "`client_display`, when retained, is resolved identity metadata — not a scalar",
    path: "client.client_display",
    mutate: (g) => {
      g.client = { client_id: "music_recommendations", client_display: "Music" };
    },
  },
  {
    rule: "each stream `name` is unique within the grant",
    path: "streams",
    mutate: (g) => {
      g.streams = [firstStream(g), { ...firstStream(g) }];
    },
  },
];

describe("Section 7 grant schema oracle", () => {
  it("accepts the spec's own normative grant example", () => {
    assert.deepEqual(grantSchemaViolations(conformingGrant()), []);
  });

  it("accepts a grant omitting every optional field", () => {
    const grant = conformingGrant();
    for (const optional of ["purpose_description", "retention", "expires_at"]) {
      without(grant, optional);
    }
    without(firstStream(grant), "time_constraint");
    assert.deepEqual(grantSchemaViolations(grant), []);
  });

  it("accepts `client_display` alongside `client_id`", () => {
    const grant = conformingGrant();
    grant.client = { client_id: "music_recommendations", client_display: { name: "Music" } };
    assert.deepEqual(grantSchemaViolations(grant), []);
  });

  for (const mutant of MUTANTS) {
    it(`rejects: ${mutant.rule}`, () => {
      const violations = grantSchemaViolations(mutate(mutant.mutate));
      assert.ok(violations.length > 0, `Mutant passed the validator, so the oracle does not enforce: ${mutant.rule}`);
      assert.ok(
        violations.some((v) => v.path === mutant.path),
        `Expected a violation at ${mutant.path}, got ${JSON.stringify(violations.map((v) => v.path))}. The validator rejected this mutant for an unrelated reason, so it does not discriminate on this rule.`
      );
    });
  }

  // The validator's declared ceiling, asserted so it cannot drift silently into
  // either over- or under-enforcement. Section 7 says "ISO 8601" and no more, so
  // a hand-written pattern here would fail targets for a rule the spec never
  // wrote (ISO 8601 admits date-only, offsets, week dates, fractional duration
  // components). These artifacts are accepted deliberately: the row's lexical
  // form is out of this oracle's scope, and AS-3 reports it as a partial.
  it("does not enforce ISO 8601 lexical form, by design", () => {
    for (const grant of [
      mutate((g) => {
        g.issued_at = "2026-04-06";
      }),
      mutate((g) => {
        g.expires_at = "2027-W14-2T00:00:00+02:00";
      }),
      mutate((g) => {
        g.retention = { max_duration: "P0.5Y", on_expiry: "delete" };
      }),
      mutate((g) => {
        firstStream(g).time_constraint = { field: "source_updated_at", since: "not-a-date" };
      }),
    ]) {
      assert.deepEqual(
        grantSchemaViolations(grant),
        [],
        "Temporal lexical form is out of scope; a violation here means the validator quietly narrowed the spec."
      );
    }
  });

  // Restrictions the spec does NOT state, pinned as accepted so the validator
  // cannot drift into failing a conformant target for an unwritten rule. Unlike
  // `instance_ids` and `fields`, whose rows say "Unique non-empty" in so many
  // words, the `resources` row states type only ("string[] ... Absent means all
  // records"), and `purpose_description`/`selection_preset` are plain `string`
  // rows with no non-empty requirement.
  it("does not invent constraints the field tables omit", () => {
    for (const grant of [
      mutate((g) => {
        firstStream(g).resources = [];
      }),
      mutate((g) => {
        firstStream(g).resources = ["record-1", "record-1"];
      }),
      mutate((g) => {
        firstStream(g).resources = [""];
      }),
      mutate((g) => {
        g.purpose_description = "";
      }),
      mutate((g) => {
        g.selection_preset = "";
      }),
    ]) {
      assert.deepEqual(
        grantSchemaViolations(grant),
        [],
        "Section 7 states no such rule, so reporting a violation here would fail a conformant target."
      );
    }
  });

  it("rejects a non-object artifact rather than throwing", () => {
    for (const artifact of [null, undefined, "grt_1", 7, [], true]) {
      const violations = grantSchemaViolations(artifact);
      assert.ok(violations.length > 0, `Expected ${JSON.stringify(artifact)} to be rejected.`);
    }
  });

  it("reports every violation, not only the first", () => {
    const violations = grantSchemaViolations(
      mutate((g) => {
        without(g, "grant_id", "purpose_code");
        firstStream(g).fields = [];
      })
    );
    const paths = violations.map((v) => v.path);
    for (const expected of ["grant_id", "purpose_code", "streams[0].fields"]) {
      assert.ok(paths.includes(expected), `Missing ${expected} in ${JSON.stringify(paths)}`);
    }
  });
});

describe("AS-3 consumes the returned artifact", () => {
  for (const [variant, expected] of [
    ["valid", "pass"],
    ["missing-version", "fail"],
    ["absent", "skip"],
  ] as const) {
    it(`${variant} artifact produces ${expected}`, async () => {
      const adapter = new ReferenceTargetAdapter();
      const issueGrant = adapter.issueGrant.bind(adapter);
      adapter.issueGrant = async (request) => {
        const issued = await issueGrant(request);
        if (!issued || variant === "absent") {
          return issued;
        }
        const rawGrant = conformingGrant();
        if (variant === "missing-version") {
          rawGrant.version = undefined;
        }
        return { ...issued, rawGrant };
      };
      const { streams } = await adapter.setup();
      try {
        const testCase = AUTHORIZATION_SERVER_CASES.find(
          (c) => c.caseId === "AS-3/issued-grant-artifact-matches-section-7-schema"
        );
        assert.ok(testCase);
        const result = await runCase(testCase, makeContext(adapter, streams));
        assert.equal(result.outcome, expected, result.detail ?? "unexpected outcome");
        if (variant === "missing-version") {
          assert.match(result.detail ?? "", VERSION_MENTIONED);
        }
      } finally {
        await adapter.teardown();
      }
    });
  }
});
