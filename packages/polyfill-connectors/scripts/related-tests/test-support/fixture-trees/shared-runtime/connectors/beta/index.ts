import { sharedHelper } from "../../src/shared-runtime.ts";

export function runBeta(): string {
  return `beta-${sharedHelper()}`;
}
