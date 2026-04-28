import { spawn } from "node:child_process";
import net from "node:net";

const DEFAULT_WEB_PORT = 3000;
const MAX_PORT_SCAN = 100;

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "0.0.0.0");
  });
}

async function chooseWebPort() {
  const configured = process.env.PDPP_WEB_PORT;
  if (configured) {
    const parsed = Number(configured);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
      throw new Error(`PDPP_WEB_PORT must be a valid TCP port, got ${JSON.stringify(configured)}`);
    }
    return parsed;
  }

  for (let offset = 0; offset < MAX_PORT_SCAN; offset += 1) {
    const port = DEFAULT_WEB_PORT + offset;
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new Error(`No available web port found in ${DEFAULT_WEB_PORT}-${DEFAULT_WEB_PORT + MAX_PORT_SCAN - 1}`);
}

let webPort;
try {
  webPort = await chooseWebPort();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[pdpp dev] ${message}`);
  process.exit(1);
}
const env = {
  ...process.env,
  PDPP_WEB_PORT: String(webPort),
  PDPP_REFERENCE_ORIGIN: process.env.PDPP_REFERENCE_ORIGIN ?? `http://localhost:${webPort}`,
};

console.error(`[pdpp dev] web origin: ${env.PDPP_REFERENCE_ORIGIN}`);

const child = spawn(
  "pnpm",
  [
    "-r",
    "--parallel",
    "--stream",
    "--filter",
    "pdpp-reference-implementation",
    "--filter",
    "pdpp-web",
    "run",
    "dev",
  ],
  {
    env,
    stdio: "inherit",
  },
);

child.once("error", (err) => {
  console.error(`[pdpp dev] failed to start pnpm: ${err.message}`);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

const SIGNAL_EXIT_CODES = {
  SIGINT: 130,
  SIGTERM: 143,
};

child.on("exit", (code, signal) => {
  if (signal) {
    process.exit(SIGNAL_EXIT_CODES[signal] ?? 1);
  }
  process.exit(code ?? 0);
});
