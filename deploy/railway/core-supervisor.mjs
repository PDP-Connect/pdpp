#!/usr/bin/env node
import { spawn } from 'node:child_process';
import process from 'node:process';

const children = new Map();
let shuttingDown = false;
let exitCode = 0;

function start(name, command, args, options) {
  const child = spawn(command, args, {
    ...options,
    stdio: 'inherit',
  });
  children.set(name, child);
  child.on('exit', (code, signal) => {
    children.delete(name);
    if (code !== 0 || signal) {
      exitCode = code ?? 1;
    }
    if (shuttingDown) {
      if (children.size === 0) {
        process.exit(exitCode);
      }
      return;
    }
    shuttingDown = true;
    for (const [otherName, other] of children.entries()) {
      console.error(`[railway-core] ${name} exited; stopping ${otherName}`);
      other.kill('SIGTERM');
    }
    if (children.size === 0) {
      process.exit(exitCode);
    }
  });
  return child;
}

function stop(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of children.values()) {
    child.kill(signal);
  }
  if (children.size === 0) {
    process.exit(exitCode);
  }
}

process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

const referenceEnv = {
  ...process.env,
  AS_PORT: '7662',
  RS_PORT: '7663',
  PDPP_AS_URL: 'http://127.0.0.1:7662',
  PDPP_RS_URL: 'http://127.0.0.1:7663',
};

const consoleEnv = {
  ...process.env,
  HOSTNAME: process.env.HOSTNAME || '0.0.0.0',
  PORT: process.env.PORT || '3000',
  PDPP_AS_URL: 'http://127.0.0.1:7662',
  PDPP_RS_URL: 'http://127.0.0.1:7663',
};

start('reference', process.execPath, ['/app/reference-implementation/server/index.js'], {
  cwd: '/app',
  env: referenceEnv,
});
start('console', process.execPath, ['/console/apps/console/server.js'], {
  cwd: '/console',
  env: consoleEnv,
});
