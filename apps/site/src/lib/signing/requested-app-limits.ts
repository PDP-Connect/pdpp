// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Limits for "Which apps would you like to see join PDPP?", shared by the form,
// the server schema and the retry cookie so they cannot disagree. Ten is a
// bound on abuse, not a target: most people name one or two.
export const MAX_REQUESTED_APPS = 10;
export const MAX_REQUESTED_APP_LENGTH = 60;
