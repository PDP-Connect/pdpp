// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ComponentPropsWithoutRef } from "react";

// Wide tables (error-code tables in the spec, the membership/conformance tables
// in the governance document) overflow the measure on a narrow viewport. The
// scroll container keeps the overflow inside the table rather than letting the
// page itself scroll sideways — see .pdpp-docs-table-scroll in specification.css.
//
// Extracted here rather than defined per route so the specification and
// governance pages cannot drift into two different table behaviours.
export function ResponsiveSpecTable({ children, ...props }: ComponentPropsWithoutRef<"table">) {
  return (
    <div className="pdpp-docs-table-scroll">
      <table {...props}>{children}</table>
    </div>
  );
}
