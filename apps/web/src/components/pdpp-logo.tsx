import type { CSSProperties } from "react";

/**
 * PDPP logo — the split-P.
 *
 * Geometry from the handoff bundle (identity/logo_study.html):
 * - 200×200 viewBox, 5-unit construction grid
 * - Warm (human/copper) left half, cool (protocol/blue) right half
 * - Seam on the optical vertical at x=105
 * - Counter r=18 centered at (105, 73)
 *
 * Below the "simplify threshold" (default 20px) the P silhouette becomes
 * illegible, so the mark reduces to its irreducible idea: two rectangles,
 * one warm, one cool. See plate IV in the study.
 */

const HUMAN = "oklch(0.52 0.11 45)";
const PROTOCOL = "oklch(0.58 0.18 253)";
const HUMAN_NIGHT = "oklch(0.72 0.12 45)";
const PROTOCOL_NIGHT = "oklch(0.74 0.16 253)";
const COUNTER_LIGHT = "oklch(0.985 0.005 85)";
const COUNTER_NIGHT = "oklch(0.16 0.01 60)";

type Variant = "mark" | "favicon";
type Surface = "light" | "dark";

interface PdppLogoProps {
  className?: string;
  /** Threshold below which the full mark collapses to the favicon form (px). */
  simplifyAt?: number;
  /** Pixel size of the mark. Mark auto-downgrades to favicon below `simplifyAt`. */
  size?: number;
  style?: CSSProperties;
  /** Light surface uses standard hues; dark uses the elevated "night" pair. */
  surface?: Surface;
  /** Label the logo for AT. Pass "" to mark as decorative. */
  title?: string;
  /** mark = full split-P, favicon = simplified two-rect */
  variant?: Variant;
}

export function PdppLogo({
  variant = "mark",
  size = 24,
  simplifyAt = 20,
  surface = "light",
  title = "PDPP",
  className,
  style,
}: PdppLogoProps) {
  // Auto-downgrade the full mark to the favicon form at small sizes.
  const effective: Variant = variant === "mark" && size <= simplifyAt ? "favicon" : variant;

  if (effective === "favicon") {
    return <FaviconMark className={className} size={size} style={style} surface={surface} title={title} />;
  }

  return <Mark className={className} size={size} style={style} surface={surface} title={title} />;
}

// ─── The full split-P (plate I.1 / I.2) ───────────────────────────────────────

interface MarkProps {
  className?: string;
  size: number;
  style?: CSSProperties;
  surface: Surface;
  title: string;
}

function Mark({ size, surface, title, className, style }: MarkProps) {
  const warm = surface === "dark" ? HUMAN_NIGHT : HUMAN;
  const cool = surface === "dark" ? PROTOCOL_NIGHT : PROTOCOL;
  const counter = surface === "dark" ? COUNTER_NIGHT : COUNTER_LIGHT;
  const labelled = title.length > 0;

  return (
    <svg
      aria-hidden={labelled ? undefined : true}
      aria-label={labelled ? title : undefined}
      className={className}
      height={size}
      role={labelled ? "img" : "presentation"}
      style={style}
      viewBox="0 0 200 200"
      width={size}
    >
      {/* Left half — warm (human/holder) */}
      <path d="M 40 30 L 40 170 L 60 170 L 60 116 L 100 116 Q 105 116 105 110 L 105 30 Z" fill={warm} />
      {/* Right half — cool (protocol/issuer) */}
      <path
        d="M 105 30 L 105 110 Q 105 116 100 116 L 60 116 L 60 170 L 80 170 L 80 136 L 125 136 Q 155 136 155 103 Q 155 30 105 30 Z"
        fill={cool}
      />
      {/* Counter — r=18 (9% of mark width), optically centered in the upper bowl */}
      <circle cx="105" cy="73" fill={counter} r="18" />
    </svg>
  );
}

// ─── Irreducible two-rect form (plate IV, ≤20px) ──────────────────────────────

function FaviconMark({ size, surface, title, className, style }: MarkProps) {
  const warm = surface === "dark" ? HUMAN_NIGHT : HUMAN;
  const cool = surface === "dark" ? PROTOCOL_NIGHT : PROTOCOL;
  const labelled = title.length > 0;

  return (
    <svg
      aria-hidden={labelled ? undefined : true}
      aria-label={labelled ? title : undefined}
      className={className}
      height={size}
      role={labelled ? "img" : "presentation"}
      style={style}
      viewBox="0 0 32 32"
      width={size}
    >
      <rect fill={warm} height="24" width="12" x="4" y="4" />
      <rect fill={cool} height="24" width="12" x="16" y="4" />
    </svg>
  );
}
