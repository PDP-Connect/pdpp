// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ConnectorIcon — a generic render of a manifest-declared connector icon.
 *
 * This component has ZERO knowledge of any specific connector. It renders
 * exactly what its `icon` prop carries (an `inline_svg` manifest declaration
 * — see `server/connector-manifest-validation.ts`'s `validateManifestIcon`)
 * and falls back to the shared Monogram primitive (a deterministic
 * initial+color derived from `name`) when `icon` is absent. There is no
 * connector-id -> icon map here or anywhere else in the console: every
 * caller passes the manifest value it already has, and a connector this
 * component has never heard of renders exactly as well as one it has.
 *
 * The no-icon state (Monogram) is a first-class, good-looking default — most
 * connectors will not declare an icon, so this is the common case, not a
 * degraded fallback.
 */
import type { CSSProperties } from "react";
import { Monogram } from "./data-row.tsx";
import "./connector-icon.css";

export interface ConnectorIconLike {
  readonly color?: string | null;
  readonly kind?: string | null;
  readonly svg?: string | null;
}

interface ConnectorIconProps {
  className?: string;
  /** Manifest-declared icon, or undefined/null for the Monogram fallback. */
  icon?: ConnectorIconLike | null;
  /** Owner-facing connector name — drives the Monogram fallback's initials and color. */
  name: string;
}

function isRenderableInlineSvgIcon(icon: ConnectorIconLike): icon is ConnectorIconLike & { svg: string } {
  return icon.kind === "inline_svg" && typeof icon.svg === "string" && icon.svg.trim().length > 0;
}

export function ConnectorIcon({ icon, name, className }: ConnectorIconProps) {
  if (icon && isRenderableInlineSvgIcon(icon)) {
    const cls = ["pdpp-connector-icon", className].filter(Boolean).join(" ");
    return (
      <span
        aria-hidden="true"
        className={cls}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: manifest icon.svg is validated server-side (validateManifestIcon) to be a bare, script-free, event-handler-free <svg> element before it ever reaches this component.
        dangerouslySetInnerHTML={{ __html: icon.svg }}
        style={icon.color ? ({ color: icon.color } as CSSProperties) : undefined}
      />
    );
  }
  return <Monogram className={className} name={name} tinted />;
}
