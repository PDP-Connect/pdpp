// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal RFC 6350 (vCard 3.0/4.0) parser for the Apple Contacts connector.
 *
 * Scope is bounded to what CardDAV contact collection needs: line
 * unfolding, `\,`/`\;`/`\n` value escaping, TYPE parameters (for
 * typed emails/phones/addresses), and the handful of properties Apple's
 * CardDAV vCards actually carry (FN, N, EMAIL, TEL, ADR, ORG, TITLE,
 * NOTE, BDAY, PHOTO, UID, REV, CATEGORIES). It is not a general-purpose
 * vCard library — unknown properties are preserved in `rawProperties` but
 * not individually modeled.
 */

export interface VCardTypedValue {
  types: string[];
  value: string;
}

export interface VCardAddress extends VCardTypedValue {
  city?: string;
  country?: string;
  extended?: string;
  poBox?: string;
  postalCode?: string;
  region?: string;
  street?: string;
}

export interface VCardPhoto {
  base64: string;
  mediaType?: string;
}

export interface ParsedVCard {
  addresses: VCardAddress[];
  birthday?: string;
  emails: VCardTypedValue[];
  familyName?: string;
  fn?: string;
  givenName?: string;
  note?: string;
  org?: string;
  phones: VCardTypedValue[];
  photo?: VCardPhoto;
  rawProperties: Array<{ name: string; params: Record<string, string[]>; value: string }>;
  rev?: string;
  title?: string;
  uid?: string;
}

/** Unfold RFC 6350 line folding: a CRLF followed by a single space/tab
 *  continues the previous line. */
function unfoldLines(raw: string): string[] {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rawLines = normalized.split("\n");
  const lines: string[] = [];
  for (const line of rawLines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else if (line.length > 0) {
      lines.push(line);
    }
  }
  return lines;
}

/** Unescape a vCard TEXT value: `\,` `\;` `\\` `\n`/`\N` per RFC 6350 §3.4. */
export function unescapeVCardValue(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "\\" && i + 1 < value.length) {
      const next = value[i + 1];
      if (next === "n" || next === "N") {
        out += "\n";
      } else if (next === "," || next === ";" || next === "\\") {
        out += next;
      } else {
        out += next;
      }
      i += 1;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Escape a value for emission inside a vCard TEXT property. */
export function escapeVCardValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

/** Split a raw component-list value on unescaped `;`. */
function splitComponents(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === "\\" && i + 1 < value.length) {
      current += (value[i] ?? "") + (value[i + 1] ?? "");
      i += 1;
    } else if (value[i] === ";") {
      parts.push(current);
      current = "";
    } else {
      current += value[i];
    }
  }
  parts.push(current);
  return parts.map(unescapeVCardValue);
}

/** Split a comma-list value (e.g. multi-valued EMAIL TYPE) on unescaped `,`. */
function splitList(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === "\\" && i + 1 < value.length) {
      current += (value[i] ?? "") + (value[i + 1] ?? "");
      i += 1;
    } else if (value[i] === ",") {
      parts.push(current);
      current = "";
    } else {
      current += value[i];
    }
  }
  parts.push(current);
  return parts.map((s) => unescapeVCardValue(s));
}

interface PropertyLine {
  group?: string;
  name: string;
  params: Record<string, string[]>;
  value: string;
}

/** Parse one unfolded content line into name/params/value, per RFC 6350 §3.3. */
function parseLine(line: string): PropertyLine | null {
  // Split "NAME;PARAM=val;PARAM2=val2:value" on the first unescaped colon.
  let colonIdx = -1;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === "\\" && i + 1 < line.length) {
      i += 1;
      continue;
    }
    if (line[i] === ":") {
      colonIdx = i;
      break;
    }
  }
  if (colonIdx === -1) {
    return null;
  }
  const head = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const segments = head.split(";");
  const firstSegment = segments[0] ?? "";
  let name = firstSegment;
  let group: string | undefined;
  const dotIdx = firstSegment.indexOf(".");
  if (dotIdx !== -1) {
    group = firstSegment.slice(0, dotIdx);
    name = firstSegment.slice(dotIdx + 1);
  }
  const params: Record<string, string[]> = {};
  for (const seg of segments.slice(1)) {
    const eqIdx = seg.indexOf("=");
    if (eqIdx === -1) {
      // Bare TYPE shorthand, e.g. `;HOME` in vCard 2.1-ish producers.
      params.TYPE = [...(params.TYPE ?? []), seg.toUpperCase()];
      continue;
    }
    const paramName = seg.slice(0, eqIdx).toUpperCase();
    const paramValue = seg.slice(eqIdx + 1);
    const values = paramValue.split(",");
    params[paramName] = [...(params[paramName] ?? []), ...values];
  }
  return { name: name.toUpperCase(), params, value, ...(group ? { group } : {}) };
}

function typesFor(params: Record<string, string[]>): string[] {
  return (params.TYPE ?? []).map((t) => t.toUpperCase()).filter((t) => t !== "PREF");
}

const URN_UUID_PREFIX_RE = /^urn:uuid:/i;
const PHOTO_DATA_URI_RE = /^data:([^;]+);base64,(.+)$/i;

type PropertyHandler = (card: ParsedVCard, params: Record<string, string[]>, value: string) => void;

