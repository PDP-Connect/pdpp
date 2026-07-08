import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CDP_FORM_FIELD_DETECTION_EXPRESSION, parseCdpDetectedFormFields } from "./index.ts";

describe("CDP form field detector expression", () => {
  it("exports a Runtime.evaluate expression without importing CDP into the client core", () => {
    assert.equal(CDP_FORM_FIELD_DETECTION_EXPRESSION.includes("document.querySelectorAll"), true);
    assert.equal(CDP_FORM_FIELD_DETECTION_EXPRESSION.includes("contenteditable"), true);
    assert.equal(CDP_FORM_FIELD_DETECTION_EXPRESSION.includes("JSON.stringify(results)"), true);
  });

  it("parses detector JSON into remote-surface field records", () => {
    assert.deepEqual(
      parseCdpDetectedFormFields(
        JSON.stringify([
          {
            tag: "input",
            inputType: "password",
            placeholder: "",
            name: "password",
            id: "password",
            x: 10,
            y: 20,
            width: 200,
            height: 40,
            value: "",
            focused: true,
            disabled: false,
            readonly: false,
          },
        ]),
      ),
      [
        {
          tag: "input",
          inputType: "password",
          placeholder: "",
          name: "password",
          id: "password",
          x: 10,
          y: 20,
          width: 200,
          height: 40,
          value: "",
          focused: true,
          disabled: false,
          readonly: false,
        },
      ],
    );
  });

  it("treats empty detector results as no fields", () => {
    assert.deepEqual(parseCdpDetectedFormFields(""), []);
  });
});
