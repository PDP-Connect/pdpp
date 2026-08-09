// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic local fake CardDAV server for Apple Contacts connector
 * tests. Implements just enough of RFC 5785 well-known discovery, RFC 6764
 * bootstrap PROPFINDs, RFC 6352 address book listing, and RFC 6578
 * sync-collection REPORT (plus a bounded addressbook-query fallback) to
 * exercise the connector end-to-end without any network access or real
 * Apple account.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { unescapeVCardValue } from "./vcard.ts";

export interface FakeContact {
  href: string;
  uid: string;
  vcard: string;
}

export interface FakeServerOptions {
  /** When true, REPORT sync-collection returns 501 (unsupported); the
   *  server still answers addressbook-query so the fallback path works. */
  disableSyncCollection?: boolean;
  password: string;
  /** When true, /.well-known/carddav redirects to a second listener
   *  simulating iCloud's regional-host resolution, instead of a
   *  same-origin redirect. */
  regionalHost?: boolean;
  /** When true, /.well-known/carddav answers PROPFIND inline (207, no
   *  redirect) with `current-user-principal` 404'd in its propstat — the
   *  real behavior observed live against iCloud — instead of the
   *  RFC-6764-typical redirect. `current-user-principal` is only answered
   *  at the bare origin root ("/") in this mode, so the test exercises
   *  discoverCardDav's origin-root fallback. */
  wellKnownAnswersInlineWithoutPrincipal?: boolean;
  username: string;
}

export interface FakeCardDavServer {
  readonly authRejectedCount: number;
  close: () => Promise<void>;
  contacts: Map<string, FakeContact>;
  deletedHrefs: Set<string>;
  markChanged: () => void;
  origin: string;
  port: number;
  regionalOrigin: string | null;
  requestLog: Array<{ method: string; url: string }>;
  url: (path: string) => string;
}

const NS_D = "DAV:";
const NS_CS = "http://calendarserver.org/ns/";
const PRINCIPAL_PATH = "/principals/owner/";
const HOME_PATH = "/addressbooks/owner/";
const BOOK_PATH = "/addressbooks/owner/card/";

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function multistatus(inner: string): string {
  return `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="${NS_D}" xmlns:CS="${NS_CS}" xmlns:C="urn:ietf:params:xml:ns:carddav">${inner}</D:multistatus>`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function checkAuth(req: IncomingMessage, username: string, password: string): boolean {
  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) {
    return false;
  }
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  return decoded === `${username}:${password}`;
}

/**
 * Start a fake CardDAV server. Address book state (contacts, deletions) is
 * mutable on the returned handle so tests can simulate multi-run sync
 * scenarios (add / edit / delete between two connector runs).
 */
