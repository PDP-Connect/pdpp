import { proxyReferenceRequest } from "../reference-proxy.ts";

const path = ["mcp"] as const;

export const GET = (request: Request) => proxyReferenceRequest(request, "rs", path);
export const POST = (request: Request) => proxyReferenceRequest(request, "rs", path);
export const DELETE = (request: Request) => proxyReferenceRequest(request, "rs", path);
