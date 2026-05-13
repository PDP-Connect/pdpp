/**
 * Compatibility shim for the reference run-interaction streaming session store.
 *
 * The pure token/session lifecycle now lives in @pdpp/remote-surface/server.
 * Keep this module so existing reference routes and tests retain their import
 * path, route envelopes, URLs, and adapter-owned auth behavior.
 */
export { __test__, createStreamingSessionStore } from '@pdpp/remote-surface/server';
