import {
  executeRecordDetail,
  RecordDetailVisibilityError,
} from "pdpp-reference-implementation/operations/rs-records-detail";
import { createSandboxRecordDetailDependencies } from "../../../../../_demo/operations-fixtures.ts";
import { jsonResponse, notFound } from "../../../../_helpers.ts";

export const dynamic = "force-static";

export async function GET(_request: Request, ctx: { params: Promise<{ stream: string; recordId: string }> }) {
  const { stream, recordId } = await ctx.params;
  try {
    const out = await executeRecordDetail(
      {
        actor: { kind: "owner", subject_id: null },
        streamName: stream,
        recordId,
      },
      createSandboxRecordDetailDependencies(stream)
    );
    return jsonResponse(out.record);
  } catch (err) {
    if (err instanceof RecordDetailVisibilityError && err.code === "not_found") {
      return notFound(`record not found: stream=${stream} record_id=${recordId}`);
    }
    throw err;
  }
}
