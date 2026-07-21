// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { executeSchemaGet } from "pdpp-reference-implementation/operations/rs-schema-get";
import { createSandboxSchemaGetDependencies } from "../../_demo/operations-fixtures.ts";
import { jsonResponse } from "../_helpers.ts";

export const dynamic = "force-static";

export async function GET(): Promise<Response> {
  const result = await executeSchemaGet(
    { actor: { kind: "owner", subject_id: null } },
    createSandboxSchemaGetDependencies()
  );
  return jsonResponse(result.response);
}
