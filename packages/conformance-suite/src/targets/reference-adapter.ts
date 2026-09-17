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

import type {
  GrantRequest,
  IssuedGrant,
  SeededStream,
  SelectionOutcome,
  SelectionRequest,
  TargetAdapter,
  TargetCapabilities,
} from "../harness/adapter.ts";
import type { Role } from "../requirements/catalog.ts";
import { type Defect, PDPP_VERSION, ReferenceServer, type StreamFixture } from "./reference-server.ts";

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
  private readonly defects: ReadonlySet<Defect>;

  constructor(fixtures: readonly StreamFixture[] = DEFAULT_FIXTURES, defects: ReadonlySet<Defect> = new Set()) {
    this.fixtures = fixtures;
    this.defects = defects;
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
    const issued = this.server.issueGrant(
      request.streams.map((s) => ({
        name: s.name,
        fields: [...s.fields],
        ...(request.timeConstraint ? { timeConstraint: request.timeConstraint } : {}),
      }))
    );
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

  /**
   * Why the first requested stream fails validation against the retained
   * snapshot, or null when every one of them checks out.
   *
   * The `accept-undeclared-selection` defect makes this always answer null,
   * which is exactly the server behaviour the AS-2 oracles must be able to
   * catch: taking the client's word for what the source offers.
   */
  private firstUndeclaredReason(
    wantedStreams: readonly { readonly name: string; readonly fields?: readonly string[] }[]
  ): string | null {
    if (this.defects.has("accept-undeclared-selection")) {
      return null;
    }
    for (const wanted of wantedStreams) {
      const declared = this.fixtures.find((f) => f.name === wanted.name);
      if (!declared) {
        return `stream '${wanted.name}' is not declared by the retained snapshot`;
      }
      const undeclared = (wanted.fields ?? []).filter((f) => !declared.fields.includes(f));
      if (undeclared.length > 0) {
        return `stream '${wanted.name}' requests fields absent from the retained schema: ${undeclared.join(", ")}`;
      }
    }
    return null;
  }

  /**
   * Selection-request validation, modelled against the seeded fixtures as the
   * retained SourceDeclaration snapshot.
   *
   * Deliberately not an HTTP surface: these requirements are about the decision
   * the AS makes about a request, not about how the request is carried, and Core
   * pins no route for it (the two real targets this suite drives use different
   * ones). Implementing the decision here is what lets the negative oracles be
   * proven to discriminate, which is the bar every other negative case meets.
   */
  async submitSelection(request: SelectionRequest): Promise<SelectionOutcome> {
    const reject = (errorCode: string, description: string): SelectionOutcome => ({
      status: 400,
      errorCode,
      body: JSON.stringify({ error: errorCode, error_description: description }),
    });

    if (request.pdppVersion !== undefined && request.pdppVersion !== PDPP_VERSION) {
      if (this.defects.has("accept-unsupported-version")) {
        return { status: 201, body: '{"session_id":"as_defect"}' };
      }
      return reject("unsupported_version", `PDPP-Version '${request.pdppVersion}' is not supported`);
    }

    // Core Section 6: exactly one of streams / selection_preset.
    const hasStreams = request.streams !== undefined;
    const hasPreset = request.selectionPreset !== undefined;
    if (hasStreams === hasPreset && !this.defects.has("accept-malformed-selection")) {
      return reject("invalid_authorization_details", "exactly one of streams or selection_preset is required");
    }

    // Only reached when the shape is well-formed, or when the malformed-shape
    // defect waved a both-present request through. In the latter case a
    // conforming server would have refused on shape alone, so the preset must
    // not be re-examined here — refusing it would make the AS-5 oracle pass
    // against a target that ignores AS-5 entirely.
    if (hasPreset && !hasStreams && !this.defects.has("accept-undeclared-selection")) {
      // This target's declaration defines no presets, so any named one is
      // unrecognized.
      return reject(
        "invalid_authorization_details",
        `selection preset '${request.selectionPreset}' is not defined by the retained snapshot`
      );
    }

    const undeclaredReason = this.firstUndeclaredReason(request.streams ?? []);
    if (undeclaredReason) {
      return reject("invalid_authorization_details", undeclaredReason);
    }

    // AS-6 is a MUST NOT: an unregistered purpose_code is not grounds for
    // refusal on its own. The defect models a server treating the registry as
    // an allowlist.
    if (
      this.defects.has("reject-unregistered-purpose") &&
      request.purposeCode !== undefined &&
      !request.purposeCode.startsWith("https://pdpp.dev/purpose/")
    ) {
      return reject("invalid_authorization_details", `purpose_code '${request.purposeCode}' is not registered`);
    }

    return { status: 201, body: '{"session_id":"as_reference"}' };
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
