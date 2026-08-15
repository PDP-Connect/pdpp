// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants } from "@pdpp/brand-react";
import { PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ServerUnreachable } from "../../components/server-unreachable.tsx";
import { ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import { getProviderAppConfig, type ProviderAppConfigGroup } from "../../lib/ref-client.ts";
import { setProviderAppConfigAction } from "./actions.ts";
import { GroupForm } from "./group-form.tsx";

export const dynamic = "force-dynamic";

interface PageParams {
  error?: string;
  notice?: string;
}

function InlineError({ message }: { message: string }) {
  return (
    <div className="pdpp-caption mb-6 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-destructive">
      {message}
    </div>
  );
}

function InlineNotice({ message }: { message: string }) {
  return (
    <div className="pdpp-caption mb-6 rounded-md border border-border bg-muted/40 px-4 py-2.5 text-foreground">
      {message}
    </div>
  );
}

export default async function ProviderAppConfigPage({ searchParams }: { searchParams: Promise<PageParams> }) {
  const params = await searchParams;

  let groups: ProviderAppConfigGroup[] = [];
  try {
    ({ groups } = await getProviderAppConfig());
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShellWithPalette>
          <PageHeader title="Provider authorization" />
          <ServerUnreachable />
        </RecordroomShellWithPalette>
      );
    }
    throw err;
  }

  return (
    <RecordroomShellWithPalette>
      <PageHeader
        actions={
          <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href="/deployment">
            Deployment overview
          </Link>
        }
        breadcrumbs={[{ href: "/deployment", label: "Deployment" }, { label: "Provider authorization" }]}
        description="Credentials that let this PDPP instance start a provider's consent flow on the owner's behalf. Values are encrypted at rest and never displayed again once saved."
        title="Set up provider access"
      />

      {params.error ? <InlineError message={params.error} /> : null}
      {params.notice === "saved" ? <InlineNotice message="Saved." /> : null}

      {groups.length === 0 ? (
        <Section
          description="No connector on this deployment currently needs a shared provider credential."
          title="Nothing to configure"
        >
          <p className="pdpp-caption text-muted-foreground">
            This page lists a form per credential once a registered connector requires one.
          </p>
        </Section>
      ) : (
        <div className="grid gap-6">
          {groups.map((group) => (
            <GroupForm action={setProviderAppConfigAction} group={group} key={group.identity_group} />
          ))}
        </div>
      )}
    </RecordroomShellWithPalette>
  );
}
