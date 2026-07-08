import { parseRemoteSurfaceFormFieldRect, } from "../../protocol/index.js";
/**
 * CDP Runtime.evaluate expression for detecting editable field rectangles.
 *
 * This ports the RBS detector shape, but it is intentionally exported as a
 * plain string instead of being wired into the form-overlay core. Runtime
 * evaluation is fingerprintable on challenge-sensitive pages; strict-stealth
 * hosts should inject a different FieldDetectionSource.
 */
export const CDP_FORM_FIELD_DETECTION_EXPRESSION = `
(() => {
  const inputs = document.querySelectorAll('input, textarea, select, [contenteditable="true"]');
  const results = [];
  for (const el of inputs) {
    if (el.offsetParent === null && !el.matches(':focus')) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const tagName = el.tagName.toLowerCase();
    const editable = el.matches('[contenteditable="true"]');
    results.push({
      tag: editable ? 'contenteditable' : tagName,
      inputType: 'type' in el ? (el.type || '') : '',
      placeholder: 'placeholder' in el ? (el.placeholder || '') : '',
      name: 'name' in el ? (el.name || '') : '',
      id: el.id || '',
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      value: 'value' in el ? (el.value || '') : (el.textContent || ''),
      focused: document.activeElement === el,
      disabled: 'disabled' in el ? el.disabled === true : false,
      readonly: 'readOnly' in el ? el.readOnly === true : false,
    });
  }
  return JSON.stringify(results);
})()
`;
export function parseCdpDetectedFormFields(value) {
    if (typeof value !== "string" || value.length === 0) {
        return [];
    }
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
        return [];
    }
    return parsed.map((field, index) => parseRemoteSurfaceFormFieldRect(field, `$[${index}]`));
}
//# sourceMappingURL=form-field-detector.js.map