// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { stringifyForJsonl } from "@pdpp/collector-runtime";

process.stdout.write(stringifyForJsonl({ type: "DONE", status: "succeeded", records_emitted: 0 }));
process.exit(1);
