// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { acquireInner } from "./inner-browser-helper.ts";

export function getBrowserPage(): ReturnType<typeof acquireInner> {
  return acquireInner();
}
