// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for the fail-closed USAA export-dialog contract. No
 * scrubbed real provider DOM is available for this repair, so these tests use
 * a hermetic Playwright Page double and call driveExport; they exercise the
 * production parent path without claiming that the double proves the live
 * provider's selectors. No provider navigation or credentials are used.
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import type { BrowserContext, Page } from "playwright";
import { driveExport, type EmitDeps, runSingleLadderAttempt, tryExportLadder } from "./index.ts";

type FieldName = "start" | "end";

interface FieldState {
  editable?: boolean;
  enabled?: boolean;
  value?: string;
  visible?: boolean;
}

interface ExportPageShape {
  detachField?: FieldName;
  dialog?: boolean;
  end?: FieldState;
  failField?: FieldName;
  select?: boolean;
  selectFails?: boolean;
  selectionRevealsDateFields?: boolean;
  start?: FieldState;
  unrelatedOutsideDialog?: boolean;
}

interface ExportPageProbe {
  events: () => string[];
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
  const events: string[] = [];
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
          events.push("export-click");
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
          if (shape.detachField === field) {
            throw new Error(`${field} field detached before fill`);
          }
          // Keep this later primitive permissive so the production
          // actionability gate is the only oracle for missing/hidden/disabled
          // fields. Detachment and explicit fill errors remain independent
          // failure paths below.
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
        if (shape.selectFails) {
          throw new Error("selection control rejected date-range");
        }
        events.push("select-date-range");
        if (shape.selectionRevealsDateFields) {
          shape.start = { editable: true, enabled: true, visible: true };
          shape.end = { editable: true, enabled: true, visible: true };
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
          events.push(`check-actionability:${field}`);
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

  return { page, submitCount: () => submitCount, events: () => [...events], values: () => ({ ...values }) };
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

test("production path selects date-range before validating fields it reveals", async () => {
  const probe = makePage({
    dialog: true,
    select: true,
    selectionRevealsDateFields: true,
  });

  const result = await driveExport(probe.page, ACCOUNT_URL, options());
  assert.equal(result.kind, "artifact");
  if (result.kind === "artifact") {
    rmSync(result.path, { force: true });
    rmSync(result.path.slice(0, result.path.lastIndexOf("/")), { recursive: true, force: true });
  }
  const events = probe.events();
  const selectionIndex = events.indexOf("select-date-range");
  assert.equal(events[0], "export-click");
  assert.ok(selectionIndex > 0, "the optional mode must be selected after opening the export dialog");
  assert.ok(events.indexOf("check-actionability:start") > selectionIndex);
  assert.ok(events.indexOf("check-actionability:end") > events.indexOf("check-actionability:start"));
  assert.equal(probe.submitCount(), 1);
  assert.deepEqual(probe.values(), { end: "01/31/2025", start: "01/02/2025" });
});

test("a present selection control that rejects date-range fails before submit", async () => {
  await assertRejectedBeforeSubmit({
    dialog: true,
    end: { editable: true, enabled: true, visible: true },
    select: true,
    selectFails: true,
    start: { editable: true, enabled: true, visible: true },
  });
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

test("disabled date field fails before submit", async () => {
  await assertRejectedBeforeSubmit({
    dialog: true,
    end: { editable: true, enabled: true, visible: true },
    start: { editable: true, enabled: false, visible: true },
  });
});

test("read-only date field fails before submit", async () => {
  await assertRejectedBeforeSubmit({
    dialog: true,
    end: { editable: true, enabled: true, visible: true },
    start: { editable: false, enabled: true, visible: true },
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

test("a field detached after readiness validation fails closed before submit", async () => {
  const probe = makePage({
    dialog: true,
    detachField: "end",
    end: { editable: true, enabled: true, visible: true },
    select: false,
    start: { editable: true, enabled: true, visible: true },
  });

  const result = await driveExport(probe.page, ACCOUNT_URL, options());
  assert.deepEqual(result, { kind: "failed" });
  assert.equal(probe.submitCount(), 0, "a detached field must prevent submit");
  assert.equal(probe.values().start, "01/02/2025", "the first fill may occur before detachment is observed");
  assert.equal(probe.values().end, "");
});

test("production ladder attempt classifies a fill failure as structural and does not request retry", async () => {
  const probe = makePage({
    dialog: true,
    end: { editable: true, enabled: true, visible: true },
    failField: "end",
    select: false,
    start: { editable: true, enabled: true, visible: true },
  });
  const diagnostics: string[] = [];
  const deps = {
    emit: async (): Promise<void> => undefined,
    emitRecord: async (): Promise<void> => undefined,
  } as EmitDeps;

  const outcome = await runSingleLadderAttempt({
    a: {
      account_id_raw: "fixture-account",
      account_type: "checking",
      account_url: "/my/checking/fixture-account",
      balance_cents: 0,
      last_four: "0000",
      name: "Fixture checking",
      raw_text: "Fixture checking",
    },
    accountOrdinal: 1,
    accountTotal: 1,
    attemptOrdinal: 1,
    attemptTotal: 2,
    context: {} as BrowserContext,
    deps,
    onDiagnostics: (info) => diagnostics.push(info.phase),
    onSessionDead: () => undefined,
    page: probe.page,
    sendInteraction: async () => ({ request_id: "fixture", status: "success", type: "INTERACTION_RESPONSE" }),
    settleDelayMs: 0,
    sinceDate: "2025-01-02",
    streamState: { sessionDeadMidRun: false, sessionRepairAttempted: false },
    todayIso: "2025-01-31",
  });

  assert.deepEqual(outcome, { kind: "structure_changed" });
  assert.deepEqual(diagnostics, ["export_dialog_fill_failed"]);
});

test("production export ladder stops after a structural fill failure", async () => {
  const probe = makePage({
    dialog: true,
    end: { editable: true, enabled: true, visible: true },
    failField: "end",
    select: false,
    start: { editable: true, enabled: true, visible: true },
  });
  const progress: string[] = [];
  const deps = {
    emit: (message: { message?: string }): Promise<void> => {
      if (message.message) {
        progress.push(message.message);
      }
      return Promise.resolve();
    },
    emitRecord: async (): Promise<void> => undefined,
  } as EmitDeps;

  const result = await tryExportLadder(
    deps,
    {} as BrowserContext,
    probe.page,
    async () => ({ request_id: "fixture", status: "success", type: "INTERACTION_RESPONSE" }),
    {
      account_id_raw: "fixture-account",
      account_type: "checking",
      account_url: "/my/checking/fixture-account",
      balance_cents: 0,
      last_four: "0000",
      name: "Fixture checking",
      raw_text: "Fixture checking",
    },
    1,
    1,
    ["2025-01-02", "2025-01-10"],
    "2025-01-31",
    { sessionDeadMidRun: false, sessionRepairAttempted: false },
    () => undefined
  );

  assert.equal(result.csvPath, null);
  assert.equal(probe.events().filter((event) => event === "export-click").length, 1);
  assert.equal(
    progress.some((message) => message.includes("Retrying export with shorter range")),
    false
  );
});
