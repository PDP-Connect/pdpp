// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for the USAA export-dialog shape observed by the
 * scrubbed run diagnostic in USAA-EXPORT-GAP-INDEPENDENT-REVIEW-0829.md.
 * These tests use a hermetic Playwright Page double and call driveExport, so
 * the assertions exercise openExportDialog and fillExportDateRange through
 * the production parent path. No provider navigation or credentials are used.
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import type { Page } from "playwright";
import { driveExport } from "./index.ts";

type FieldName = "start" | "end";

interface FieldState {
  editable?: boolean;
  enabled?: boolean;
  value?: string;
  visible?: boolean;
}

interface ExportPageShape {
  dialog?: boolean;
  end?: FieldState;
  failField?: FieldName;
  select?: boolean;
  start?: FieldState;
  unrelatedOutsideDialog?: boolean;
}

interface ExportPageProbe {
  page: Page;
  submitCount: () => number;
  values: () => Record<FieldName, string>;
}

type Listener = (...args: unknown[]) => void;

const ACCOUNT_URL = "https://www.usaa.com/my/checking/fixture-account";

function makeResponse(): Record<string, unknown> {
  return {
    body: async () => Buffer.from("Date,Description,Amount\n01/02/2025,Fixture,1.00\n"),
    headers: () => ({
      "content-disposition": 'attachment; filename="fixture.csv"',
      "content-type": "text/csv",
    }),
    request: () => ({ method: () => "GET" }),
    status: () => 200,
    url: () => "https://www.usaa.com/fixture/export.csv",
  };
}

function makePage(shape: ExportPageShape): ExportPageProbe {
  let currentUrl = ACCOUNT_URL;
  let activeField: FieldName | null = null;
  let submitCount = 0;
  const values: Record<FieldName, string> = {
    end: shape.end?.value ?? "",
    start: shape.start?.value ?? "",
  };
  const listeners = new Map<string, Set<Listener>>();

  const emit = (event: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(event) ?? []) {
      listener(...args);
    }
  };

  const fieldState = (field: FieldName): FieldState | undefined => (field === "start" ? shape.start : shape.end);
  const scopedFieldState = (field: FieldName, scope: "page" | "dialog"): FieldState | undefined => {
    if (scope === "dialog") {
      return fieldState(field);
    }
    return (
      fieldState(field) ?? (shape.unrelatedOutsideDialog ? { editable: true, enabled: true, visible: true } : undefined)
    );
  };
  const fieldFromSelector = (selector: string): FieldName | null => {
    if (selector.includes('input[name="fromDate"]') || selector.includes('input[name="startDate"]')) {
      return "start";
    }
    if (selector.includes('input[name="endDate"]')) {
      return "end";
    }
    return null;
  };

  const makeLocator = (selector: string, scope: "page" | "dialog" = "page"): Record<string, unknown> => {
    const locatorScope = selector.includes('[role="dialog"]') ? "dialog" : scope;
    const field = fieldFromSelector(selector);
    const isDialog = selector === '[role="dialog"]';
    const isExport =
      selector.includes("ent-as-utility-bar__item.export") || selector.includes('button, [role="button"]');
    const isSelect = selector.includes('select[name="selectionType"]');
    const isSubmit = selector.includes('button[type="submit"]');
    const isError = selector.includes("errorMessage") || selector.includes("no transactions");
    const isCancel = selector.includes("#export-cancel-button");
    const locator: Record<string, unknown> = {
      click: async (): Promise<void> => {
        await Promise.resolve();
        if (isExport) {
          return;
        }
        if (isSubmit) {
          submitCount += 1;
          emit("response", makeResponse());
          emit("download", {});
          return;
        }
        if (isCancel) {
          return;
        }
        if (field) {
          const state = scopedFieldState(field, locatorScope);
          if (!(state && state.visible !== false && state.enabled !== false && state.editable !== false)) {
            throw new Error(`${field} field is not actionable`);
          }
          activeField = field;
        }
      },
      count: async (): Promise<number> => {
        await Promise.resolve();
        if (isDialog) {
          return shape.dialog === false ? 0 : 1;
        }
        if (isExport) {
          return 1;
        }
        if (field) {
          if (locatorScope === "dialog") {
            return fieldState(field) ? 1 : 0;
          }
          return shape.unrelatedOutsideDialog ? 1 : 0;
        }
        if (isSelect) {
          return locatorScope === "dialog" && shape.select ? 1 : 0;
        }
        if (isSubmit || isError || isCancel) {
          return shape.dialog === false ? 0 : 1;
        }
        return 0;
      },
      filter: (): Record<string, unknown> => locator,
      first: (): Record<string, unknown> => locator,
      innerHTML: async (): Promise<string> => '<div data-fixture="scrubbed-export-dialog"></div>',
      isEditable: (): Promise<boolean> => {
        const state = scopedFieldState(field as FieldName, locatorScope);
        return Promise.resolve(Boolean(state && state.editable !== false));
      },
      isEnabled: (): Promise<boolean> => {
        const state = scopedFieldState(field as FieldName, locatorScope);
        return Promise.resolve(Boolean(state && state.enabled !== false));
      },
      isVisible: (): Promise<boolean> => {
        const state = scopedFieldState(field as FieldName, locatorScope);
        return Promise.resolve(Boolean(state && state.visible !== false));
      },
      locator: (childSelector: string): Record<string, unknown> => makeLocator(childSelector, "dialog"),
      pressSequentially: async (text: string): Promise<void> => {
        await Promise.resolve();
        if (!field || shape.failField === field) {
          throw new Error(`${field ?? "unknown"} field fill failed`);
        }
        values[field] += text;
      },
      selectOption: async (): Promise<string[]> => {
        await Promise.resolve();
        if (!(isSelect && shape.select)) {
          throw new Error("optional selection control is absent");
        }
        return ["date-range"];
      },
      textContent: async (): Promise<string | null> => null,
      waitFor: async ({ state }: { state: string }): Promise<void> => {
        await Promise.resolve();
        if (state === "visible" && isError) {
          throw new Error("no dialog error is present");
        }
        if (state === "visible" && isDialog && shape.dialog === false) {
          throw new Error("dialog is absent");
        }
        if (state === "visible" && isSelect && !shape.select) {
          throw new Error("selection control is absent");
        }
        if (state === "visible" && field) {
          const fieldDetails = scopedFieldState(field, locatorScope);
          if (
            !(
              fieldDetails &&
              locatorScope === "dialog" &&
              fieldDetails.visible !== false &&
              fieldDetails.enabled !== false &&
              fieldDetails.editable !== false
            )
          ) {
            throw new Error(`${field} field is not visible and actionable`);
          }
        }
      },
    };
    return locator;
  };

  const page = Object.assign({} as Page, {
    context: () => ({ newCDPSession: () => Promise.reject(new Error("fixture has no CDP session")) }),
    keyboard: {
      press: async (key: string): Promise<void> => {
        await Promise.resolve();
        if (activeField && (key === "Control+A" || key === "Delete")) {
          values[activeField] = "";
        }
      },
    },
    locator: (selector: string): Record<string, unknown> => makeLocator(selector),
    off: (event: string, listener: Listener): void => {
      listeners.get(event)?.delete(listener);
    },
    on: (event: string, listener: Listener): void => {
      const eventListeners = listeners.get(event) ?? new Set<Listener>();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
    },
    selectOption: (): Promise<string[]> => Promise.resolve(["date-range"]),
    url: (): string => currentUrl,
    evaluate: (): Promise<null> => Promise.resolve(null),
    goto: async (url: string): Promise<null> => {
      await Promise.resolve();
      currentUrl = url;
      return null;
    },
  });

  return { page, submitCount: () => submitCount, values: () => ({ ...values }) };
}

