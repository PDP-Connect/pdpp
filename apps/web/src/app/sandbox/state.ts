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
  phase: "initial",
  decision: "pending",
  recordsVisible: false,
  lastDeniedQueryAt: null,
  history: ["initial"],
};

const FROZEN_AT = "2026-04-25T15:00:00Z";

export function reduce(state: SandboxState, action: SandboxAction): SandboxState {
  switch (action.type) {
    case "request": {
      if (state.phase !== "initial") {
        return state;
      }
      return advance(state, { phase: "requested", decision: "pending" });
    }
    case "approve": {
      if (state.phase !== "requested") {
        return state;
      }
      return advance(state, { phase: "granted", decision: "approved" });
    }
    case "deny": {
      if (state.phase !== "requested") {
        return state;
      }
      // Denial returns to initial so the visitor can retry; we still record the
      // attempt in history so the UI can show a denied transcript.
      return {
        ...INITIAL_STATE,
        history: [...state.history, "initial"],
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
        phase: "revoked",
        recordsVisible: false,
        lastDeniedQueryAt: FROZEN_AT,
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
  id: SandboxPhase;
  label: string;
  method: string;
}

export function buildTranscript(state: SandboxState): readonly TranscriptEntry[] {
  const requested = state.history.includes("requested");
  const granted = state.history.includes("granted");
  const queried = state.history.includes("queried");
  const revoked = state.history.includes("revoked");

  return [
    {
      id: "requested",
      label: "1. Client requests access",
      method: "POST",
      endpoint: "/par",
      available: requested,
      body: {
        simulated: true,
        client_id: SANDBOX_CLIENT.clientId,
        purpose_description: SANDBOX_CLIENT.purpose,
        purpose_code: SANDBOX_GRANT.purposeCode,
        access_mode: SANDBOX_GRANT.accessMode,
        requested_scope: {
          streams: [SANDBOX_STREAM.key],
          fields: SANDBOX_STREAM.fields,
          providers: [SANDBOX_CONNECTOR.providerId],
        },
        client_claims: {
          commitments: SANDBOX_CLIENT.commitments,
          attribution: "self-asserted by client; not verified by the sandbox",
        },
      },
    },
    {
      id: "granted",
      label: "2. Owner consent + grant issued",
      method: "POST",
      endpoint: "/grants",
      available: granted,
      body: {
        simulated: true,
        grant_id: SANDBOX_GRANT.grantId,
        owner_id: SANDBOX_OWNER.ownerId,
        client_id: SANDBOX_CLIENT.clientId,
        access_mode: SANDBOX_GRANT.accessMode,
        purpose_code: SANDBOX_GRANT.purposeCode,
        expires_at: SANDBOX_GRANT.expiresAt,
        scope: SANDBOX_GRANT.scope,
        consent_rationale: SANDBOX_CONSENT_RATIONALE,
      },
    },
    {
      id: "queried",
      label: "3. Resource query returns scoped records",
      method: "GET",
      endpoint: `/streams/${SANDBOX_STREAM.key}/records?grant_id=${SANDBOX_GRANT.grantId}`,
      available: queried,
      body: {
        simulated: true,
        grant_id: SANDBOX_GRANT.grantId,
        stream: SANDBOX_STREAM.key,
        projected_fields: SANDBOX_STREAM.fields,
        provider: SANDBOX_CONNECTOR.providerId,
        record_count: SANDBOX_RECORDS.length,
        records: SANDBOX_RECORDS,
      },
    },
    {
      id: "revoked",
      label: "4. Owner revokes / next query refused",
      method: "DELETE",
      endpoint: `/grants/${SANDBOX_GRANT.grantId}`,
      available: revoked,
      body: {
        simulated: true,
        grant_id: SANDBOX_GRANT.grantId,
        revoked_at: FROZEN_AT,
        next_attempt: {
          method: "GET",
          endpoint: `/streams/${SANDBOX_STREAM.key}/records?grant_id=${SANDBOX_GRANT.grantId}`,
          status: 403,
          error: "grant_revoked",
          message: "Grant was revoked by owner; no further records will be returned.",
        },
      },
    },
  ];
}

export const PHASE_ORDER: readonly SandboxPhase[] = ["initial", "requested", "granted", "queried", "revoked"];

export function phaseIndex(phase: SandboxPhase): number {
  return PHASE_ORDER.indexOf(phase);
}