function applyN(card: ParsedVCard, _params: Record<string, string[]>, value: string): void {
  const parts = splitComponents(value);
  if (parts[0]) {
    card.familyName = parts[0];
  }
  if (parts[1]) {
    card.givenName = parts[1];
  }
}

function applyAdr(card: ParsedVCard, params: Record<string, string[]>, value: string): void {
  const parts = splitComponents(value);
  card.addresses.push({
    types: typesFor(params),
    value: unescapeVCardValue(value),
    ...(parts[0] ? { poBox: parts[0] } : {}),
    ...(parts[1] ? { extended: parts[1] } : {}),
    ...(parts[2] ? { street: parts[2] } : {}),
    ...(parts[3] ? { city: parts[3] } : {}),
    ...(parts[4] ? { region: parts[4] } : {}),
    ...(parts[5] ? { postalCode: parts[5] } : {}),
    ...(parts[6] ? { country: parts[6] } : {}),
  });
}

function applyOrg(card: ParsedVCard, _params: Record<string, string[]>, value: string): void {
  const org = splitComponents(value).filter(Boolean).join(" / ");
  if (org) {
    card.org = org;
  }
}

function applyBday(card: ParsedVCard, _params: Record<string, string[]>, value: string): void {
  const bday = value.trim();
  if (bday) {
    card.birthday = bday;
  }
}

function applyRev(card: ParsedVCard, _params: Record<string, string[]>, value: string): void {
  const rev = value.trim();
  if (rev) {
    card.rev = rev;
  }
}

/** vCard 4: `PHOTO:data:image/jpeg;base64,<data>` or a URI (URI form is
 *  skipped — no blob to embed without a fetch, out of scope). vCard 3:
 *  `PHOTO;ENCODING=b;TYPE=JPEG:<base64>`. */
function applyPhoto(card: ParsedVCard, params: Record<string, string[]>, value: string): void {
  const trimmed = value.trim();
  const dataUriMatch = PHOTO_DATA_URI_RE.exec(trimmed);
  if (dataUriMatch?.[1] !== undefined) {
    card.photo = { mediaType: dataUriMatch[1], base64: dataUriMatch[2] ?? "" };
    return;
  }
  if ((params.ENCODING ?? []).some((e) => e.toUpperCase() === "B") && trimmed) {
    const mediaTypeParam = params.TYPE?.[0];
    card.photo = {
      base64: trimmed,
      ...(mediaTypeParam ? { mediaType: `image/${mediaTypeParam.toLowerCase()}` } : {}),
    };
  }
}

const PROPERTY_HANDLERS: Record<string, PropertyHandler> = {
  FN: (card, _params, value) => {
    card.fn = unescapeVCardValue(value);
  },
  N: applyN,
  EMAIL: (card, params, value) => {
    card.emails.push({ types: typesFor(params), value: unescapeVCardValue(value) });
  },
  TEL: (card, params, value) => {
    card.phones.push({ types: typesFor(params), value: unescapeVCardValue(value) });
  },
  ADR: applyAdr,
  ORG: applyOrg,
  TITLE: (card, _params, value) => {
    card.title = unescapeVCardValue(value);
  },
  NOTE: (card, _params, value) => {
    card.note = unescapeVCardValue(value);
  },
  BDAY: applyBday,
  UID: (card, _params, value) => {
    card.uid = unescapeVCardValue(value).replace(URN_UUID_PREFIX_RE, "");
  },
  REV: applyRev,
  PHOTO: applyPhoto,
};

/** Parse a single vCard's unfolded content lines (excluding BEGIN/END:VCARD). */
export function parseVCardLines(lines: string[]): ParsedVCard {
  const card: ParsedVCard = {
    addresses: [],
    emails: [],
    phones: [],
    rawProperties: [],
  };
  for (const raw of lines) {
    const parsed = parseLine(raw);
    if (!parsed) {
      continue;
    }
    const { name, params, value } = parsed;
    card.rawProperties.push({ name, params, value });
    PROPERTY_HANDLERS[name]?.(card, params, value);
  }
  return card;
}

export interface VCardWithGroupInfo extends ParsedVCard {
  /** CATEGORIES property values, if present — used as a lightweight
   *  group-membership signal when the server exposes groups as vCard
   *  group vCards (kind=group) rather than a separate collection. */
  categories: string[];
}

/** Parse a full CardDAV multi-vCard text blob (a REPORT response embeds
 *  one vCard per `calendar-data`/`address-data` element, but some server
 *  responses concatenate). Returns one ParsedVCard per BEGIN/END:VCARD block. */
export function parseVCards(raw: string): ParsedVCard[] {
  const lines = unfoldLines(raw);
  const cards: ParsedVCard[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    if (upper === "BEGIN:VCARD") {
      current = [];
      continue;
    }
    if (upper === "END:VCARD") {
      if (current) {
        cards.push(parseVCardLines(current));
      }
      current = null;
      continue;
    }
    if (current) {
      current.push(line);
    }
  }
  return cards;
}

/** CATEGORIES parsed out of rawProperties, kept separate from ParsedVCard's
 *  core fields since group membership is a distinct concern (see index.ts). */
export function categoriesOf(card: ParsedVCard): string[] {
  const prop = card.rawProperties.find((p) => p.name === "CATEGORIES");
  if (!prop) {
    return [];
  }
  return splitList(prop.value).filter(Boolean);
}