function options() {
  return {
    settleDelayMs: 0,
    sinceDate: "2025-01-02",
    untilDate: "2025-01-31",
  };
}

async function assertRejectedBeforeSubmit(shape: ExportPageShape): Promise<void> {
  const probe = makePage(shape);
  const result = await driveExport(probe.page, ACCOUNT_URL, options());
  assert.deepEqual(result, { kind: "failed" });
  assert.equal(probe.submitCount(), 0, "invalid dialog shape must fail before submit");
}

test("production fallback accepts a dialog-scoped visible start/end pair and submits both dates", async () => {
  const probe = makePage({
    dialog: true,
    end: { editable: true, enabled: true, visible: true },
    select: false,
    start: { editable: true, enabled: true, visible: true },
  });

  const result = await driveExport(probe.page, ACCOUNT_URL, options());
  assert.equal(result.kind, "artifact");
  if (result.kind === "artifact") {
    rmSync(result.path, { force: true });
    rmSync(result.path.slice(0, result.path.lastIndexOf("/")), { recursive: true, force: true });
  }
  assert.equal(probe.submitCount(), 1);
  assert.deepEqual(probe.values(), { end: "01/31/2025", start: "01/02/2025" });
});

test("no dialog fails before submit", async () => {
  await assertRejectedBeforeSubmit({ dialog: false });
});

test("dialog with no date fields fails before submit", async () => {
  await assertRejectedBeforeSubmit({ dialog: true });
});

test("dialog with only one date field fails before submit", async () => {
  await assertRejectedBeforeSubmit({ dialog: true, start: { visible: true } });
});

test("hidden date field fails before submit", async () => {
  await assertRejectedBeforeSubmit({
    dialog: true,
    end: { editable: true, enabled: true, visible: true },
    start: { editable: true, enabled: true, visible: false },
  });
});

test("visible date fields outside the dialog fail before submit", async () => {
  await assertRejectedBeforeSubmit({ dialog: true, unrelatedOutsideDialog: true });
});

test("a fill failure fails closed before submit", async () => {
  const probe = makePage({
    dialog: true,
    end: { editable: true, enabled: true, visible: true },
    failField: "end",
    select: false,
    start: { editable: true, enabled: true, visible: true },
  });

  const result = await driveExport(probe.page, ACCOUNT_URL, options());
  assert.deepEqual(result, { kind: "failed" });
  assert.equal(probe.submitCount(), 0, "end-date fill failure must prevent submit");
  assert.equal(probe.values().start, "01/02/2025", "the first fill may occur, but the parent must stop before submit");
  assert.equal(probe.values().end, "", "the failed field must not receive a partial value");
});
