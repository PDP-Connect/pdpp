// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  executeRecordsList,
  RecordsListVisibilityError,
} from "pdpp-reference-implementation/operations/rs-records-list";
import { createSandboxRecordsListDependencies } from "../../../../_demo/operations-fixtures.ts";
import { jsonResponse, notFound, readListParams } from "../../../_helpers.ts";

// Reads `cursor`, `limit`, `connector_id` from the query string.
export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ stream: string }> }) {
  const { stream } = await ctx.params;
  const url = new URL(request.url);
  const params = readListParams(url);
  const requestParams: Record<string, unknown> = {};
  if (params.cursor !== null) {
    requestParams.cursor = params.cursor;
  }
  if (params.limit !== undefined) {
    requestParams.limit = params.limit;
  }
  try {
    const out = await executeRecordsList(
      {
        actor: { kind: "owner", subject_id: null },
        requestParams,
        streamName: stream,
      },
      createSandboxRecordsListDependencies({
        streamName: stream,
        ...(params.connector_id === undefined ? {} : { connectorId: params.connector_id }),
      })
    );
    return jsonResponse({
      ...out.result,
      url: `/sandbox/v1/streams/${encodeURIComponent(stream)}/records`,
    });
  } catch (err) {
    if (err instanceof RecordsListVisibilityError && err.code === "not_found") {
      return notFound(`stream not found: ${stream}`);
    }
    throw err;
  }
}
