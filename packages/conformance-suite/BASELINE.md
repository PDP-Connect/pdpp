# Pinned record-read baseline

Run the same Core v0.1 cases against two disposable loopback targets. Reports retain failures, skipped hooks, and unsupported optional capabilities. They confer no conformance status.

Use fresh checkouts outside this workspace. The current target revisions are:

| Input | Commit |
| --- | --- |
| Suite and normative Core text | `541ebc38f0794d5c7c2d09198a978471dd61733e`, plus this branch's adapter and fixture changes |
| Reference implementation | `e94f4fd9c6683e8284143dbccf29a12bc7370b94` |
| External personal-server target | `0b5eac036a33cb714cdd6d3a71abddd98e609f2d` |

Install this workspace with `pnpm install --frozen-lockfile`. Use Node 24.15 or newer for these target revisions. In the external target checkout, run `npm ci` and `npm run build -w @opendatalabs/personal-server-ts-core`. The reference runner installs its locked dependencies and builds its runtime packages automatically. Its current dependency graph includes a transitive, commit-pinned Git dependency; `PDPP_DC_NPM_ALLOW_GIT=all` permits npm to fetch it for this invocation.

From this repository root:

```bash
PDPP_DC_REF="$HOME/.tmp/record-baseline/data-connect" \
PDPP_DC_NPM_ALLOW_GIT=all \
PDPP_VANA_PS="$HOME/.tmp/record-baseline/personal-server-ts" \
PDPP_BASELINE_OUT="$HOME/.tmp/record-baseline/results" \
bash packages/conformance-suite/scripts/replication-baseline.sh
```

The runner sets the full current-reference `PDPP_DC_PIN` explicitly. The standalone `reference-target.sh` default remains the historical `59a3fb480e7f3e2d68d46b1e4ee2cb23d505d113` pin. Its existing expectation file remains the historical baseline; the current reference has a separate expectation file. No behavior from candidate #447 or data-connect #454 is applied.

Each target runs boot → owner-authenticated provisioning → suite → stop. A failed case returns exit 1; incomplete coverage without failures returns exit 2. Neither is converted to success. A target setup or report-binding error also fails the command. Run directories and databases are temporary; report directories survive.

Each invocation prints a fresh `run.XXXXXX/` directory under the output root. Its `reference-v01/` and `ps-v01/` folders contain `report.json`, `report.md`, `requirements.json`, and independently authored `fixture-truth.json`. Supplemental instance-choice probes are separate from the normative case counts. Experimental v0.2 probes use separately named JSON and Markdown files; the pinned suite has no v0.2 requirement inventory.

`suite-source.json` records the suite files before a run. `baseline.json` binds the reports to that source digest, the full target commit, and the pinned Core text hash. Binding refuses changed suite files, dirty targets, a different target revision, or an exit status inconsistent with the report. Random handles, ports, timestamps, and HTTP evidence can differ between runs; source and revision attribution does not imply byte-identical reports.

Binding redacts structured bearer and refresh-token values in HTTP evidence before hashing the published report. Case outcomes and the remaining response fields are retained.

The fixtures include two connections with equal record keys, a mutable stream with hidden fields, an append-only stream, and persisted shared blob bytes. The forbidden shared-blob reference is inserted before the permitted one. Large multi-instance pagination fixtures use distinct keys because the existing pagination oracle compares record IDs; equal-key isolation is checked separately.

To verify the suite's defect detection:

```bash
CI=true pnpm --filter @pdpp/conformance-suite test
pnpm --filter @pdpp/conformance-suite typecheck
```

`test/oracle-discrimination.test.ts` asserts that grant-ignoring, field-leaking, concatenated-pagination, and first-reference-only blob implementations make their matching cases fail. These are controlled fixture defects, separate from the unmodified live-target baselines.
