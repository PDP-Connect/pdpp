// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { Text } from "@/components/typography/text.tsx";
import { cn } from "@/lib/utils.ts";

// The OAuth-versus-grant comparison, built as components rather than images.
//
// It is the one place on the site that shows the protocol's argument instead
// of stating it, so it has to be readable: an image would carry the same
// picture at one fixed size, in one theme, unselectable, unsearchable and
// invisible to a screen reader. Everything below is real text in real boxes.
//
// The two panels deliberately do NOT share a card component. They are showing
// two different things — a consent dialog and a record — and giving them one
// shell would flatten exactly the difference the section exists to make.

const OAUTH_SCOPES = [
  "Read all your sleep, activity and health data",
  "Read your profile, contacts and location history",
  "Keep access until you revoke it",
] as const;

const GRANT_ROWS: readonly (readonly [string, React.ReactNode])[] = [
  ["app", "Habit Coach"],
  ["source", "Sleep Tracker"],
  [
    "fields",
    <>
      <span className="text-primary">sleep_score</span>, <span className="text-primary">duration_min</span>
      <br />
      <span className="text-muted-foreground">not heart_rate, not location</span>
    </>,
  ],
  ["range", "1 Jun 2026 to 1 Sep 2026"],
  ["purpose", "personalisation"],
  ["expires", "1 Dec 2026"],
];

function TodayPanel() {
  return (
    <div className="flex flex-col gap-3">
      <Text as="p" color="subtle" family="mono" size="stamp">
        Today
      </Text>
      <div className="border border-border bg-background">
        <div className="flex items-center gap-2.5 border-border border-b px-4 py-3">
          <span
            aria-hidden="true"
            className="flex size-6 items-center justify-center bg-primary font-sans text-[13px] text-on-primary-emphasis"
          >
            S
          </span>
          <Text as="span" inline size="small" weight="semi">
            Sleep Tracker
          </Text>
        </div>
        <div className="flex flex-col gap-3 px-4 py-4">
          <Text as="p" size="body">
            <strong>Habit Coach</strong> wants to access your account
          </Text>
          <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5">
            {OAUTH_SCOPES.map((scope) => (
              <li key={scope}>
                <Text as="span" color="muted" inline size="small">
                  {scope}
                </Text>
              </li>
            ))}
          </ul>
          <div className="flex gap-2 pt-1">
            <span className="border border-primary bg-primary px-4 py-1.5 font-sans text-[13px] text-on-primary-emphasis">
              Allow
            </span>
            <span className="border border-border px-4 py-1.5 font-sans text-[13px] text-muted-foreground">Deny</span>
          </div>
        </div>
      </div>
      <Text as="p" color="muted" size="small" wrap="pretty">
        One button, everything the platform holds, for as long as the app wants. Nothing records what you agreed to, and
        turning it off means finding a settings page on someone else's site.
      </Text>
    </div>
  );
}

// The grant panel's header is the one constant-dark element in both themes, per
// the design: a record is an artifact, and it reads as one against the page
// rather than as another panel of it.
function GrantPanel() {
  return (
    <div className="flex flex-col gap-3">
      <Text as="p" color="subtle" family="mono" size="stamp">
        With PDPP
      </Text>
      <div className="border border-border bg-background">
        <div className="flex items-center justify-between bg-primary-emphasis px-4 py-3">
          <Text as="span" color="onAccent" family="mono" inline size="stamp">
            Grant
          </Text>
          <Text as="span" color="onAccent" family="mono" inline size="stamp">
            Active
          </Text>
        </div>
        <dl className="m-0 flex flex-col">
          {GRANT_ROWS.map(([key, value]) => (
            <div className="flex gap-4 border-border/60 border-b px-4 py-2.5 last:border-b-0" key={key}>
              <dt className="m-0 w-20 shrink-0">
                <Text as="span" color="subtle" family="mono" inline size="small">
                  {key}
                </Text>
              </dt>
              <dd className="m-0 min-w-0">
                <Text as="span" family="mono" inline size="small">
                  {value}
                </Text>
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <Text as="p" color="muted" size="small" wrap="pretty">
        Two fields, one purpose, three months, until a date you chose. It is recorded where you and the app can both see
        it, every request is checked against it, and ending it is one click. Ask for a third field, or a date outside
        the range, and the request is refused.
      </Text>
    </div>
  );
}

export function PdppWhatChanges({ className }: { className?: string }) {
  return (
    <div className={cn("grid grid-cols-1 gap-8 lg:grid-cols-2 lg:gap-10", className)}>
      <TodayPanel />
      <GrantPanel />
    </div>
  );
}
