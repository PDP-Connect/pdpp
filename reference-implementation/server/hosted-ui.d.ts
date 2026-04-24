/**
 * Ambient declarations for the hosted-ui helpers.
 *
 * The implementation is still JS (`hosted-ui.js`) and will migrate to TS in
 * a later slice. Until then, consuming TS modules need explicit parameter
 * types — TypeScript's inference on JS destructuring defaults leaves the
 * non-default params as `any` but doesn't expose them on the parameter
 * object type (especially under `exactOptionalPropertyTypes`).
 *
 * Keep this file in lockstep with hosted-ui.js until that migration lands.
 */

export const HOSTED_UI_CSS_PATH: string;
export const HOSTED_UI_BRAND_MARKER: string;
export const HOSTED_UI_CSS: string;

export function escapeHtml(input: unknown): string;

export interface PdppMarkOptions {
  size?: number;
  title?: string;
}

export function renderPdppMark(options?: PdppMarkOptions): string;

export interface HostedDocumentOptions {
  body: string;
  providerName: string;
  title: string;
}

export function renderHostedDocument(options: HostedDocumentOptions): string;

export interface PageIntroOptions {
  eyebrow?: string;
  lede?: string;
  title?: string;
}

export function renderPageIntro(options?: PageIntroOptions): string;

export interface SurfaceOptions {
  ariaLabel?: string;
  children?: string;
  surface?: "human" | "protocol" | "neutral";
}

export function renderSurface(options?: SurfaceOptions): string;

export interface KeyValueListItem {
  html?: string;
  label: string;
  value?: string | number | null;
}

export function renderKeyValueList(items: readonly KeyValueListItem[]): string;

export interface ActionHiddenField {
  name: string;
  value?: string | number | null;
}

export interface ActionRowItem {
  action?: string;
  form?: string;
  hidden?: readonly ActionHiddenField[];
  href?: string;
  label: string;
  method?: string;
  variant?: "primary" | "default" | "danger";
}

export function renderActionRow(actions: readonly ActionRowItem[]): string;

export interface ResultStateOptions {
  body?: string;
  footnote?: string;
  glyph?: string;
  title?: string;
  tone?: "success" | "neutral" | "danger";
}

export function renderResultState(options?: ResultStateOptions): string;
