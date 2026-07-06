/**
 * Compatibility shim for the reference run-interaction streaming session store.
 *
 * The pure token/session lifecycle now lives in @opendatalabs/remote-surface/server.
 * Keep this module so existing reference routes and tests retain their import
 * path, route envelopes, URLs, and adapter-owned auth behavior.
 */
// biome-ignore lint/performance/noBarrelFile: intentional compatibility shim — re-exports the moved session store so existing reference import paths keep working.
export { __test__, createStreamingSessionStore } from "@opendatalabs/remote-surface/server";
