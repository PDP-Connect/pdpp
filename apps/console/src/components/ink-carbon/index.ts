/**
 * Ink Carbon — component library index.
 *
 * Import from this barrel for all Ink Carbon primitives:
 *   import { Sheet, SheetHead, SheetTitle, Carbon, Endorse, IcButton }
 *     from "@/components/ink-carbon";
 *
 * CSS is imported per-component — no top-level CSS side-effect here.
 */

// ─── Band ─────────────────────────────────────────────────────────
export { Band, BandCell } from "./band.tsx";
export type { IcButtonProps } from "./button.tsx";
// ─── Button ───────────────────────────────────────────────────────
export { buttonVariants, IcButton } from "./button.tsx";
// ─── Carbon + Copyline ────────────────────────────────────────────
export { Carbon, Copyline } from "./carbon.tsx";
// ─── CopyMono (click-to-copy protocol id) ─────────────────────────
export { CopyMono } from "./copy-mono.tsx";
// ─── DataRow + Monogram ───────────────────────────────────────────
export {
  DataRow,
  DataRowDetail,
  DataRowMeta,
  DataRowWho,
  Monogram,
} from "./data-row.tsx";
// ─── Endorse (status badge — only home of state color) ────────────
export { Endorse } from "./endorse.tsx";
export type { IcInputProps } from "./input.tsx";
// ─── Input + Field ────────────────────────────────────────────────
export { IcField, IcInput } from "./input.tsx";
// ─── KV block ─────────────────────────────────────────────────────
export { KV, KVRow } from "./kv.tsx";
// ─── Record type system (pure functions) ──────────────────────────
export type {
  DeclaredFieldTypes,
  DisplayTitle,
  RecordKind,
  ResolvedFieldValue,
} from "./record-fields.ts";
export {
  displayTitle,
  findImageField,
  isImageVal,
  isLongVal,
  kindOf,
  labelFor,
  nounFor,
  prettify,
  resolveFieldValue,
} from "./record-fields.ts";
// ─── Record renderer (RecordBody — the one record renderer) ───────
export { RecordBody, RecordField } from "./record-render.tsx";
// ─── Rhythm sparkline ─────────────────────────────────────────────
export type { RhythmTick } from "./rhythm.tsx";
export { Rhythm } from "./rhythm.tsx";
// ─── Scope ───────────────────────────────────────────────────────
export { Scope } from "./scope.tsx";
// ─── Sheet ────────────────────────────────────────────────────────
export { Sheet, SheetBody, SheetFoot, SheetHead, SheetSerial, SheetTitle } from "./sheet.tsx";
// ─── Shell frame (RecordroomShell + nav data) ─────────────────────
export type { NavGroup, NavItem } from "./shell-frame.tsx";
export { isNavItemActive, NAV_GROUPS, NAV_ITEMS, RecordroomShell } from "./shell-frame.tsx";
// ─── Surface wrappers ─────────────────────────────────────────────
export { HumanSurface, ProtocolSurface } from "./surface.tsx";
// ─── Table ────────────────────────────────────────────────────────
export {
  Table,
  TableCell,
  TableHeader,
  TableHeaderRow,
  TableRow,
} from "./table.tsx";
// ─── Tag ──────────────────────────────────────────────────────────
export { Tag } from "./tag.tsx";
// ─── Type system ──────────────────────────────────────────────────
export {
  Body,
  BodyLg,
  Caption,
  Display,
  DisplayMd,
  Eyebrow,
  Heading,
  Label,
  Title,
  Typed,
  TypedSm,
} from "./type.tsx";
