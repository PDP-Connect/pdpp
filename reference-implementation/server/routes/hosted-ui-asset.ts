// HTTP adapter for the shared hosted-UI stylesheet asset route.
//
// Behaviour-preserving extraction from `server/index.js` per the OpenSpec
// change `split-reference-server-by-route-family`. The same handler was
// previously registered inline and verbatim in both `buildAsApp` and
// `buildRsApp`, immediately before the root (`GET /`) mount, to preserve
// route registration order. This module hosts the single shared definition;
// each app calls `mountHostedUiCss(app)` at the same point.
//
// Route covered:
//   GET /__pdpp/hosted-ui.css - shared stylesheet for reference server-rendered
//                               HTML pages (consent, device, approval results,
//                               owner-login).
//
// This is a reference-only asset, not a PDPP protocol surface. The AS app
// serves it so its server-rendered pages can style themselves; the RS app
// serves its own copy so the browser-friendly RS root landing can load styles
// from its own origin without depending on the AS port being reachable. See
// `reference-implementation/server/hosted-ui.js` for the asset itself.
//
// Auth posture: none. The original route is unauthenticated — it returns a
// static stylesheet with no user data. This adapter owns Express plumbing only.

import { HOSTED_UI_CSS, HOSTED_UI_CSS_PATH } from "../hosted-ui.js";
import type { RouteArg } from "./_route-contract.ts";

interface RouteResponse {
  send(body: string): unknown;
  setHeader(name: string, value: string): unknown;
}

type RouteHandler = (req: unknown, res: RouteResponse) => void;

interface AppLike {
  get(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
}

// GET /__pdpp/hosted-ui.css

export function mountHostedUiCss(app: AppLike): void {
  const handler: RouteHandler = (_req, res) => {
    res.setHeader("Content-Type", "text/css; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(HOSTED_UI_CSS);
  };
  app.get(HOSTED_UI_CSS_PATH, handler);
}
