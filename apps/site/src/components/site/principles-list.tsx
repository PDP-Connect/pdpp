// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { PRINCIPLES_LIST } from "@/generated/spec-front-matter.ts";
import { cn } from "@/lib/utils.ts";
import { Text } from "../typography/text.tsx";

// The six principles, rendered from PRINCIPLES.md via the generated module.
// Nothing here retypes them: that document is what people sign, and a second
// copy in site source is a second thing that has to stay true.
//
// The numerals ARE content here, not section ordinals. The copy rule that
// strips "01"/"02" from section headings does not reach them: the Principles
// are a numbered list in the signed document, and a Supporter who signed
// "principle 4" needs 4 to still be 4.
//
// `body` is optional on the type because a principle whose text moved onto the
// following line would otherwise render an empty paragraph rather than fail;
// the generator already throws unless exactly six parse, so this is belt and
// braces for shape, not for count.

export function PdppPrinciplesList({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <ol className={cn("m-0 grid list-none grid-cols-1 gap-px p-0 md:grid-cols-2", className)}>
      {PRINCIPLES_LIST.map((principle, index) => (
        <li
          className={cn(
            "m-0 flex flex-col gap-2 bg-background p-5",
            // Hairline per card rather than a grid rule, so an odd wrap at the
            // last row leaves no dangling border.
            "shadow-[0_0_0_1px_var(--border)]"
          )}
          key={principle.title}
        >
          <div className="flex items-baseline gap-3">
            <Text as="span" className="tabular-nums" color="primary" family="mono" inline size="stamp">
              {String(index + 1).padStart(2, "0")}
            </Text>
            <Text as="h3" size={compact ? "body" : "lede"} weight="semi">
              {principle.title}.
            </Text>
          </div>
          {principle.body && (
            <Text as="p" color="muted" size={compact ? "small" : "body"} wrap="pretty">
              {principle.body}
            </Text>
          )}
        </li>
      ))}
    </ol>
  );
}
