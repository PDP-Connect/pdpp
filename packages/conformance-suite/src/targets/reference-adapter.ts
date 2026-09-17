// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// The TargetAdapter for the in-process reference target.
//
// This is the worked example a vendor copies to test their own implementation:
// it implements the adapter contract and nothing else, and it holds no
// privilege the contract does not offer everyone. Everything the suite learns
// about the target still arrives over HTTP.
//
// Several methods below are `async` without awaiting: the TargetAdapter
// contract is async because a real adapter does I/O (an HTTP call to mint a
// token, a database seed). This in-process target answers from memory. The
// `async` keyword is part of the contract's shape, not an oversight.

// biome-ignore-all lint/suspicious/useAwait: the TargetAdapter contract is async; this in-process target answers from memory.

import type { GrantRequest, IssuedGrant, SeededStream, TargetAdapter, TargetCapabilities } from "../harness/adapter.ts";
import type { Role } from "../requirements/catalog.ts";
import { type Defect, ReferenceServer, type StreamFixture } from "./reference-server.ts";

/**
 * Two streams with overlapping shape: the negative oracles need a second stream
 * to hold out of a grant, and at least two fields per stream so a projection can
 * be narrowed with something left over to leak.
 */
export const DEFAULT_FIXTURES: readonly StreamFixture[] = [
  {
    name: "conversations",
    fields: ["id", "title", "source_created_at"],
    primaryKey: ["id"],
    cursorField: "source_created_at",
    semantics: "mutable_state",
    records: [
      {
        id: "conv_1",
        title: "Trip planning",
        source_created_at: "2026-03-25T18:22:11Z",
      },
      {
        id: "conv_2",
        title: "Book club",
        source_created_at: "2026-03-26T09:10:00Z",
      },
    ],
  },
  {
    name: "messages",
    fields: ["id", "body", "source_created_at"],
    primaryKey: ["id"],
    cursorField: "source_created_at",
    semantics: "append_only",
    records: [
      {
        id: "msg_1",
        body: "Shall we go in May?",
        source_created_at: "2026-03-25T18:23:00Z",
      },
    ],
  },
];

const CAPABILITIES: TargetCapabilities = {
  separatedDeployment: false,
  ownerTokens: true,
  selfExport: true,
  // The reference target does not implement incremental sync, views, single-use
  // grants, refresh tokens, or blobs. Declaring them absent is what turns the
  // dependent requirements into `unsupported` rather than false passes.
  incrementalSync: false,
  views: false,
  singleUseGrants: false,
  refreshTokens: false,
  blobs: false,
};

const ROLES: readonly Role[] = ["resource-server", "authorization-server"];

export class ReferenceTargetAdapter implements TargetAdapter {
  readonly targetId: string;
  readonly targetVersion = "0.1.0";
  readonly roles = ROLES;
  readonly capabilities = CAPABILITIES;
  private readonly server: ReferenceServer;
  private readonly fixtures: readonly StreamFixture[];

  constructor(fixtures: readonly StreamFixture[] = DEFAULT_FIXTURES, defects: ReadonlySet<Defect> = new Set()) {
    this.fixtures = fixtures;
    this.server = new ReferenceServer(fixtures, defects);
    this.targetId =
      defects.size === 0 ? "pdpp-reference-target" : `pdpp-reference-target+defects(${[...defects].sort().join(",")})`;
  }

  get baseUrl(): string {
    return this.server.baseUrl;
  }

  async setup(): Promise<{ readonly streams: readonly SeededStream[] }> {
    await this.server.start();
    const streams: SeededStream[] = this.fixtures.map((f) => ({
      name: f.name,
      fields: [...f.fields],
      primaryKey: [...f.primaryKey],
      ...(f.cursorField && { cursorField: f.cursorField }),
      semantics: f.semantics,
      recordCount: f.records.length,
    }));
    return { streams };
  }

  async teardown(): Promise<void> {
    await this.server.stop();
  }

  async issueGrant(request: GrantRequest): Promise<IssuedGrant | null> {
    if (request.accessMode === "single_use") {
      // Not supported; declared absent in capabilities, so AS-10 is unsupported.
      return null;
    }
    const issued = this.server.issueGrant(request.streams.map((s) => ({ name: s.name, fields: [...s.fields] })));
    if (!issued) {
      return null;
    }
    return {
      grantId: issued.grantId,
      accessToken: issued.accessToken,
      streams: request.streams.map((s) => ({
        name: s.name,
        fields: [...s.fields],
      })),
    };
  }

  async revokeGrant(grantId: string): Promise<void> {
    this.server.revokeGrant(grantId);
  }

  async ownerToken(): Promise<string | null> {
    return "owner-seeded";
  }

  async foreignSubjectOwnerToken(): Promise<string | null> {
    return "owner-foreign";
  }

  async expiredGrantToken(): Promise<string | null> {
    const issued = this.server.issueGrant(
      this.fixtures.map((f) => ({ name: f.name, fields: [...f.fields] })),
      { expired: true }
    );
    return issued?.accessToken ?? null;
  }
}
