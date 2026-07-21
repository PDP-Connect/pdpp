import { proxyReferenceCatchAll } from "../../reference-proxy.ts";

const prefix = ["oauth"] as const;

export const GET = (request: Request, context: Parameters<typeof proxyReferenceCatchAll>[3]) =>
  proxyReferenceCatchAll(request, "as", prefix, context);
export const POST = GET;
export const DELETE = GET;
