# @pdpp/local-collector

Publishable PDPP local collector runtime for filesystem-class connectors.

This package is intentionally narrower than `@pdpp/polyfill-connectors`: it
ships only the local collector runner, the device-exporter client, and bundled
Claude Code / Codex connector entrypoints. Browser/Patchright-backed connectors
stay out of this package until each has its own publishability review.

For filesystem-class collectors, the local device or host supervisor decides
when the process runs. The reference server owns enrollment, ingestion, state,
health diagnostics, and optional desired-freshness/request-run signals, but it
does not start local processes. `PDPP_CONNECTION_ID` is the stable
connection/source identity for a specific device/account/home binding; the
enrollment response currently names that value `source_instance_id`.

## Usage

```bash
# @pdpp/local-collector package, npx-launched pdpp-local-collector binary
npx -y @pdpp/local-collector advertise

# @pdpp/local-collector package, npx-launched pdpp-local-collector binary
npx -y @pdpp/local-collector enroll \
  --base-url https://<reference-host> \
  --code <one-time-code>

# @pdpp/local-collector package, npx-launched pdpp-local-collector binary
PDPP_LOCAL_DEVICE_ID=<device_id> \
PDPP_LOCAL_DEVICE_TOKEN=<device_token> \
PDPP_CONNECTION_ID=<source_instance_id> \
npx -y @pdpp/local-collector run \
  --base-url https://<reference-host> \
  --connector claude_code
```

The collector sends `X-PDPP-Collector-Protocol` on enrollment and every
device-exporter request. The reference server rejects incompatible versions
before persisting records or state.

Install globally if you prefer a persistent binary:

```bash
# @pdpp/local-collector package, installs the pdpp-local-collector binary
npm i -g @pdpp/local-collector
pdpp-local-collector advertise
```

`device_token` is write-capable for its collector lane. Store it in a secret
manager or root-readable env file, and do not print it in logs, issues, or
support transcripts.

For a full operator runbook, including Docker move guidance and troubleshooting
for `403` after source migration and `409 collector_protocol_mismatch`, see
[`docs/local-collector.md`](../../docs/local-collector.md).
