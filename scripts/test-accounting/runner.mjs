// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export function commandsFor(loader, files, reporter) {
  if (loader === 'node-test') return [['node', '--test', '--import', 'tsx', `--test-reporter=${reporter}`, ...files]];
  if (loader === 'python-unittest') return files.map((path) => ['uv', 'run', 'python', path, '-v']);
  if (loader === 'shell') return files.map((path) => ['sh', path]);
  throw new Error(`test accounting runner: unsupported loader ${loader}`);
}
