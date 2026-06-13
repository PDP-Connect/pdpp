/**
 * /design-system/syncs — Ink Carbon SYNCS showcase.
 *
 * Renders the Syncs view (the Runs-route reskin) with a deterministic seeded
 * model inside the RecordroomShell, so the surface is screenshot-reviewable
 * without a live reference server or an owner session. The seed deliberately
 * includes BOTH honesty-critical failure cards:
 *   - a genuine credential block → a copper "Reconnect" owner-action card, and
 *   - a self-resolving source-pressure cooldown → a WAIT card with the
 *     next-attempt time and NO reconnect button (the live cooling-off bug
 *     class). Reviewing this page confirms a throttled connection is never told
 *     to "log in again".
 *
 * Sibling of /design-system — a top-level ungated route, deliberately OUTSIDE
 * /dashboard so the owner-session DAL gate and the connector-redirect catch-all
 * do not apply.
 */
import type { Metadata } from "next";
import { DEMO_SYNCS_MODEL } from "@/app/dashboard/runs/syncs-demo.ts";
import { SyncsView } from "@/app/dashboard/runs/syncs-view.tsx";
import { RecordroomShell } from "@/components/ink-carbon/index.ts";

export const metadata: Metadata = {
  title: "Ink Carbon — Syncs showcase",
  robots: { index: false, follow: false },
};

export default function SyncsShowcase() {
  return (
    <div className="dark" data-theme="dark" style={{ minHeight: "100vh" }}>
      <RecordroomShell build="pdpp 0.1.0" host="rs.owner.example.net">
        <SyncsView model={DEMO_SYNCS_MODEL} seeded />
      </RecordroomShell>
    </div>
  );
}
