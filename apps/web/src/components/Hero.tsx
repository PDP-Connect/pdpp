import type { ReactNode } from "react";

/**
 * PDPP canonical hero component.
 *
 * Two layout modes and three gradient variants, composed independently.
 *
 * - `layout="cross"` renders the signature cross-quadrant pattern: a blank
 *   left column sized to `--pdpp-sidebar-width`, and a hero content column
 *   with a copper vertical border. Used by pages that have (or visually
 *   relate to) a sidebar at the same x coordinate — `/design`, `/`.
 * - `layout="bleeding"` renders a single-column hero that bleeds its copper
 *   left border into the surrounding gutter. Used inside framework-driven
 *   content areas where there is no true cross — currently `/docs` uses a
 *   CSS-only version of this in `docs.css`, sharing the same tokens.
 *
 * Gradient variants:
 * - `warm`: copper wash flows right from the border. The canonical treatment.
 * - `cool`: primary-blue wash flows left from the border.
 * - `dual`: both gradients meet at the border. The "human meets protocol"
 *   treatment, reserved for the landing page hero.
 */
type HeroLayout = "cross" | "bleeding";
type HeroGradient = "warm" | "cool" | "dual";
type HeroSize = "compact" | "splash";

interface HeroProps {
  actions?: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  gradient?: HeroGradient;
  layout?: HeroLayout;
  /** `compact` (default): page-header scale, tight vertical padding.
      `splash`: landing-hero scale, 112px vertical padding, 60px title. */
  size?: HeroSize;
  title: ReactNode;
}

const warmWash = "linear-gradient(to right, var(--human-wash), transparent 60%)";
const coolWash = "linear-gradient(to left, var(--primary-wash), transparent 60%)";

function titleMarginBottom({ description, isSplash }: { description: boolean; isSplash: boolean }): string | number {
  if (!description) {
    return 0;
  }
  return isSplash ? "1.5rem" : "0.75rem";
}

function gradientForRightQuadrant(g: HeroGradient): string {
  return g === "cool" ? "transparent" : warmWash;
}

function gradientForLeftQuadrant(g: HeroGradient): string {
  return g === "warm" ? "transparent" : coolWash;
}

export function Hero({
  layout = "cross",
  gradient = "warm",
  size = "compact",
  eyebrow,
  title,
  description,
  actions,
}: HeroProps) {
  if (layout === "cross") {
    return (
      <>
        {/* Desktop: cross-quadrant — blank left + gradient right */}
        <div className="hidden md:flex">
          <div
            className="shrink-0"
            style={{
              width: "var(--pdpp-sidebar-width)",
              background: gradientForLeftQuadrant(gradient),
              borderBottom: "1px solid var(--border)",
            }}
          />
          <div
            className="flex-1"
            style={{
              borderLeft: "1px solid var(--human)",
              borderBottom: "1px solid var(--border)",
              background: gradientForRightQuadrant(gradient),
            }}
          >
            <HeroContent size={size} eyebrow={eyebrow} title={title} description={description} actions={actions} />
          </div>
        </div>

        {/* Mobile: single column, no cross, retains copper border */}
        <div
          className="md:hidden"
          style={{
            borderLeft: "1px solid var(--human)",
            borderBottom: "1px solid var(--border)",
            background: gradientForRightQuadrant(gradient),
          }}
        >
          <HeroContent size={size} eyebrow={eyebrow} title={title} description={description} actions={actions} />
        </div>
      </>
    );
  }

  // layout === 'bleeding' — single column with copper left border
  return (
    <div
      style={{
        borderLeft: "1px solid var(--human)",
        borderBottom: "1px solid var(--border)",
        background: gradientForRightQuadrant(gradient),
      }}
    >
      <HeroContent size={size} eyebrow={eyebrow} title={title} description={description} actions={actions} />
    </div>
  );
}

function HeroContent({
  size,
  eyebrow,
  title,
  description,
  actions,
}: {
  size: HeroSize;
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  const isSplash = size === "splash";
  const padding = isSplash ? "px-5 md:px-12 pt-20 pb-16 md:pt-28 md:pb-24" : "px-5 md:px-12 py-10";
  const titleClass = isSplash ? "pdpp-display-lg" : "pdpp-display";
  const descClass = isSplash ? "pdpp-body-lg" : "pdpp-body";

  return (
    <div className={`${padding} max-w-3xl`}>
      {eyebrow && <div className={isSplash ? "mb-8" : "pdpp-eyebrow"}>{eyebrow}</div>}
      <h1
        className={titleClass}
        style={{
          marginTop: eyebrow && !isSplash ? "0.5rem" : 0,
          marginBottom: titleMarginBottom({ description: Boolean(description), isSplash }),
        }}
      >
        {title}
      </h1>
      {description && (
        <div className={descClass} style={{ maxWidth: "52ch", color: "var(--muted-foreground)" }}>
          {description}
        </div>
      )}
      {actions && <div className={`flex flex-wrap gap-3 ${isSplash ? "mt-10" : "mt-5"}`}>{actions}</div>}
    </div>
  );
}
