import { proxyReferenceCatchAll } from "../../../reference-proxy.ts";

const prefix = [".well-known", "oauth-protected-resource"] as const;

export const GET = (request: Request, context: Parameters<typeof proxyReferenceCatchAll>[3]) =>
  proxyReferenceCatchAll(request, "rs", prefix, context);
