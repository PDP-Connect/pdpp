import { redirect } from "next/navigation";
import { sandboxExploreRedirectHref } from "../explore-redirect.ts";

export const dynamic = "force-static";

export default async function SandboxConnectorPage({ params }: { params: Promise<{ connector: string }> }) {
  const { connector } = await params;
  redirect(sandboxExploreRedirectHref({ connectorId: decodeURIComponent(connector) }));
}
