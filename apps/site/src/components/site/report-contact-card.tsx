// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { Text } from "@/components/typography/text.tsx";
import { REPORTS_EMAIL_HREF } from "@/lib/site-config.ts";
import { cn } from "@/lib/utils.ts";

const CARD = cn("flex flex-col gap-3 bg-background p-6", "shadow-[0_0_0_1px_var(--border)]");

/** The shared public-email card used when a reader needs a human response. */
export function PdppEmailContactCard({ body, heading, title }: { body: string; heading: string; title: string }) {
  return (
    <div className={CARD}>
      <Text as="p" color="subtle" size="stamp">
        {heading}
      </Text>
      <Text as="h3" size="lede" weight="semi">
        {title}
      </Text>
      <Text as="p" color="muted" size="small" wrap="pretty">
        {body}
      </Text>
      <Text as="p" className="mt-auto pt-2" family="mono" size="small">
        <a className="text-primary hover:text-foreground" href={REPORTS_EMAIL_HREF}>
          pdpp-dev-reports@lfdecentralizedtrust.org →
        </a>
      </Text>
    </div>
  );
}
