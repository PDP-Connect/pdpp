export interface RecordData {
    id?: string | number | null;
    [field: string]: unknown;
}
export interface StreamScope {
    name: string;
    resources?: readonly string[];
    time_range?: {
        since?: string;
        until?: string;
    };
    [extra: string]: unknown;
}
export interface StartMessage {
    detail_gaps?: readonly DetailGapStartEntry[];
    recovery_only?: boolean;
    scope: {
        streams: readonly StreamScope[];
    };
    state?: Record<string, unknown>;
    streamsToBackfill?: readonly string[];
    type: "START";
}
export interface DetailGapStartEntry {
    detail_locator?: {
        kind?: string;
        [field: string]: unknown;
    } | null;
    gap_id: string;
    record_key?: string | number | null;
    reference_only?: true;
    status: "pending";
    stream: string;
}
export interface DetailGapsPageRequestMessage {
    max_bytes?: number;
    reference_only: true;
    request_id: string;
    streams?: readonly string[];
    type: "DETAIL_GAPS_PAGE_REQUEST";
}
export interface DetailGapsPageResponse {
    detail_gaps: readonly DetailGapStartEntry[];
    reference_only: true;
    request_id: string;
    type: "DETAIL_GAPS_PAGE_RESPONSE";
}
export interface InteractionResponse {
    data?: Record<string, string>;
    error?: {
        message: string;
    };
    request_id: string;
    status: "success" | "cancelled" | "error";
    type: "INTERACTION_RESPONSE";
    value?: string;
}
export type InteractionKind = "credentials" | "otp" | "manual_action";
export type AssistanceProgressPosture = "running" | "blocked" | "waiting_retry";
export type AssistanceOwnerAction = "none" | "act_elsewhere" | "provide_value" | "operate_attachment";
export type AssistanceResponseContract = "none";
export type AssistanceSensitivity = "none" | "non_secret" | "secret";
export type AssistanceAttachmentKind = "browser_surface" | "url" | "qr" | "file" | "fixture";
export type AssistanceCompletionStatus = "cancelled" | "escalated" | "resolved" | "timed_out";
export interface AssistanceAttachment {
    kind: AssistanceAttachmentKind;
    label?: string;
    ref?: string;
    role?: string;
}
export interface AssistanceRequest {
    assistance_request_id?: string;
    attachments?: AssistanceAttachment[];
    input_schema?: Record<string, unknown>;
    message: string;
    owner_action: AssistanceOwnerAction;
    progress_posture: AssistanceProgressPosture;
    response_contract: AssistanceResponseContract;
    sensitivity?: AssistanceSensitivity;
    timeout_seconds?: number;
}
export interface AssistanceCompletion {
    assistance_request_id: string;
    message?: string;
    status: AssistanceCompletionStatus;
}
export interface DetailGapNetworkPressure {
    attempt?: number;
    endpoint_route: string;
    error_class: string;
    max_attempts?: number;
    method: string;
    retry_after_ms?: number;
    safe_headers?: Record<string, string | number>;
    status?: number;
}
export interface DetailGapMessage {
    detail?: {
        class?: string;
        http_status?: number;
        network_pressure?: DetailGapNetworkPressure;
    };
    detail_locator: {
        kind: string;
        [field: string]: string | number | boolean | null | Record<string, string | number | boolean | null>;
    };
    last_error?: {
        class?: string;
        http_status?: number;
        message?: string;
        network_pressure?: DetailGapNetworkPressure;
    };
    list_cursor?: unknown;
    parent_stream?: string;
    reason: "rate_limited" | "retry_exhausted" | "temporary_unavailable" | "upstream_pressure";
    record_key: string | number;
    reference_only: true;
    retryable: true;
    status: "pending";
    stream: string;
    type: "DETAIL_GAP";
}
export interface DetailCoverageMessage {
    considered?: number;
    covered?: number;
    gap_keys?: Array<string | number>;
    hydrated_keys: Array<string | number>;
    optional_skip_keys?: Array<string | number>;
    reference_only: true;
    required_keys: Array<string | number>;
    state_stream: string;
    stream: string;
    type: "DETAIL_COVERAGE";
}
export interface DetailGapRecoveredMessage {
    gap_id: string;
    record_key?: string | number;
    reference_only: true;
    stream: string;
    type: "DETAIL_GAP_RECOVERED";
}
export interface ProviderBudgetProgress {
    circuit: {
        previous_state: "closed" | "half_open" | "open";
        reason: "provider_failure" | "provider_throttle" | "reset_timeout" | "success";
        state: "closed" | "half_open" | "open";
        trigger: "before_request" | "provider_failure" | "provider_throttle" | "success";
    };
    elapsed_ms: number;
    object: "provider_budget_circuit_transition";
    request_count: number;
    retry_tokens_remaining?: number | "unbounded";
}
export interface CollectionRateProgress {
    ceiling_interval_ms: number;
    ceiling_rate_per_min: number;
    current_interval_ms: number;
    effective_rate_per_min: number;
    last_backoff: {
        at_interval_ms: number;
        reason: "retry_after" | "throttle";
    } | null;
    object: "collection_rate";
}
export interface ProgressExtra {
    count?: number;
    stream?: string;
    total?: number;
}
export type EmittedMessage = {
    type: "RECORD";
    stream: string;
    key: string | number;
    data: RecordData;
    emitted_at: string;
    op?: "delete";
} | {
    type: "STATE";
    stream: string;
    cursor: unknown;
} | {
    type: "PROGRESS";
    message: string;
    count?: number;
    stream?: string;
    total?: number;
    provider_budget?: ProviderBudgetProgress;
    collection_rate?: CollectionRateProgress;
} | ({
    type: "ASSISTANCE";
} & AssistanceRequest) | ({
    type: "ASSISTANCE_STATUS";
} & AssistanceCompletion) | {
    type: "SKIP_RESULT";
    stream: string;
    reason: string;
    message: string;
    diagnostics?: unknown;
    recovery_hint?: string | {
        action?: string;
        retryable?: boolean;
    };
} | DetailGapMessage | DetailCoverageMessage | DetailGapRecoveredMessage | DetailGapsPageRequestMessage | {
    type: "DONE";
    status: "succeeded" | "failed";
    records_emitted: number;
    error?: {
        code?: string;
        message: string;
        retryable: boolean;
    };
} | {
    type: "INTERACTION";
    request_id: string;
    kind: InteractionKind;
    message: string;
    schema?: Record<string, unknown>;
    timeout_seconds?: number;
};
export interface InteractionRequest {
    kind: InteractionKind;
    message: string;
    request_id?: string;
    schema?: Record<string, unknown>;
    timeout_seconds?: number;
}
export type ValidateRecord = (stream: string, data: RecordData) => {
    ok: true;
    data: RecordData;
} | {
    ok: false;
    issues: Array<{
        path: string;
        message: string;
    }>;
};
