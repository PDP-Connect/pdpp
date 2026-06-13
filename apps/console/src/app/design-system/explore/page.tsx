/**
 * /design-system/explore — Ink Carbon Explore showcase.
 *
 * Renders the live ExploreCanvas presentation with a SEEDED RecordsExplorerData
 * fixture so the 3-column reading room (facet rail · feed · record inspector),
 * the search grammar, the chip bar, the compiled-call line, the grant-lens
 * "Stays with you" rail, and the derived relationship rail can all be reviewed
 * by screenshot WITHOUT a live AS/RS.
 *
 * Sibling of /design-system and /design-system/shell — a top-level ungated
 * route, deliberately OUTSIDE /dashboard so the connector-redirect catch-all and
 * the owner-session DAL gate do not apply. The real /dashboard/explore page
 * uses the identical component, fed by the live assembler.
 *
 * NOTE for reviewers: interactions in this showcase navigate the URL (the
 * canvas drives server state through the URL), but there is no server here to
 * re-assemble — so the seeded initial state is the screenshot target. To see
 * the live, fully reactive view, open /dashboard/explore against a running
 * reference server.
 */

import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import type { Metadata } from "next";
import { ExploreCanvas } from "../../dashboard/explore/explore-canvas.tsx";
import { EXPLORE_SHOWCASE_DATA, EXPLORE_SHOWCASE_RELATIONSHIPS } from "./explore-fixture.ts";

// Only the explore base PATH crosses into the client component (a plain
// string) — never the function-bearing Routes object.
const EXPLORE_PATH = dashboardRoutes.section.explore;

export const metadata: Metadata = {
  title: "Ink Carbon — Explore showcase",
  robots: { index: false, follow: false },
};

export default function ExploreShowcase() {
  return (
    <div
      className="dark"
      data-theme="dark"
      style={{ minHeight: "100vh", background: "var(--surface-page)", padding: "28px" }}
    >
      <ExploreCanvas
        data={EXPLORE_SHOWCASE_DATA}
        explorePath={EXPLORE_PATH}
        order="newest"
        peekRelationships={EXPLORE_SHOWCASE_RELATIONSHIPS}
      />
    </div>
  );
}
