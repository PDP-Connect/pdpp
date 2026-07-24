// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const DEPLOYMENT_LABEL = 'org.pdpp.reference.neko.deployment_id';
const SURFACE_LABEL = 'org.pdpp.reference.neko.surface_id';

function runScoped(base, runId) {
  if (!base || /[\r\n]/.test(base)) throw new Error('dynamic n.eko smoke identity bases must be non-empty single-line strings');
  return `${base.replace(/-+$/, '')}-${runId}`;
}

export function deriveDynamicNekoSmokeConfig(env, runId) {
  if (!/^[a-z0-9-]+$/.test(runId)) throw new Error('dynamic n.eko smoke run id must contain only lowercase letters, digits, and hyphens');
  if (env.PDPP_NEKO_WEBRTC_HOST_PORT_START || env.PDPP_NEKO_WEBRTC_HOST_PORT_END) {
    throw new Error(
      'PDPP_NEKO_WEBRTC_HOST_PORT_START and PDPP_NEKO_WEBRTC_HOST_PORT_END must be unset: the smoke reserves a per-run port pair',
    );
  }

  const projectName = runScoped(env.PDPP_NEKO_DYNAMIC_SMOKE_PROJECT_NAME ?? 'pdppdynsmoke', runId);
  const profileRoot = runScoped(env.PDPP_NEKO_PROFILE_STORAGE_ROOT ?? '/tmp/pdpp-neko-profiles-smoke', runId);
  const deploymentId = env.PDPP_NEKO_DEPLOYMENT_ID
    ? runScoped(env.PDPP_NEKO_DEPLOYMENT_ID, runId)
    : projectName;
  const surfaceA = `dynamic-smoke-${runId}-a`;
  const surfaceB = `dynamic-smoke-${runId}-b`;

  return {
    projectName,
    profileRoot,
    deploymentId,
    surfaceA,
    surfaceB,
    cleanupFilters: (surfaceId) => [
      `label=${DEPLOYMENT_LABEL}=${deploymentId}`,
      `label=${SURFACE_LABEL}=${surfaceId}`,
    ],
  };
}

if (import.meta.main) {
  const config = deriveDynamicNekoSmokeConfig(process.env, process.argv[2]);
  process.stdout.write([config.projectName, config.profileRoot, config.deploymentId, config.surfaceA, config.surfaceB].join('\n'));
}
