# Tasks — unify source-attention count and labels

## 1. Shared headline count

- [x] 1.1 Add a shared `sourceAttentionHeadline(groups)` helper to
  `apps/console/src/app/dashboard/lib/source-actionability.ts` returning the "needs you" count
  (`needsOwner.length`) and its single owner-facing meaning.
- [x] 1.2 Make `standing-view-model.ts` derive the hero count and gate from the shared helper; ensure
  the hero number equals the rendered "Needs you" section length.
- [x] 1.3 Make `syncs-model.ts` band derive its PRIMARY urgent number from the same shared helper; keep
  any wider "also worth reviewing" number clearly labeled as secondary, never as the headline.

## 2. Shared category labels

- [x] 2.1 Add `SOURCE_WORK_GROUP_COPY` (label + one-line who-acts/urgency note) to
  `source-actionability.ts` for the four groups.
- [x] 2.2 Make `standing-view-model.ts` section titles and `syncs-view.tsx` `FAILURE_SECTION_COPY`
  consume `SOURCE_WORK_GROUP_COPY` instead of local literals.
- [x] 2.3 Ensure the four labels are byte-identical across dashboard and Runs (both now reference the
  shared map by key).

## 3. Credential remediation copy

- [x] 3.1 Change the `refresh_credentials` remediation label in
  `reference-implementation/runtime/connection-health.ts` from "Reconnect or update the source
  credentials" to "Reconnect this account" to match the rendered verdict CTA.
- [x] 3.2 Grep the repo for any remaining "Reconnect or update" / competing credential-action string in
  owner-facing copy and align it (only the two `connection-evidence.test.ts` fixtures remained; updated).

## 4. Tests

- [ ] 4.1 Update/add `source-actionability.test.ts`: headline count == needsOwner.length; labels map
  exported and stable. (NOT written — see §5.2 status: test toolchain cannot run in this checkout.)
- [ ] 4.2 Update/add `standing-view-model.test.ts`: hero count == "Needs you" rows and < total rows when
  other groups are populated.
- [ ] 4.3 Update/add `syncs-model.test.ts`: band primary "needs you" number == dashboard hero for the
  same connector set.
- [x] 4.4 Aligned the two `connection-evidence.test.ts` credential fixtures to the new "Reconnect this
  account" label (assertions already only checked `.title.includes("Reconnect")`, still true).

## 5. Validation

- [x] 5.1 `openspec validate unify-source-attention-count-and-labels --strict` passes.
- [ ] 5.2 Console + reference test suites green for the touched files. BLOCKED: this checkout has NO
  `node_modules` (root and `apps/console`); `pnpm test:view-models` fails with `Cannot find package
  'tsx'`. Running requires `pnpm install` (not quick). Owner must run the suites after install; the
  new-test authoring in §4.1–4.3 should land in the same pass, since they cannot be executed here.

## Acceptance checks

- Given 1 needsOwner + ≥1 review + ≥1 systemIssue + ≥1 checking, the dashboard hero number equals the
  "Needs you" row count and is strictly less than the total rendered rows.
- The dashboard hero headline number and the Runs band primary "needs you" number are equal for the
  same connector set.
- The four group labels rendered on the dashboard and on Runs are byte-identical.
- A rejected-credential connection surfaces one reconnect verb ("Reconnect this account") across the
  rendered verdict CTA and the connection-health remediation label.
- Owner-only live confirmation on a running console (may become a Residual Risk if only the owner can run it).
