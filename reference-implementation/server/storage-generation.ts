// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

let generation = 0;

export function bumpStorageGeneration(): number {
  generation += 1;
  return generation;
}

export function currentStorageGeneration(): number {
  return generation;
}

export function isCurrentStorageGeneration(capturedGeneration: number): boolean {
  return capturedGeneration === generation;
}
