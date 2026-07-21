// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

/**
 * Select — Ink Carbon form primitive.
 *
 * IcSelect: a fully styled headless dropdown built on @base-ui/react's Select.
 * base-ui owns: keyboard navigation, type-ahead, ARIA listbox role, focus
 * management, portal mounting, and form submission via a hidden <input name>.
 * This module owns ONLY the Ink Carbon styling via .pdpp-select-* classes and
 * base-ui's data-* state attributes.
 *
 * This is the SLVP-ideal upgrade from the native <select> predecessor: the
 * popup is now a real DOM element fully styled in Ink Carbon (radius 0,
 * hairline --border-strong, --card bg, menu shadow, mono items, --primary
 * accent on selected) — something OS-rendered option lists can never deliver.
 *
 * API is intentionally close to the old IcSelect:
 *   - `name`        → forwarded to Select.Root (renders a hidden <input> for
 *                      form submission; no caller change needed for GET forms).
 *   - `value`       → controlled selected value (string).
 *   - `defaultValue`→ uncontrolled initial value (string).
 *   - `onValueChange` → called when the user picks a new item.
 *   - `options`     → declarative option list (IcSelectOption[]).
 *   - `id`          → forwarded to the trigger button.
 *   - `disabled`    → forwarded to Select.Root.
 *   - `style`       → forwarded to the outer wrapper (for width etc.).
 *   - `wrapperClassName` → extra class on the outer <span>.
 *   - `className`   → extra class on the trigger button.
 *   - `aria-label`  → forwarded to the trigger button.
 *
 * Form submission: base-ui Select.Root's `name` prop renders a hidden
 * <input type="hidden" name={name} value={selectedValue}> that participates in
 * standard HTML form submission (GET and POST alike). No extra wiring needed.
 *
 * Prefixed `Ic` to avoid collision with operator-ui imports during migration.
 */
import { Select as SelectPrimitive } from "@base-ui/react/select";
import type { CSSProperties } from "react";
import "./components.css";

export interface IcSelectOption {
  disabled?: boolean;
  label: string;
  value: string;
}

export interface IcSelectProps {
  /** aria-label forwarded to the trigger <button>. */
  "aria-label"?: string | undefined;
  /** Extra class on the trigger <button>. */
  className?: string | undefined;
  /** Uncontrolled initial value. */
  defaultValue?: string | null | undefined;
  /** Whether the select is disabled. */
  disabled?: boolean | undefined;
  /** id forwarded to the trigger <button> for <label htmlFor> wiring. */
  id?: string | undefined;
  /** Identifies the field in form submission (base-ui renders a hidden input). */
  name?: string | undefined;
  /** Called when the user picks a new item. */
  onValueChange?: ((value: string | null) => void) | undefined;
  /** Option list. The new required way to provide options (replaces <option> children). */
  options: readonly IcSelectOption[];
  /** Placeholder shown in the trigger when no value is selected. */
  placeholder?: string | undefined;
  /** Style forwarded to the outer wrapper (use for width/flex sizing). */
  style?: CSSProperties | undefined;
  /** Controlled selected value. */
  value?: string | null | undefined;
  /** Extra class on the outer wrapper <span>. */
  wrapperClassName?: string | undefined;
}

/**
 * IcSelect: Ink Carbon styled Select built on @base-ui/react Select.
 *
 * Renders: wrapper > trigger (button + caret) > portal > positioner > popup > list > items.
 * base-ui handles all interaction; we layer .pdpp-select-* classes on top.
 */
function IcSelect({
  options,
  name,
  value,
  defaultValue,
  onValueChange,
  disabled,
  id,
  "aria-label": ariaLabel,
  wrapperClassName,
  className,
  style,
  placeholder,
}: IcSelectProps) {
  return (
    <SelectPrimitive.Root
      defaultValue={defaultValue ?? undefined}
      disabled={disabled}
      name={name}
      onValueChange={onValueChange}
      value={value ?? undefined}
    >
      {/* Wrapper: positions the caret ::after pseudo-element at the right edge. */}
      <span className={["pdpp-select", wrapperClassName].filter(Boolean).join(" ")} style={style}>
        <SelectPrimitive.Trigger
          aria-label={ariaLabel}
          className={["pdpp-select__trigger", className].filter(Boolean).join(" ")}
          id={id}
        >
          <SelectPrimitive.Value placeholder={placeholder ?? "—"} />
        </SelectPrimitive.Trigger>
      </span>

      {/* Portal + positioner: base-ui mounts this outside the DOM tree. */}
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner className="pdpp-select-positioner" sideOffset={2}>
          <SelectPrimitive.Popup className="pdpp-select-popup">
            <SelectPrimitive.List className="pdpp-select-list">
              {options.map((opt) => (
                <SelectPrimitive.Item
                  className="pdpp-select-item"
                  disabled={opt.disabled}
                  key={opt.value}
                  value={opt.value}
                >
                  <SelectPrimitive.ItemText>{opt.label}</SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator className="pdpp-select-item-indicator">
                    ✓
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
IcSelect.displayName = "IcSelect";

export { IcSelect };
