import { redirect } from "next/navigation";
import { sandboxExploreRedirectHref } from "./explore-redirect.ts";

export const dynamic = "force-static";

export default function SandboxRecordsPage() {
  redirect(sandboxExploreRedirectHref());
}
