import { redirect } from "next/navigation";
import { sandboxExploreRedirectHref } from "../../explore-redirect.ts";

export const dynamic = "force-static";

export default async function SandboxStreamPage({
  params,
}: {
  params: Promise<{ connector: string; stream: string }>;
}) {
  const { connector, stream } = await params;
  redirect(
    sandboxExploreRedirectHref({
      connectorId: decodeURIComponent(connector),
      stream: decodeURIComponent(stream),
    })
  );
}
