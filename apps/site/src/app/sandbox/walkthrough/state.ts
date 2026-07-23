// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  SANDBOX_CLIENT,
  SANDBOX_CONNECTOR,
  SANDBOX_CONSENT_RATIONALE,
  SANDBOX_GRANT,
  SANDBOX_OWNER,
  SANDBOX_RECORDS,
  SANDBOX_STREAM,
} from "./scenario.ts";

/**
 * Walkthrough phases. The reducer guarantees `phase` only advances along the
 * documented happy path; reset returns to `initial` from anywhere.
 */
export type SandboxPhase = "initial" | "requested" | "granted" | "queried" | "revoked";

export type SandboxAction =
  | { type: "request" }
  | { type: "approve" }
  | { type: "deny" }
  | { type: "query" }
  | { type: "revoke" }
  | { type: "reset" };

export interface SandboxState {
  decision: "pending" | "approved" | "denied";
  history: readonly SandboxPhase[];
  lastDeniedQueryAt: string | null;
  phase: SandboxPhase;
  recordsVisible: boolean;
}

export const INITIAL_STATE: SandboxState = {
  decision: "pending",
  history: ["initial"],
  lastDeniedQueryAt: null,
  phase: "initial",
  recordsVisible: false,
};

const FROZEN_AT = "2026-04-25T15:00:00Z";

export function reduce(state: SandboxState, action: SandboxAction): SandboxState {
  switch (action.type) {
    case "request": {
      if (state.phase !== "initial") {
        return state;
      }
      return advance(state, { decision: "pending", phase: "requested" });
    }
    case "approve": {
      if (state.phase !== "requested") {
        return state;
      }
      return advance(state, { decision: "approved", phase: "granted" });
    }
    case "deny": {
      if (state.phase !== "requested") {
        return state;
      }
      // Denial creates no grant, but it remains visible as refusal evidence
      // until the visitor retries or resets.
      return {
        ...INITIAL_STATE,
        decision: "denied",
        history: state.history,
      };
    }
    case "query": {
      if (state.phase !== "granted") {
        return state;
      }
      return advance(state, { phase: "queried", recordsVisible: true });
    }
    case "revoke": {
      if (state.phase !== "queried" && state.phase !== "granted") {
        return state;
      }
      return advance(state, {
        lastDeniedQueryAt: FROZEN_AT,
        phase: "revoked",
        recordsVisible: false,
      });
    }
    case "reset":
      return INITIAL_STATE;
    default:
      return state;
  }
}

function advance(state: SandboxState, patch: Partial<SandboxState> & { phase: SandboxPhase }): SandboxState {
  return {
    ...state,
    ...patch,
    history: [...state.history, patch.phase],
  };
}

/**
 * Inspectable JSON snippets per phase. These are deliberately small and
 * labeled simulated; they are not byte-for-byte from the live reference.
 */
export interface TranscriptEntry {
  available: boolean;
  body: unknown;
  endpoint: string;
  id: SandboxPhase | "denied";
  label: string;
  method: string;
}

export function buildTranscript(state: SandboxState): readonly TranscriptEntry[] {
  const requested = state.history.includes("requested");
  const granted = state.history.includes("granted");
  const queried = state.history.includes("queried");
  const revoked = state.history.includes("revoked");
  const denied = state.decision === "denied";

  return [
    {
      available: requested,
      body: {
        access_mode: SANDBOX_GRANT.accessMode,
        client_claims: {
          attribution: "self-asserted by client; not verified by the sandbox",
          commitments: SANDBOX_CLIENT.commitments,
        },
        client_id: SANDBOX_CLIENT.clientId,
        purpose_code: SANDBOX_GRANT.purposeCode,
        purpose_description: SANDBOX_CLIENT.purpose,
        requested_scope: {
          fields: SANDBOX_STREAM.fields,
          sources: [SANDBOX_CONNECTOR.source],
          streams: [SANDBOX_STREAM.key],
        },
        simulated: true,
      },
      endpoint: "/par",
      id: "requested",
      label: "1. Client requests access",
      method: "POST",
    },
    {
      available: denied,
      body: {
        client_id: SANDBOX_CLIENT.clientId,
        error: "owner_denied",
        message: "Owner declined this request. No grant was created and no records were returned.",
        owner_id: SANDBOX_OWNER.ownerId,
        requested_scope: {
          fields: SANDBOX_STREAM.fields,
          streams: [SANDBOX_STREAM.key],
        },
        simulated: true,
        status: 403,
      },
      endpoint: "/grants",
      id: "denied",
      label: "2a. Owner denies the request",
      method: "POST",
    },
    {
      available: granted,
      body: {
        access_mode: SANDBOX_GRANT.accessMode,
        client_id: SANDBOX_CLIENT.clientId,
        consent_rationale: SANDBOX_CONSENT_RATIONALE,
        expires_at: SANDBOX_GRANT.expiresAt,
        grant_id: SANDBOX_GRANT.grantId,
        owner_id: SANDBOX_OWNER.ownerId,
        purpose_code: SANDBOX_GRANT.purposeCode,
        scope: SANDBOX_GRANT.scope,
        simulated: true,
      },
      endpoint: "/grants",
      id: "granted",
      label: "2. Owner consent + grant issued",
      method: "POST",
    },
    {
      available: queried,
      body: {
        grant_id: SANDBOX_GRANT.grantId,
        projected_fields: SANDBOX_STREAM.fields,
        record_count: SANDBOX_RECORDS.length,
        records: SANDBOX_RECORDS,
        simulated: true,
        source: SANDBOX_CONNECTOR.source,
        stream: SANDBOX_STREAM.key,
      },
      endpoint: `/streams/${SANDBOX_STREAM.key}/records?grant_id=${SANDBOX_GRANT.grantId}`,
      id: "queried",
      label: "3. Resource query returns scoped records",
      method: "GET",
    },
    {
      available: revoked,
      body: {
        grant_id: SANDBOX_GRANT.grantId,
        next_attempt: {
          endpoint: `/streams/${SANDBOX_STREAM.key}/records?grant_id=${SANDBOX_GRANT.grantId}`,
          error: "grant_revoked",
          message: "Grant was revoked by owner; no further records will be returned.",
          method: "GET",
          status: 403,
        },
        revoked_at: FROZEN_AT,
        simulated: true,
      },
      endpoint: `/grants/${SANDBOX_GRANT.grantId}`,
      id: "revoked",
      label: "4. Owner revokes / next query refused",
      method: "DELETE",
    },
  ];
}

export const PHASE_ORDER: readonly SandboxPhase[] = ["initial", "requested", "granted", "queried", "revoked"];

export function phaseIndex(phase: SandboxPhase): number {
  return PHASE_ORDER.indexOf(phase);
}
