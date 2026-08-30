import { sharedHelper } from "../../src/shared-runtime.ts";

export function runAlpha(): string {
  return `alpha-${sharedHelper()}`;
}
