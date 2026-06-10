export { createSurfaceSessionStore, } from "./surface-session-store.js";
/**
 * @deprecated Reference-shaped streaming-session APIs (with `run_id` /
 *   `interaction_id` fields) moved to
 *   `@opendatalabs/remote-surface/reference`. These re-exports are
 *   preserved for the deprecation horizon recorded in the
 *   `republish-remote-surface-as-opendatalabs` OpenSpec change
 *   (planned removal: first post-publish minor). Import from the
 *   `./reference` subpath instead.
 */
export { __test__, createStreamingSessionStore, DEFAULT_MINT_IDEMPOTENCY_TTL_MS, DEFAULT_STREAMING_SESSION_TTL_MS, hashStreamingSessionToken, MAX_IDEMPOTENCY_KEY_LEN, StreamingSessionStoreError, } from "../reference/streaming-session-store.js";
//# sourceMappingURL=index.js.map