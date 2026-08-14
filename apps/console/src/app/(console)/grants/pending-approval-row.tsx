// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants, IcButton, IcTimestamp } from "@pdpp/brand-react";
import { formatSourceForDisplay } from "@pdpp/display";
import { StatusBadge } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import type { PendingApproval } from "../lib/ref-client.ts";
import { technicalClientCaption } from "./client-caption.ts";

/** Queue row only. It can route to review or deny; grant issuance is absent. */
export function PendingApprovalRow({
  approval,
  denyAction,
}: {
  approval: PendingApproval;
  denyAction: (formData: FormData) => void | Promise<void>;
}) {
  const previewStreams = Array.isArray(approval.grant_preview?.streams)
    ? approval.grant_preview.streams.flatMap((stream) => {
        const name = typeof stream === "string" ? stream : stream?.name || "";
        return name ? [name] : [];
      })
    : [];
  const denialTarget = approval.kind === "consent" ? "data-access request" : "owner-device authorization";

  return (
    <div className="grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-2">
          <code className="pdpp-caption break-all font-medium font-mono text-foreground">{approval.approval_id}</code>
          <span className="pdpp-caption text-muted-foreground">
            <IcTimestamp value={approval.created_at} />
          </span>
          <StatusBadge status={approval.kind} />
        </div>
        <div className="pdpp-caption mt-1 break-words text-muted-foreground">
          {technicalClientCaption(approval.client_id) ?? "client —"}
          {approval.grant_preview?.source ? ` · source ${formatSourceForDisplay(approval.grant_preview.source)}` : ""}
          {previewStreams.length ? ` · streams ${previewStreams.join(", ")}` : ""}
        </div>
      </div>
      <form className="flex flex-wrap gap-2">
        <input name="kind" type="hidden" value={approval.kind} />
        <input name="approval_id" type="hidden" value={approval.approval_id} />
        <Link
          className={buttonVariants({ size: "sm", variant: "human" })}
          href={`/grants/approvals/${encodeURIComponent(approval.approval_id)}`}
        >
          Review request
        </Link>
        <IcButton
          aria-label={`Deny ${denialTarget} ${approval.approval_id}`}
          formAction={denyAction}
          size="sm"
          type="submit"
          variant="destructive"
        >
          Deny request
        </IcButton>
      </form>
    </div>
  );
}
