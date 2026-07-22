// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

interface PageParams {
  connectionId: string;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function StaticSecretSetupStatusRedirect({
  params,
  searchParams,
}: {
  params: Promise<PageParams>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { connectionId } = await params;
  const resolvedSearchParams = await searchParams;
  const query = new URLSearchParams();
  const runId = firstValue(resolvedSearchParams.run_id);
  const identity = firstValue(resolvedSearchParams.identity);
  if (runId) {
    query.set("run_id", runId);
  }
  if (identity) {
    query.set("identity", identity);
  }
  const suffix = query.toString();
  const statusHref = `/connect/status/${encodeURIComponent(decodeURIComponent(connectionId))}`;
  redirect(suffix ? `${statusHref}?${suffix}` : statusHref);
}
