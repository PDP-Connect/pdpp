import { proxyReferenceCatchAll } from "../../reference-proxy.ts";

const prefix = ["v1"] as const;

export const GET = (request: Request, context: Parameters<typeof proxyReferenceCatchAll>[3]) =>
  proxyReferenceCatchAll(request, "rs", prefix, context);
export const POST = GET;
export const PUT = GET;
export const DELETE = GET;
