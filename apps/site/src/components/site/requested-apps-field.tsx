// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Text } from "@/components/typography/text.tsx";
import { MAX_REQUESTED_APP_LENGTH, MAX_REQUESTED_APPS } from "@/lib/signing/requested-app-limits.ts";
import { cn } from "@/lib/utils.ts";

const HINT_ID = "sign-apps-hint";

const textActionClassName = cn(
  "inline-flex w-fit cursor-pointer items-center gap-1 font-medium font-sans text-[14px] text-primary",
  "hover:text-primary-emphasis hover:underline hover:underline-offset-[3px]"
);
const removeClassName = cn(
  "flex size-9 shrink-0 cursor-pointer items-center justify-center text-muted-foreground",
  "hover:text-foreground focus-visible:text-foreground"
);

interface Row {
  id: number;
  initial?: string;
}

function initialRows(restored: string[] | undefined): Row[] {
  const values = (restored ?? []).slice(0, MAX_REQUESTED_APPS);
  return values.length > 0 ? values.map((initial, id) => ({ id, initial })) : [{ id: 0 }];
}

/**
 * One box to start, and "Add another app" for more, up to MAX_REQUESTED_APPS.
 * Every box posts as `requested_apps`; the server drops blanks and repeats.
 */
export function RequestedAppsField({
  className,
  fieldClassName,
  restored,
}: {
  className?: string;
  fieldClassName: string;
  restored?: string[];
}) {
  const [rows, setRows] = useState<Row[]>(() => initialRows(restored));
  const nextId = useRef(rows.length);
  const focusId = useRef<number | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const inputs = useRef(new Map<number, HTMLInputElement>());

  useEffect(() => {
    if (focusId.current !== null) {
      inputs.current.get(focusId.current)?.focus();
      focusId.current = null;
    }
  });

  function addRow() {
    const id = nextId.current;
    nextId.current += 1;
    focusId.current = id;
    setRows((current) => [...current, { id }]);
  }

  function removeRow(id: number) {
    setRows((current) => current.filter((row) => row.id !== id));
    addButton.current?.focus();
  }

  const canAdd = rows.length < MAX_REQUESTED_APPS;

  return (
    <fieldset className={cn("m-0 flex flex-col gap-1.5 border-0 p-0", className)}>
      <Text as="legend" color="subtle" size="stamp">
        Which apps would you like to see join PDPP?
      </Text>
      <Text as="p" color="muted" id={HINT_ID} size="small">
        Optional. We count how many supporters name each app and may tell a company its number. We never give it your
        name or email.
      </Text>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {rows.map((row, index) => (
          <li className="flex items-center gap-1" key={row.id}>
            <input
              aria-describedby={HINT_ID}
              aria-label={`App ${index + 1}`}
              autoComplete="off"
              className={cn(fieldClassName, "md:max-w-[24rem]")}
              defaultValue={row.initial}
              maxLength={MAX_REQUESTED_APP_LENGTH}
              name="requested_apps"
              ref={(element) => {
                if (element) {
                  inputs.current.set(row.id, element);
                } else {
                  inputs.current.delete(row.id);
                }
              }}
              type="text"
            />
            {rows.length > 1 ? (
              <button
                aria-label={`Remove app ${index + 1}`}
                className={removeClassName}
                onClick={() => removeRow(row.id)}
                type="button"
              >
                <X aria-hidden="true" className="size-4" />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {canAdd ? (
        <button className={cn(textActionClassName, "mt-1")} onClick={addRow} ref={addButton} type="button">
          <Plus aria-hidden="true" className="size-4" />
          Add another app
        </button>
      ) : (
        <Text as="p" color="muted" size="small">
          You can name up to {MAX_REQUESTED_APPS} apps.
        </Text>
      )}
    </fieldset>
  );
}
