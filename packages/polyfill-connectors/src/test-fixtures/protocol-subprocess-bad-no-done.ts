// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { stringifyForJsonl } from "@pdpp/collector-runtime";

process.stdout.write(stringifyForJsonl({ type: "PROGRESS", message: "started but never completed" }));
process.exit(0);
