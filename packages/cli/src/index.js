import {
  createPdppCliCommand,
  getPdppCliPackageInfo,
  PDPP_CLI_BIN_NAME,
  PDPP_CLI_PACKAGE_NAME,
} from './package-info.js';

const HELP = `PDPP CLI

Usage:
  ${PDPP_CLI_BIN_NAME} --help
  ${PDPP_CLI_BIN_NAME} package-info [--provider-url <url>]
  ${PDPP_CLI_BIN_NAME} connect <provider-url>

Agent access:
  ${createPdppCliCommand()}

Notes:
  connect is gated until the reference AS supports no-owner-token scoped grant completion.
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

    const normalizedProviderUrl = normalizeProviderUrl(providerUrl);
    if (!normalizedProviderUrl) {
      io.stderr.write(`Invalid provider URL: ${providerUrl}\n`);
      return 64;
    }

    io.stderr.write(
      `${PDPP_CLI_PACKAGE_NAME} connect is not enabled yet. The reference AS still needs no-owner-token scoped grant completion before this command can be advertised.\n`
    );
    return 69;
  }

  io.stderr.write(`Unknown command: ${command}\n\n${HELP}\n`);
  return 64;
}

export function normalizeProviderUrl(value) {
  try {
    const parsed = new URL(value.includes('://') ? value : `https://${value}`);
    parsed.hash = '';
    return parsed.origin;
  } catch {
    return null;
  }
}

function readOption(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  return argv[index + 1];
}
