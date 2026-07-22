// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Bounded error type for the trusted owner-agent onboarding flow.
//
// Carries a stable machine code and a process exit code so callers can map
// failures to terminal status without parsing free-form messages. Messages
// MUST NOT contain bearer material.
export class OwnerAgentError extends Error {
  constructor(code, message, exitCode = 69) {
    super(message);
    this.name = "OwnerAgentError";
    this.code = code;
    this.exitCode = exitCode;
  }
}
