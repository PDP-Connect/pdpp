import { proxyReferenceRequest } from "../reference-proxy.ts";

const path = ["introspect"] as const;

export const POST = (request: Request) => proxyReferenceRequest(request, "as", path);
