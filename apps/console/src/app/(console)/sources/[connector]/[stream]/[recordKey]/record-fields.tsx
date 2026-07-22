// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Readable field/value rendering for a single record's payload.
 *
 * The record detail page previously showed only the raw JSON envelope, which
 * (a) read as an empty page when a payload field was `null` and (b) rendered
 * declared-currency minor-unit integers as raw numbers (chase `amount: 3000`
 * instead of `$30.00`). This component renders the payload as a field/value
 * table — reusing the same `<dl>` grid idiom the stream list's mobile card uses
 * — formatting declared-currency fields as money and marking nulls explicitly.
 * The raw JSON stays available below for debugging.
 *
 * The display logic lives in `record-fields-display.ts` so it is unit-tested as
 * pure functions; this file is the thin JSX layer.
 */
import { deriveDeclaredFieldTypes } from "@pdpp/operator-ui/lib/record-field-format";
import { Fragment } from "react";
import type { StreamMetadata } from "../../../../lib/rs-client.ts";
import { ROW_DT, renderValue, valueClassName } from "./record-fields-display.ts";

export function RecordFields({ data, metadata }: { data: Record<string, unknown>; metadata: StreamMetadata | null }) {
  const keys = Object.keys(data);
  if (keys.length === 0) {
    return <p className="pdpp-caption text-muted-foreground italic">This record has no fields.</p>;
  }
  const declaredTypes = deriveDeclaredFieldTypes(metadata);
  return (
    <dl className="grid grid-cols-[minmax(0,12rem)_1fr] gap-x-4 gap-y-2 rounded-md border border-border/80 bg-muted/20 p-4">
      {keys.map((key) => {
        const rendered = renderValue(data[key], declaredTypes[key]);
        return (
          <Fragment key={key}>
            <dt className={ROW_DT}>{key}</dt>
            <dd className={valueClassName(rendered)} title={rendered.empty ? undefined : rendered.text}>
              {rendered.text}
            </dd>
          </Fragment>
        );
      })}
    </dl>
  );
}
