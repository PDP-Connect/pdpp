#!/usr/bin/env node
import { bootstrapBrowser, probeBrowser } from '../src/bootstrap.js';
import { startDaemon, stopDaemon, daemonStatus, paths } from '../src/browser-daemon.js';
import { spawn } from 'node:child_process';

const [, , area, action, ...rest] = process.argv;

function printUsage() {
  console.error('Usage:');
  console.error('  pdpp-connectors browser bootstrap [platform...]');
  console.error('  pdpp-connectors browser probe     [platform...]');
  console.error('  pdpp-connectors browser start     [--headed] [--xvfb]');
  console.error('  pdpp-connectors browser stop');
  console.error('  pdpp-connectors browser status');
  console.error('  pdpp-connectors browser restart   [--headed] [--xvfb]');
  console.error('  pdpp-connectors browser logs');
  console.error('');
  console.error('  --headed : render a real browser window instead of headless');
  console.error('  --xvfb   : wrap headful launch in a virtual X display (unattended headful)');
  console.error('             — required for Akamai-protected sites like Chase that detect headless Chromium.');
}

async function main() {
  if (area === 'browser' && action === 'bootstrap') {
    const platforms = rest.length ? rest : undefined;
    const status = await bootstrapBrowser({ platforms });
    process.exit(Object.values(status).every((s) => s === 'ok') ? 0 : 1);
  }
  if (area === 'browser' && action === 'probe') {
    const platforms = rest.length ? rest : undefined;
    const status = await probeBrowser({ platforms });
    process.exit(Object.values(status).every((s) => s === 'ok') ? 0 : 1);
  }
  if (area === 'browser' && action === 'start') {
    const xvfb = rest.includes('--xvfb');
    // --xvfb implies --headed (running headless under Xvfb defeats the point)
    const headless = !rest.includes('--headed') && !xvfb;
    const info = await startDaemon({ headless, xvfb });
    console.log(`browser daemon running pid=${info.pid} ws=${info.wsEndpoint} xvfb=${xvfb}`);
    process.exit(0);
  }
  if (area === 'browser' && action === 'stop') {
    const result = await stopDaemon();
    console.log(JSON.stringify(result));
    process.exit(0);
  }
  if (area === 'browser' && action === 'status') {
    const s = await daemonStatus();
    console.log(JSON.stringify(s, null, 2));
    process.exit(s.running ? 0 : 1);
  }
  if (area === 'browser' && action === 'restart') {
    await stopDaemon();
    const xvfb = rest.includes('--xvfb');
    const headless = !rest.includes('--headed') && !xvfb;
    const info = await startDaemon({ headless, xvfb });
    console.log(`browser daemon running pid=${info.pid} ws=${info.wsEndpoint} xvfb=${xvfb}`);
    process.exit(0);
  }
  if (area === 'browser' && action === 'logs') {
    const child = spawn('tail', ['-f', paths.LOG_PATH], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }
  printUsage();
  process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
