// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { notFound } from "next/navigation";
import { RecordroomShellWithPalette } from "../../../components/recordroom-shell-with-palette.tsx";
import {
  type ApprovalReview as ApprovalReviewData,
  getPendingApprovalReview,
  RefNotFoundError,
} from "../../../lib/ref-client.ts";
import { approveReviewedPendingApprovalAction, denyPendingApprovalAction } from "../../pending-actions.ts";
import { ApprovalReview } from "./approval-review.tsx";

export const dynamic = "force-dynamic";

export default async function ApprovalReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ approvalId: string }>;
  searchParams: Promise<{ approval_error?: string; confirm?: string }>;
}) {
  const [{ approvalId }, query] = await Promise.all([params, searchParams]);
  let detail: ApprovalReviewData;
  try {
    detail = await getPendingApprovalReview(approvalId);
  } catch (err) {
    if (err instanceof RefNotFoundError) {
      notFound();
    }
    throw err;
  }
  return (
    <RecordroomShellWithPalette>
      <ApprovalReview
        approveAction={approveReviewedPendingApprovalAction}
        confirm={!query.approval_error && query.confirm === "1"}
        denyAction={denyPendingApprovalAction}
        detail={detail}
        error={query.approval_error}
      />
    </RecordroomShellWithPalette>
  );
}
