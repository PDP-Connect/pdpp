// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export function combineTestAndCleanupFailure(testError, cleanupError, context) {
  if (!testError) {
    return cleanupError;
  }
  if (!cleanupError) {
    return testError;
  }
  return new AggregateError([testError, cleanupError], `${context} and database cleanup both failed`);
}

export function testProcessExitFailure(filePath, code, signal, output) {
  const outcome = signal ? `exited via signal ${signal}` : `exited with code ${code}`;
  const error = new Error(`Test process for ${filePath} ${outcome}\n${output}`);
  error.output = output;
  return error;
}