export async function startFakeCardDavServer(options: FakeServerOptions): Promise<FakeCardDavServer> {
  const {
    username,
    password,
    disableSyncCollection = false,
    regionalHost = false,
    wellKnownAnswersInlineWithoutPrincipal = false,
  } = options;
  const contacts = new Map<string, FakeContact>();
  const deletedHrefs = new Set<string>();
  const requestLog: Array<{ method: string; url: string }> = [];
  let authRejectedCount = 0;
  let changeCounter = 1;
  let regionalOrigin: string | null = null;

  const respondWellKnownPrincipalNotFound = (res: ServerResponse): void => {
    // Mirrors the real iCloud shape: 207 Multi-Status, single <response>
    // for the well-known resource itself, current-user-principal reported
    // via a 404 propstat (RFC 4918 §14.22) rather than populated.
    const responseBody = multistatus(
      `<D:response><D:href>/.well-known/carddav/</D:href><D:propstat><D:prop><D:current-user-principal/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response>`
    );
    res.writeHead(207, { "Content-Type": "application/xml" });
    res.end(responseBody);
  };

  const respondWellKnown = (res: ServerResponse, thisOrigin: () => string): void => {
    if (wellKnownAnswersInlineWithoutPrincipal) {
      respondWellKnownPrincipalNotFound(res);
      return;
    }
    const target = regionalOrigin && regionalOrigin !== thisOrigin() ? regionalOrigin : thisOrigin();
    res.writeHead(302, { Location: `${target}${PRINCIPAL_PATH}` });
    res.end();
  };

  const respondCurrentUserPrincipal = (res: ServerResponse, atHref: string): void => {
    const responseBody = multistatus(
      `<D:response><D:href>${atHref}</D:href><D:propstat><D:prop><D:current-user-principal><D:href>${PRINCIPAL_PATH}</D:href></D:current-user-principal></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
    );
    res.writeHead(207, { "Content-Type": "application/xml" });
    res.end(responseBody);
  };

  const respondAddressbookHomeSet = (res: ServerResponse): void => {
    const responseBody = multistatus(
      `<D:response><D:href>${PRINCIPAL_PATH}</D:href><D:propstat><D:prop><C:addressbook-home-set><D:href>${HOME_PATH}</D:href></C:addressbook-home-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
    );
    res.writeHead(207, { "Content-Type": "application/xml" });
    res.end(responseBody);
  };

  const respondAddressbookList = (res: ServerResponse): void => {
    const responseBody = multistatus(
      `<D:response><D:href>${BOOK_PATH}</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:addressbook/></D:resourcetype><D:displayname>Contacts</D:displayname><CS:getctag>"ctag-${String(changeCounter)}"</CS:getctag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
    );
    res.writeHead(207, { "Content-Type": "application/xml" });
    res.end(responseBody);
  };

  const contactResponseBlocks = (): string =>
    [...contacts.values()]
      .map(
        (c) =>
          `<D:response><D:href>${c.href}</D:href><D:propstat><D:prop><D:getetag>"${c.uid}-${String(changeCounter)}"</D:getetag><C:address-data>${xmlEscape(c.vcard)}</C:address-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
      )
      .join("");

  const respondSyncCollection = (res: ServerResponse): void => {
    if (disableSyncCollection) {
      res.writeHead(501, { "Content-Type": "text/plain" });
      res.end("not implemented");
      return;
    }
    const newToken = `sync-token-${String(changeCounter)}`;
    const deleted = [...deletedHrefs]
      .map((href) => `<D:response><D:href>${href}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`)
      .join("");
    const responseBody = multistatus(`${contactResponseBlocks()}${deleted}<D:sync-token>${newToken}</D:sync-token>`);
    res.writeHead(207, { "Content-Type": "application/xml" });
    res.end(responseBody);
  };

  const respondAddressbookQuery = (res: ServerResponse): void => {
    res.writeHead(207, { "Content-Type": "application/xml" });
    res.end(multistatus(contactResponseBlocks()));
  };

  interface Route {
    match: (req: IncomingMessage, url: string, body: string) => boolean;
    respond: (req: IncomingMessage, res: ServerResponse, thisOrigin: () => string) => void;
  }

  const routes: Route[] = [
    {
      match: (_req, url) => url === "/.well-known/carddav",
      respond: (_req, res, thisOrigin) => respondWellKnown(res, thisOrigin),
    },
    {
      match: (req, url, body) =>
        req.method === "PROPFIND" && url === PRINCIPAL_PATH && body.includes("current-user-principal"),
      respond: (_req, res) => respondCurrentUserPrincipal(res, PRINCIPAL_PATH),
    },
    {
      // Origin-root fallback target: only reached (in real discoverCardDav
      // usage) when the well-known step answered inline without the
      // property, per wellKnownAnswersInlineWithoutPrincipal above.
      match: (req, url, body) =>
        req.method === "PROPFIND" && url === "/" && body.includes("current-user-principal"),
      respond: (_req, res) => respondCurrentUserPrincipal(res, "/"),
    },
    {
      match: (req, url, body) =>
        req.method === "PROPFIND" && url === PRINCIPAL_PATH && body.includes("addressbook-home-set"),
      respond: (_req, res) => respondAddressbookHomeSet(res),
    },
    {
      match: (req, url) => req.method === "PROPFIND" && url === HOME_PATH && req.headers.depth === "1",
      respond: (_req, res) => respondAddressbookList(res),
    },
    {
      match: (req, url, body) => req.method === "REPORT" && url === BOOK_PATH && body.includes("sync-collection"),
      respond: (_req, res) => respondSyncCollection(res),
    },
    {
      match: (req, url, body) => req.method === "REPORT" && url === BOOK_PATH && body.includes("addressbook-query"),
      respond: (_req, res) => respondAddressbookQuery(res),
    },
  ];

  const makeHandler =
    (thisOrigin: () => string) =>
    async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const url = req.url ?? "/";
      requestLog.push({ method: req.method ?? "GET", url });

      if (!checkAuth(req, username, password)) {
        authRejectedCount += 1;
        res.writeHead(401, { "Content-Type": "text/plain", "WWW-Authenticate": 'Basic realm="carddav"' });
        res.end("unauthorized");
        return;
      }

      const body = await readBody(req);
      const route = routes.find((r) => r.match(req, url, body));
      if (route) {
        route.respond(req, res, thisOrigin);
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    };

  let server!: Server;
  let regionalServer: Server | null = null;

  server = createServer((req, res) => {
    makeHandler(() => `http://127.0.0.1:${String(port)}`)(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end("internal error");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake_carddav_server_no_port");
  }
  const { port } = address;
  const origin = `http://127.0.0.1:${String(port)}`;

  if (regionalHost) {
    regionalServer = createServer((req, res) => {
      makeHandler(() => regionalOrigin ?? origin)(req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500);
        }
        res.end("internal error");
      });
    });
    await new Promise<void>((resolve) => (regionalServer as Server).listen(0, "127.0.0.1", resolve));
    const regionalAddress = regionalServer.address();
    if (regionalAddress && typeof regionalAddress !== "string") {
      regionalOrigin = `http://127.0.0.1:${String(regionalAddress.port)}`;
    }
  }

  return {
    port,
    origin,
    contacts,
    deletedHrefs,
    requestLog,
    get regionalOrigin(): string | null {
      return regionalOrigin;
    },
    get authRejectedCount(): number {
      return authRejectedCount;
    },
    url: (path: string) => `${origin}${path}`,
    markChanged: () => {
      changeCounter += 1;
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      if (regionalServer) {
        await new Promise<void>((resolve, reject) =>
          (regionalServer as Server).close((err) => (err ? reject(err) : resolve()))
        );
      }
    },
  };
}

export function buildVCard(fields: {
  categories?: string[];
  email?: string;
  fn: string;
  photo?: { base64: string; mediaType: string };
  uid: string;
}): string {
  const lines = ["BEGIN:VCARD", "VERSION:3.0", `UID:${fields.uid}`, `FN:${unescapeVCardValue(fields.fn)}`];
  if (fields.email) {
    lines.push(`EMAIL;TYPE=HOME:${fields.email}`);
  }
  if (fields.categories?.length) {
    lines.push(`CATEGORIES:${fields.categories.join(",")}`);
  }
  if (fields.photo) {
    lines.push(`PHOTO;ENCODING=b;TYPE=${fields.photo.mediaType.toUpperCase()}:${fields.photo.base64}`);
  }
  lines.push("END:VCARD");
  return lines.join("\r\n");
}
