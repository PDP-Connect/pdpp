import { PDPP_CLI_BIN_NAME } from '../package-info.js';
import { CollectorUsageError } from './errors.js';
import { spawnCollectorRunner } from './runner.js';

const COLLECTOR_HELP = `Local collector runner (reference operator surface).

Pair a host you control with a PDPP reference deployment, then run
browser-backed or local-device connectors that the provider container
cannot run on its own. Runner-owned flags are documented by
"pdpp-local-collector --help" (see "Distribution" below).

Distribution:
  The collector runtime ships in @pdpp/local-collector, a separate npm
  package owned by the PDPP monorepo. @pdpp/cli stays slim and resolves
  the runner lazily:
    npm i -g @pdpp/local-collector
    npx -y @pdpp/local-collector advertise
  See openspec/changes/publish-pdpp-local-collector/design.md.

Usage:
  ${PDPP_CLI_BIN_NAME} collector advertise
  ${PDPP_CLI_BIN_NAME} collector enroll  --base-url <url> --code <one-time-code>
                          [--device-label <label>]
  ${PDPP_CLI_BIN_NAME} collector run     --base-url <url> --connector <id>
                          --device-id <id> --device-token <token>
                          --connection-id <id>
                          [--streams a,b,c]
                          [--backfill-streams attachments]
                          [--run-id <id>]

Suggested operator flow:
  1. Start the reference deployment somewhere reachable (e.g. Docker on a
     server) so it has a base URL such as http://server.local:7662.
  2. Confirm runtime capabilities with:
       ${PDPP_CLI_BIN_NAME} collector advertise
     The collector advertises network, browser, filesystem, local_device
     and reports collector_protocol_version.
  3. Mint an enrollment code from the dashboard or "pdpp ref" tooling,
     then on the host with Claude/Codex data run:
       ${PDPP_CLI_BIN_NAME} collector enroll --base-url <url> --code <code>
     The JSON response returns device_id, device_token, and
     source_instance_id (the connection id for this local binding) —
     persist all three to a secrets store. You will pass them back as
     flags/env vars in step 4.
  4. Run a connector with:
       PDPP_LOCAL_DEVICE_ID=<device_id> \\
       PDPP_LOCAL_DEVICE_TOKEN=<device_token> \\
       PDPP_CONNECTION_ID=<connection_id> \\
         ${PDPP_CLI_BIN_NAME} collector run --base-url <url> \\
           --connector claude_code
     Connectors that need bindings the collector does not advertise fail
     before spawn with "runtime_capability_mismatch".

Notes:
  Collector credentials are device-scoped; they cannot read records,
  approve grants, or mint owner tokens. See
  openspec/changes/publish-pdpp-local-collector/design.md.
  Required flags can also be supplied via PDPP_REFERENCE_BASE_URL,
  PDPP_LOCAL_DEVICE_ID, PDPP_LOCAL_DEVICE_TOKEN, PDPP_CONNECTION_ID,
  PDPP_RUN_ID. PDPP_SOURCE_INSTANCE_ID remains a compatibility alias.
`;

const SUBCOMMANDS = new Set(['advertise', 'enroll', 'run']);

export async function runCollector(argv, io) {
  const [sub, ...rest] = argv;

  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    io.stdout.write(COLLECTOR_HELP);
    return 0;
  }

  if (!SUBCOMMANDS.has(sub)) {
    io.stderr.write(`Unknown collector subcommand: ${sub}\n\n${COLLECTOR_HELP}`);
    return 64;
  }

  try {
    return await spawnCollectorRunner(sub, rest);
  } catch (error) {
    if (error instanceof CollectorUsageError) {
      io.stderr.write(`${error.message}\n`);
      return error.exitCode;
    }
    throw error;
  }
}

export { COLLECTOR_HELP };
