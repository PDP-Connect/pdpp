# @pdpp/local-collector

Publishable PDPP local collector runtime for filesystem-class connectors.

This package is intentionally narrower than `@pdpp/polyfill-connectors`: it
ships only the local collector runner, the device-exporter client, and bundled
Claude Code / Codex connector entrypoints. Browser/Patchright-backed connectors
stay out of this package until each has its own publishability review.

## Usage

```bash
npx -y @pdpp/local-collector advertise

npx -y @pdpp/local-collector enroll \
  --base-url https://<reference-host> \
  --code <one-time-code>

npx -y @pdpp/local-collector run \
  --base-url https://<reference-host> \
  --device-id <id> \
  --device-token <token> \
  --connection-id <id> \
  --connector claude_code
```

The collector sends `X-PDPP-Collector-Protocol` on enrollment and every
device-exporter request. The reference server rejects incompatible versions
before persisting records or state.
