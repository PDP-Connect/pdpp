import { PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import type { Metadata } from "next";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { WebPushSettings } from "@/app/(console)/components/web-push-settings.tsx";
import { ServerUnreachable } from "../components/shell.tsx";
import { ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import { getWebPushConfig, listWebPushSubscriptions } from "../lib/ref-client.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Notifications",
};

async function loadNotificationState() {
  const [config, subscriptions] = await Promise.all([getWebPushConfig(), listWebPushSubscriptions()]);
  return { config, subscriptions: subscriptions.data };
}

export default async function NotificationsPage() {
  let state: Awaited<ReturnType<typeof loadNotificationState>> | null = null;
  let unreachable = false;

  try {
    state = await loadNotificationState();
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      unreachable = true;
    } else {
      throw err;
    }
  }

  if (unreachable || !state) {
    return (
      <RecordroomShellWithPalette>
        <ServerUnreachable />
      </RecordroomShellWithPalette>
    );
  }

  return (
    <RecordroomShellWithPalette>
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <PageHeader
          description="Enable owner-action alerts for the browser profile or installed app you are using right now. Each device is configured separately."
          title="Notifications"
        />

        <WebPushSettings config={state.config} subscriptions={state.subscriptions} />

        <Section title="What PDPP sends">
          <div className="grid gap-3 text-muted-foreground text-sm md:grid-cols-3">
            <p>
              <strong className="text-foreground">Only owner-action alerts.</strong> Notifications are for source
              reconnects, syncs waiting on you, and other events where this instance needs your attention.
            </p>
            <p>
              <strong className="text-foreground">No record content.</strong> Notification payloads stay non-secret and
              route you back to the owner-authenticated console for details.
            </p>
            <p>
              <strong className="text-foreground">Per device.</strong> Installing the PWA adds an app icon; it does not
              subscribe this browser until you enable this device here.
            </p>
          </div>
        </Section>
      </main>
    </RecordroomShellWithPalette>
  );
}
