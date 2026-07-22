// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { stringifyForJsonl } from "../safe-emit.ts";

process.stdout.write(stringifyForJsonl({ type: "PROGRESS", message: "started but never completed" }));
process.exit(0);
