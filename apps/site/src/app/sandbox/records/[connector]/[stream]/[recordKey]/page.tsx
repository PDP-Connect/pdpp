import { redirect } from "next/navigation";
import { sandboxExploreRedirectHref } from "../../../explore-redirect.ts";

export const dynamic = "force-static";

export default async function SandboxRecordDetailPage({
  params,
}: {
  params: Promise<{ connector: string; recordKey: string; stream: string }>;
}) {
  const { connector, recordKey, stream } = await params;
  redirect(
    sandboxExploreRedirectHref({
      connectorId: decodeURIComponent(connector),
      recordId: decodeURIComponent(recordKey),
      stream: decodeURIComponent(stream),
    })
  );
}
