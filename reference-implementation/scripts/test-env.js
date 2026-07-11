// Owner-auth env vars exported by the host shell (e.g. ~/.shell_secrets) will
// silently activate the production owner-auth placeholder inside
// startServer()'s resolveOwnerAuthPlaceholderConfig, which then 401s every test
// that does not explicitly drive the owner-session flow. Strip them at the
// harness boundary so `pnpm test` is hermetic. Tests that genuinely want owner
// auth on opt in via startServer({ ownerAuthPassword }). Do not remove without
// reading reference-implementation/server/index.js
// resolveOwnerAuthPlaceholderConfig.
export const TEST_ENV_DENYLIST = Object.freeze([
  'PDPP_OWNER_PASSWORD',
  'PDPP_OWNER_SUBJECT_ID',
  'PDPP_OWNER_TOKEN',
  'PDPP_OWNER_FORCE_SECURE_COOKIES',
  'PDPP_OWNER_SAMESITE',
]);

export function buildScrubbedTestEnv(sourceEnv = process.env) {
  const denied = new Set(TEST_ENV_DENYLIST);
  const scrubbed = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (denied.has(key)) continue;
    scrubbed[key] = value;
  }
  scrubbed.PDPP_RUNTIME_QUIET = sourceEnv.PDPP_RUNTIME_QUIET || '1';
  // Test workers must not inherit the reference server's fixed dev ports.
  // Any call site that omits explicit ephemeral ports would otherwise bind
  // 7662/7663 and race with other file workers.
  scrubbed.AS_PORT = '0';
  scrubbed.RS_PORT = '0';
  return scrubbed;
}
