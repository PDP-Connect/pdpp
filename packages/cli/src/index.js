import {
  createPdppCliCommand,
  getPdppCliPackageInfo,
  PDPP_CLI_BIN_NAME,
} from './package-info.js';
import { ConnectError, connectProvider, normalizeProviderUrl } from './connect/flow.js';

const HELP = `PDPP CLI

Usage:
  ${PDPP_CLI_BIN_NAME} --help
  ${PDPP_CLI_BIN_NAME} package-info [--provider-url <url>]
  ${PDPP_CLI_BIN_NAME} connect <provider-url>

Agent access:
  ${createPdppCliCommand()}

Notes:
  Do not ask users for owner bearer tokens for routine delegated access.
`;

export async function runCli(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  const [command, ...rest] = argv;

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    io.stdout.write(`${HELP}\n`);
    return 0;
  }

  if (command === 'package-info') {
    const providerUrl = readOption(rest, '--provider-url');
    io.stdout.write(`${JSON.stringify(getPdppCliPackageInfo(providerUrl), null, 2)}\n`);
    return 0;
  }

  if (command === 'connect') {
    const providerUrl = rest[0];
    if (!providerUrl) {
      io.stderr.write('Usage: pdpp connect <provider-url>\n');
      return 64;
    }

    try {
      await connectProvider(providerUrl, { io });
      return 0;
    } catch (error) {
      if (error instanceof ConnectError) {
        io.stderr.write(`${error.message}\n`);
        return error.exitCode;
      }
      throw error;
    }
  }

  io.stderr.write(`Unknown command: ${command}\n\n${HELP}\n`);
  return 64;
}

function readOption(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  return argv[index + 1];
}

export { connectProvider, normalizeProviderUrl };
