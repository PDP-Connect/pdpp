/**
 * Select — Ink Carbon form primitive.
 *
 * IcSelect: a styled dropdown. Mono voice (protocol data entry), matching
 * IcInput's geometry and temperature — radius-control, hairline --border,
 * --card background, --primary/--ring focus.
 *
 * It is a real native <select> under the hood (full keyboard a11y + native
 * form submission); only the chrome is restyled. The disclosure glyph is a
 * typographic caret painted by the wrapper's `::after`, NOT a lucide icon,
 * so it inherits the surface temperature and never imports an icon set.
 *
 * API mirrors IcInput: forwardRef, accepts `options` OR `<option>` children,
 * and the usual value/defaultValue/onChange/name form props pass straight
 * through to the underlying <select>.
 *
 * Prefixed `Ic` to avoid collision with operator-ui imports during migration.
 */
import { forwardRef, type ReactNode, type SelectHTMLAttributes } from "react";
import "./components.css";

export interface IcSelectOption {
  disabled?: boolean;
  label: string;
  value: string;
}

export interface IcSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  className?: string;
  /** Provide options declaratively; or pass <option> children instead. */
  options?: readonly IcSelectOption[];
  /** Width passthrough for the wrapper so callers can size the control. */
  wrapperClassName?: string;
}

const IcSelect = forwardRef<HTMLSelectElement, IcSelectProps>(
  ({ className, wrapperClassName, options, children, style, ...props }, ref) => {
    // The wrapper carries the layout/width the caller passes via `style`, so
    // the caret pseudo-element stays pinned to the control's right edge.
    const optionNodes: ReactNode = options
      ? options.map((opt) => (
          <option disabled={opt.disabled} key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))
      : children;
    return (
      <span className={["pdpp-select", wrapperClassName].filter(Boolean).join(" ")} style={style}>
        <select className={["pdpp-select__el", className].filter(Boolean).join(" ")} ref={ref} {...props}>
          {optionNodes}
        </select>
      </span>
    );
  }
);
IcSelect.displayName = "IcSelect";

export { IcSelect };
