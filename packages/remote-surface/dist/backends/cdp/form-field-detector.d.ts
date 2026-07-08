import { type RemoteSurfaceFormFieldRect } from "../../protocol/index.ts";
/**
 * CDP Runtime.evaluate expression for detecting editable field rectangles.
 *
 * This ports the RBS detector shape, but it is intentionally exported as a
 * plain string instead of being wired into the form-overlay core. Runtime
 * evaluation is fingerprintable on challenge-sensitive pages; strict-stealth
 * hosts should inject a different FieldDetectionSource.
 */
export declare const CDP_FORM_FIELD_DETECTION_EXPRESSION = "\n(() => {\n  const inputs = document.querySelectorAll('input, textarea, select, [contenteditable=\"true\"]');\n  const results = [];\n  for (const el of inputs) {\n    if (el.offsetParent === null && !el.matches(':focus')) continue;\n    const rect = el.getBoundingClientRect();\n    if (rect.width === 0 || rect.height === 0) continue;\n    const tagName = el.tagName.toLowerCase();\n    const editable = el.matches('[contenteditable=\"true\"]');\n    results.push({\n      tag: editable ? 'contenteditable' : tagName,\n      inputType: 'type' in el ? (el.type || '') : '',\n      placeholder: 'placeholder' in el ? (el.placeholder || '') : '',\n      name: 'name' in el ? (el.name || '') : '',\n      id: el.id || '',\n      x: Math.round(rect.x),\n      y: Math.round(rect.y),\n      width: Math.round(rect.width),\n      height: Math.round(rect.height),\n      value: 'value' in el ? (el.value || '') : (el.textContent || ''),\n      focused: document.activeElement === el,\n      disabled: 'disabled' in el ? el.disabled === true : false,\n      readonly: 'readOnly' in el ? el.readOnly === true : false,\n    });\n  }\n  return JSON.stringify(results);\n})()\n";
export declare function parseCdpDetectedFormFields(value: unknown): readonly RemoteSurfaceFormFieldRect[];
//# sourceMappingURL=form-field-detector.d.ts.map