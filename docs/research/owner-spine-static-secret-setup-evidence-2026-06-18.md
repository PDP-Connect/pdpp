# Owner Spine Static-Secret Setup Evidence - 2026-06-18

## Scope

This evidence covers the GitHub provider-token setup surface after the static-secret setup tranche:

- `/dashboard/connect/static-secret/github`
- local console `http://localhost:3030`
- local reference AS `http://localhost:7662`
- owner session cookie minted locally from `.env.local` without printing secrets
- GitHub connector manifest refreshed on the local reference AS from `packages/polyfill-connectors/manifests/github.json`

This is not a live-stack deploy proof and not a complete first-sync proof.

## Artifacts

- Desktop screenshot: `docs/research/artifacts/owner-spine-static-secret-setup-2026-06-18/desktop.png`
- Mobile screenshot: `docs/research/artifacts/owner-spine-static-secret-setup-2026-06-18/mobile-390.png`

Raw temporary CDP extraction reports were written under `tmp/owner-spine-captures/`.

## Acceptance Checks

Both desktop and mobile passed:

- Page renders `Add GitHub`.
- Page renders `Source name`.
- Page renders connector-authored scope guidance including `read:user`, `public_repo`, and expiration guidance.
- Page links to the provider setup page in a new tab.
- Primary submit says `Add GitHub source and start first sync`.
- Old `Create GitHub connection` submit copy is absent.
- Error-boundary copy is absent.
- Owner login page is absent after local owner-session injection.
- No horizontal overflow: desktop document width `1275 <= 1280`; mobile document width `390 <= 390`.
- Product console messages are clean after filtering Next dev/HMR noise.
- Network requests had no failures and no non-favicon HTTP errors.

## Residual Gap

This evidence proves the authenticated setup page, not the entire Add Data -> first sync -> setup-status -> exact source route journey. The OpenSpec task `8.12` should remain open until a submit/status path is proven with:

- desktop and mobile pixels,
- browser console and network evidence,
- source/status data-truth probes,
- adversarial review.
