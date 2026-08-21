// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Locator, Page } from "playwright";

import type { InteractionRequest, InteractionResponse } from "../connector-runtime.ts";
import { ensureHebSession, probeHebSession } from "./heb.ts";

const ORDERS_URL = "https://www.heb.com/my-account/your-orders";
const SIGNIN_URL = "https://accounts.heb.com/oidc/auth?prompt=login";

interface InteractionHarness {
  requests: InteractionRequest[];
  sendInteraction: (req: InteractionRequest) => Promise<InteractionResponse>;
}

const LIVE_HTML = readFileSync(new URL("../../connectors/heb/__fixtures__/orders-list.html", import.meta.url), "utf8");
const SIGNIN_HTML = readFileSync(
  new URL("../../connectors/heb/__fixtures__/sign-in-page.html", import.meta.url),
  "utf8"
);
const OPTIONAL_LOGIN_HTML = readFileSync(
  new URL("../../connectors/heb/__fixtures__/sign-in-page-with-optional-passkey.html", import.meta.url),
  "utf8"
);
const INCAPSULA_HTML = readFileSync(
  new URL("../../connectors/heb/__fixtures__/incapsula-block.html", import.meta.url),
  "utf8"
);
const PASSKEY_HTML = readFileSync(
  new URL("../../connectors/heb/__fixtures__/passkey-page.html", import.meta.url),
  "utf8"
);
const PASSKEY_ENROLLMENT_HTML = readFileSync(
  new URL("../../connectors/heb/__fixtures__/passkey-enrollment-page.html", import.meta.url),
  "utf8"
);
/** The live shape observed in run_1787109487130. */
const PASSKEY_ENROLLMENT_URL = "https://accounts.heb.com/interaction/abc123xyz/passkey_registration";
const LOADING_HTML = "<html><body><main><p>Loading your orders...</p></main></body></html>";
const VERIFICATION_HTML = readFileSync(
  new URL("../../connectors/heb/__fixtures__/verification-code-page.html", import.meta.url),
  "utf8"
);
/**
 * The live login-method chooser from run_1787109487130. Matches
 * VERIFICATION_CODE_RE via the radio label "Email me a one-time code" while
 * carrying no code input at all.
 */
const LOGIN_METHOD_CHOOSER_HTML = readFileSync(
  new URL("../../connectors/heb/__fixtures__/login-method-chooser-page.html", import.meta.url),
  "utf8"
);
/** The live chooser URL from run_1787109487130 — the `/login` interaction route. */
const LOGIN_METHOD_CHOOSER_URL = "https://accounts.heb.com/interaction/5iuOgIGpIH0ju9UJKtBiK/login";
const CAPTCHA_HTML = readFileSync(
  new URL("../../connectors/heb/__fixtures__/captcha-page.html", import.meta.url),
  "utf8"
);
const UNKNOWN_HTML = readFileSync(
  new URL("../../connectors/heb/__fixtures__/unknown-ui-page.html", import.meta.url),
  "utf8"
);
const PASSKEY_MSG_RE = /passkey/i;
const VERIFICATION_MSG_RE = /verification code|security code/i;
const CAPTCHA_MSG_RE = /captcha/i;
const INCAPSULA_MSG_RE = /Incapsula/i;
const SECURE_BROWSER_MSG_RE = /secure browser/i;

function makeInteractionHarness({
  makeSessionLiveOnManualAction = true,
  responseForRequest,
}: {
  makeSessionLiveOnManualAction?: boolean;
  responseForRequest?: (req: InteractionRequest) => InteractionResponse;
} = {}): InteractionHarness {
  const requests: InteractionRequest[] = [];
  return {
    requests,
    sendInteraction(req: InteractionRequest): Promise<InteractionResponse> {
      requests.push(req);
      if (responseForRequest) {
        return Promise.resolve(responseForRequest(req));
      }
      if (req.kind === "otp") {
        return Promise.resolve({
          data: { code: "123456" },
          request_id: req.request_id ?? "test_interaction",
          status: "success",
          type: "INTERACTION_RESPONSE",
        });
      }
      if (makeSessionLiveOnManualAction && req.kind === "manual_action") {
        state.live = true;
        state.url = ORDERS_URL;
        state.html = LIVE_HTML;
        state.forms = [];
      }
      return Promise.resolve({
        request_id: req.request_id ?? "test_interaction",
        status: "success",
        type: "INTERACTION_RESPONSE",
      });
    },
  };
}

type PageStateKind =
  | "live"
  | "login"
  | "incapsula"
  | "passkey"
  | "passkey_enrollment"
  | "verification"
  | "captcha"
  | "unknown";
type ControlKind = "email" | "password" | "submit" | "code";
type PostSubmitOutcomeKind = Exclude<PageStateKind, "login">;

interface PostSubmitTransition {
  atMs: number;
  buttons?: FakeButtonState[];
  html?: string;
  kind: PostSubmitOutcomeKind;
  url?: string;
}

interface FakeControlState {
  enabled: boolean;
  filledValue?: string;
  text?: string;
  visible: boolean;
}

interface FakeFormState {
  codeControls: FakeControlState[];
  emailControls: FakeControlState[];
  enabled: boolean;
  passwordControls: FakeControlState[];
  submitControls: FakeControlState[];
  values: {
    code?: string;
    codeDigits?: string[];
    email?: string;
    password?: string;
  };
  visible: boolean;
}

/**
 * A page-level (non-form) control, used to model the passkey-enrollment
 * screen's "Add passkey" / "Not now" buttons.
 */
interface FakeButtonState {
  enabled: boolean;
  onClick?: () => void;
  text: string;
  visible: boolean;
}

interface FakePageState {
  buttons: FakeButtonState[];
  declineClicks: number;
  enrollClicks: number;
  forms: FakeFormState[];
  gotoEvents: Array<{
    atMs: number;
    url: string;
  }>;
  html: string;
  live: boolean;
  loginHtml: string;
  nowMs: number;
  onWaitForTimeout: (() => void) | undefined;
  postSubmitOutcomes: PostSubmitTransition[];
  submitClicks: number;
  url: string;
  view: PageStateKind;
}

type FakePageInit = Partial<Omit<FakePageState, "postSubmitOutcomes">> & {
  postSubmitOutcome?: PostSubmitTransition;
  postSubmitOutcomes?: PostSubmitTransition[];
};

let state: FakePageState;

function createControl(visible: boolean, enabled = visible, text?: string): FakeControlState {
  return text === undefined ? { enabled, visible } : { enabled, text, visible };
}

function createForm({
  emailControls = [createControl(true)],
  codeControls = [],
  enabled = true,
  passwordControls = [createControl(true)],
  submitControls = [createControl(true)],
  visible = true,
}: Partial<FakeFormState> = {}): FakeFormState {
  return {
    enabled,
    emailControls,
    codeControls,
    passwordControls,
    submitControls,
    visible,
    values: {},
  };
}

function assertNever(value: never): never {
  throw new Error(`unexpected value: ${String(value)}`);
}

function defaultLoginForms(): FakeFormState[] {
  return [createForm()];
}

/**
 * Model the live enrollment screen's two controls. `onDecline` defaults to the
 * behavior observed via CDP: clicking "Not now" navigates to the logged-in
 * orders page.
 */
function passkeyEnrollmentButtons({
  declineEffective = true,
  declineEnabled = true,
  declineVisible = true,
}: {
  declineEffective?: boolean;
  declineEnabled?: boolean;
  declineVisible?: boolean;
} = {}): FakeButtonState[] {
  return [
    {
      enabled: true,
      onClick: (): void => {
        state.enrollClicks += 1;
      },
      text: "Add passkey",
      visible: true,
    },
    {
      enabled: declineEnabled,
      onClick: (): void => {
        state.declineClicks += 1;
        if (!declineEffective) {
          return;
        }
        state.live = true;
        state.url = ORDERS_URL;
        state.html = LIVE_HTML;
        state.view = "live";
        state.buttons = [];
        state.forms = [];
      },
      text: "Not now",
      visible: declineVisible,
    },
  ];
}

function makePostSubmitWaitClock(page: Page): { now: () => number; wait: (ms: number) => Promise<void> } {
  return {
    now: (): number => state.nowMs,
    wait: (ms: number): Promise<void> => page.waitForTimeout(ms),
  };
}

function applyPostSubmitOutcome(outcome: PostSubmitTransition): void {
  switch (outcome.kind) {
    case "live":
      state.live = true;
      state.url = outcome.url ?? ORDERS_URL;
      state.html = outcome.html ?? LIVE_HTML;
      state.forms = [];
      state.view = "live";
      return;
    case "incapsula":
      state.live = false;
      state.url = outcome.url ?? SIGNIN_URL;
      state.html = outcome.html ?? INCAPSULA_HTML;
      state.forms = [];
      state.view = "incapsula";
      return;
    case "passkey":
      state.live = false;
      state.url = outcome.url ?? SIGNIN_URL;
      state.html = outcome.html ?? PASSKEY_HTML;
      state.forms = [];
      state.view = "passkey";
      return;
    case "passkey_enrollment":
      state.live = false;
      state.url = outcome.url ?? PASSKEY_ENROLLMENT_URL;
      state.html = outcome.html ?? PASSKEY_ENROLLMENT_HTML;
      state.forms = [];
      state.buttons = outcome.buttons ?? passkeyEnrollmentButtons();
      state.view = "passkey_enrollment";
      return;
    case "verification":
      state.live = false;
      state.url = outcome.url ?? SIGNIN_URL;
      state.html = outcome.html ?? VERIFICATION_HTML;
      state.forms = [createForm({ codeControls: [createControl(true)], submitControls: [] })];
      state.view = "verification";
      return;
    case "captcha":
      state.live = false;
      state.url = outcome.url ?? SIGNIN_URL;
      state.html = outcome.html ?? CAPTCHA_HTML;
      state.forms = [];
      state.view = "captcha";
      return;
    case "unknown":
      state.live = false;
      state.url = outcome.url ?? SIGNIN_URL;
      state.html = outcome.html ?? UNKNOWN_HTML;
      state.forms = [];
      state.view = "unknown";
      return;
    default:
      assertNever(outcome.kind as never);
  }
}

function maybeApplyPostSubmitOutcome(): void {
  if (state.postSubmitOutcomes.length === 0) {
    return;
  }
  const [outcome] = state.postSubmitOutcomes;
  if (!outcome) {
    return;
  }
  if (state.submitClicks === 0 || state.nowMs < outcome.atMs) {
    return;
  }
  state.postSubmitOutcomes.shift();
  applyPostSubmitOutcome(outcome);
}

function emptyLocator(): Locator {
  const locator: Pick<
    Locator,
    | "click"
    | "count"
    | "fill"
    | "first"
    | "innerText"
    | "inputValue"
    | "isEnabled"
    | "isVisible"
    | "locator"
    | "nth"
    | "press"
  > = {
    click: (): Promise<void> => Promise.resolve(),
    count: async (): Promise<number> => 0,
    fill: (): Promise<void> => Promise.resolve(),
    first(): Locator {
      return locator as Locator;
    },
    innerText: async (): Promise<string> => "",
    inputValue: async (): Promise<string> => "",
    isEnabled: async (): Promise<boolean> => false,
    isVisible: async (): Promise<boolean> => false,
    locator(): Locator {
      return emptyLocator();
    },
    press: (): Promise<void> => Promise.resolve(),
    nth(): Locator {
      return locator as Locator;
    },
  };
  return locator as Locator;
}

function controlKindFromSelector(selector: string): ControlKind | null {
  if (
    selector.includes("code") ||
    selector.includes("one-time-code") ||
    selector.includes("verification_code") ||
    selector.includes("otp")
  ) {
    return "code";
  }
  if (selector.includes("email") || selector.includes("username")) {
    return "email";
  }
  if (selector.includes("password")) {
    return "password";
  }
  if (selector.includes("submit")) {
    return "submit";
  }
  return null;
}

function controlListFor(form: FakeFormState, kind: ControlKind): FakeControlState[] {
  switch (kind) {
    case "email":
      return form.emailControls;
    case "code":
      return form.codeControls;
    case "password":
      return form.passwordControls;
    case "submit":
      return form.submitControls;
    default:
      return assertNever(kind as never);
  }
}

function controlLocator(form: FakeFormState, _formIndex: number, kind: ControlKind, controlIndex: number): Locator {
  const control = controlListFor(form, kind)[controlIndex];
  if (!control) {
    return emptyLocator();
  }
  function triggerSubmit(): void {
    state.submitClicks += 1;
    const codeValue = form.values.code ?? form.values.codeDigits?.join("");
    const canSucceed =
      process.env.HEB_LOGIN_SHOULD_SUCCEED !== "0" && Boolean(codeValue || (form.values.email && form.values.password));
    if (canSucceed && state.postSubmitOutcomes.length === 0) {
      state.live = true;
      state.url = ORDERS_URL;
      state.html = LIVE_HTML;
      state.view = "live";
      state.forms = [];
    }
  }
  const locator: Pick<
    Locator,
    | "click"
    | "count"
    | "fill"
    | "first"
    | "innerText"
    | "inputValue"
    | "isEnabled"
    | "isVisible"
    | "locator"
    | "nth"
    | "press"
  > = {
    click: (): Promise<void> => {
      if (kind === "submit") {
        triggerSubmit();
      }
      return Promise.resolve();
    },
    count: async (): Promise<number> => 1,
    fill: (value: string): Promise<void> => {
      control.filledValue = value;
      if (kind === "email") {
        form.values.email = value;
      } else if (kind === "code") {
        if (form.codeControls.length > 1) {
          const digits = form.values.codeDigits ?? new Array(form.codeControls.length).fill("");
          digits[controlIndex] = value;
          form.values.codeDigits = digits;
        } else {
          form.values.code = value;
        }
      } else if (kind === "password") {
        form.values.password = value;
      }
      return Promise.resolve();
    },
    first(): Locator {
      return locator as Locator;
    },
    innerText: async (): Promise<string> => control.text ?? "",
    inputValue: async (): Promise<string> => control.filledValue ?? "",
    isEnabled: async (): Promise<boolean> => control.enabled,
    isVisible: async (): Promise<boolean> => control.visible,
    locator(): Locator {
      return emptyLocator();
    },
    press: (key: string): Promise<void> => {
      if (kind === "code" && key === "Enter") {
        triggerSubmit();
      }
      return Promise.resolve();
    },
    nth(): Locator {
      return locator as Locator;
    },
  };
  return locator as Locator;
}

function controlListLocator(form: FakeFormState, formIndex: number, kind: ControlKind): Locator {
  const controls = controlListFor(form, kind);
  const locator: Pick<
    Locator,
    | "click"
    | "count"
    | "fill"
    | "first"
    | "innerText"
    | "inputValue"
    | "isEnabled"
    | "isVisible"
    | "locator"
    | "nth"
    | "press"
  > = {
    click: (): Promise<void> => Promise.resolve(),
    count: async (): Promise<number> => controls.length,
    fill: (): Promise<void> => Promise.resolve(),
    first(): Locator {
      return controls[0] ? controlLocator(form, formIndex, kind, 0) : emptyLocator();
    },
    innerText: async (): Promise<string> => "",
    inputValue: async (): Promise<string> => "",
    isEnabled: async (): Promise<boolean> => controls.some((control) => control.enabled && control.visible),
    isVisible: async (): Promise<boolean> => controls.some((control) => control.visible),
    locator(): Locator {
      return emptyLocator();
    },
    press: (): Promise<void> => Promise.resolve(),
    nth(index: number): Locator {
      return controlLocator(form, formIndex, kind, index);
    },
  };
  return locator as Locator;
}

function formLocator(form: FakeFormState, formIndex: number): Locator {
  const locator: Pick<
    Locator,
    | "click"
    | "count"
    | "fill"
    | "first"
    | "innerText"
    | "inputValue"
    | "isEnabled"
    | "isVisible"
    | "locator"
    | "nth"
    | "press"
  > = {
    click: (): Promise<void> => Promise.resolve(),
    count: async (): Promise<number> => 1,
    fill: (): Promise<void> => Promise.resolve(),
    first(): Locator {
      return locator as Locator;
    },
    innerText: async (): Promise<string> => "",
    inputValue: async (): Promise<string> => "",
    isEnabled: async (): Promise<boolean> => form.enabled,
    isVisible: async (): Promise<boolean> => form.visible,
    locator(selector: string): Locator {
      const kind = controlKindFromSelector(selector);
      return kind ? controlListLocator(form, formIndex, kind) : emptyLocator();
    },
    press: (): Promise<void> => Promise.resolve(),
    nth(): Locator {
      return locator as Locator;
    },
  };
  return locator as Locator;
}

function buttonLocator(button: FakeButtonState): Locator {
  const locator: Pick<
    Locator,
    | "click"
    | "count"
    | "fill"
    | "first"
    | "innerText"
    | "inputValue"
    | "isEnabled"
    | "isVisible"
    | "locator"
    | "nth"
    | "press"
  > = {
    click: (): Promise<void> => {
      button.onClick?.();
      return Promise.resolve();
    },
    count: async (): Promise<number> => 1,
    fill: (): Promise<void> => Promise.resolve(),
    first(): Locator {
      return locator as Locator;
    },
    innerText: async (): Promise<string> => button.text,
    inputValue: async (): Promise<string> => "",
    isEnabled: async (): Promise<boolean> => button.enabled,
    isVisible: async (): Promise<boolean> => button.visible,
    locator(): Locator {
      return emptyLocator();
    },
    press: (): Promise<void> => Promise.resolve(),
    nth(): Locator {
      return locator as Locator;
    },
  };
  return locator as Locator;
}

function buttonsLocator(): Locator {
  const locator: Pick<
    Locator,
    | "click"
    | "count"
    | "fill"
    | "first"
    | "innerText"
    | "inputValue"
    | "isEnabled"
    | "isVisible"
    | "locator"
    | "nth"
    | "press"
  > = {
    click: (): Promise<void> => Promise.resolve(),
    count: async (): Promise<number> => state.buttons.length,
    fill: (): Promise<void> => Promise.resolve(),
    first(): Locator {
      return state.buttons[0] ? buttonLocator(state.buttons[0]) : emptyLocator();
    },
    innerText: async (): Promise<string> => "",
    inputValue: async (): Promise<string> => "",
    isEnabled: async (): Promise<boolean> => state.buttons.some((b) => b.enabled && b.visible),
    isVisible: async (): Promise<boolean> => state.buttons.some((b) => b.visible),
    locator(): Locator {
      return emptyLocator();
    },
    press: (): Promise<void> => Promise.resolve(),
    nth(index: number): Locator {
      const button = state.buttons[index];
      return button ? buttonLocator(button) : emptyLocator();
    },
  };
  return locator as Locator;
}

/**
 * Page-level control lookup, mirroring how a real DOM answers
 * `page.locator(VERIFICATION_CODE_SELECTOR)`: every matching input on the page,
 * regardless of which form encloses it. The connector uses this to decide
 * whether the page can actually ACCEPT a code, so the fake must aggregate the
 * same way rather than reporting zero.
 */
function pageControlsLocator(kind: ControlKind): Locator {
  interface Entry {
    control: FakeControlState;
    controlIndex: number;
    form: FakeFormState;
    formIndex: number;
  }
  function entries(): Entry[] {
    const found: Entry[] = [];
    state.forms.forEach((form, formIndex) => {
      controlListFor(form, kind).forEach((control, controlIndex) => {
        found.push({ control, controlIndex, form, formIndex });
      });
    });
    return found;
  }
  function at(index: number): Locator {
    const entry = entries()[index];
    return entry ? controlLocator(entry.form, entry.formIndex, kind, entry.controlIndex) : emptyLocator();
  }
  const locator: Pick<
    Locator,
    | "click"
    | "count"
    | "fill"
    | "first"
    | "innerText"
    | "inputValue"
    | "isEnabled"
    | "isVisible"
    | "locator"
    | "nth"
    | "press"
  > = {
    click: (): Promise<void> => Promise.resolve(),
    count: async (): Promise<number> => entries().length,
    fill: (): Promise<void> => Promise.resolve(),
    first(): Locator {
      return at(0);
    },
    innerText: async (): Promise<string> => "",
    inputValue: async (): Promise<string> => "",
    isEnabled: async (): Promise<boolean> => entries().some(({ control }) => control.enabled && control.visible),
    isVisible: async (): Promise<boolean> => entries().some(({ control }) => control.visible),
    locator(): Locator {
      return emptyLocator();
    },
    press: (): Promise<void> => Promise.resolve(),
    nth(index: number): Locator {
      return at(index);
    },
  };
  return locator as Locator;
}

function formsLocator(): Locator {
  const locator: Pick<
    Locator,
    "click" | "count" | "fill" | "first" | "inputValue" | "isEnabled" | "isVisible" | "locator" | "nth" | "press"
  > = {
    click: (): Promise<void> => Promise.resolve(),
    count: async (): Promise<number> => state.forms.length,
    fill: (): Promise<void> => Promise.resolve(),
    first(): Locator {
      return state.forms[0] ? formLocator(state.forms[0], 0) : emptyLocator();
    },
    inputValue: async (): Promise<string> => "",
    isEnabled: async (): Promise<boolean> => state.forms.some((form) => form.enabled && form.visible),
    isVisible: async (): Promise<boolean> => state.forms.some((form) => form.visible),
    locator(): Locator {
      return emptyLocator();
    },
    press: (): Promise<void> => Promise.resolve(),
    nth(index: number): Locator {
      const form = state.forms[index];
      return form ? formLocator(form, index) : emptyLocator();
    },
  };
  return locator as Locator;
}

function makePage(initial: FakePageInit = {}): Page {
  let { forms } = initial;
  if (!forms) {
    if (initial.view === "login") {
      forms = defaultLoginForms();
    } else if (initial.view === "verification") {
      forms = [createForm({ codeControls: [createControl(true)], submitControls: [] })];
    } else {
      forms = [];
    }
  }

  state = {
    buttons: initial.buttons ?? [],
    declineClicks: 0,
    enrollClicks: 0,
    forms,
    html: initial.html ?? UNKNOWN_HTML,
    gotoEvents: [],
    live: initial.live ?? false,
    loginHtml: initial.html ?? SIGNIN_HTML,
    nowMs: 0,
    onWaitForTimeout: initial.onWaitForTimeout,
    postSubmitOutcomes: initial.postSubmitOutcomes ?? (initial.postSubmitOutcome ? [initial.postSubmitOutcome] : []),
    submitClicks: 0,
    url: initial.url ?? SIGNIN_URL,
    view: initial.view ?? "unknown",
  };

  const page: Partial<Page> = {
    content: (): Promise<string> => Promise.resolve(state.html),
    goto: (url: string): Promise<null> => {
      state.gotoEvents.push({
        atMs: state.nowMs,
        url,
      });
      if (url === ORDERS_URL) {
        if (state.live) {
          state.url = ORDERS_URL;
          state.html = LIVE_HTML;
          state.view = "live";
          state.forms = [];
        } else if (state.view === "incapsula") {
          state.url = SIGNIN_URL;
          state.html = INCAPSULA_HTML;
        } else if (state.view === "passkey") {
          state.url = SIGNIN_URL;
          state.html = PASSKEY_HTML;
        } else if (state.view === "passkey_enrollment") {
          state.url = PASSKEY_ENROLLMENT_URL;
          state.html = PASSKEY_ENROLLMENT_HTML;
        } else if (state.view === "verification") {
          state.url = SIGNIN_URL;
          state.html = VERIFICATION_HTML;
        } else if (state.view === "captcha") {
          state.url = SIGNIN_URL;
          state.html = CAPTCHA_HTML;
        } else if (state.view === "login") {
          state.url = SIGNIN_URL;
          state.html = state.loginHtml;
        } else {
          state.url = url;
        }
      } else {
        state.url = url;
      }
      return Promise.resolve(null);
    },
    locator: (selector: string): Locator => {
      if (selector === "form") {
        return formsLocator();
      }
      // The passkey decline selector enumerates page-level clickable controls.
      if (selector.includes('[role="button"]')) {
        return buttonsLocator();
      }
      const kind = controlKindFromSelector(selector);
      if (kind) {
        return pageControlsLocator(kind);
      }
      return emptyLocator();
    },
    url: (): string => state.url,
    waitForTimeout: (ms: number): Promise<void> => {
      state.nowMs += ms;
      maybeApplyPostSubmitOutcome();
      state.onWaitForTimeout?.();
      return Promise.resolve();
    },
  };
  return page as Page;
}

async function withHebCredentials(run: () => Promise<void>): Promise<void> {
  const priorUsername = process.env.HEB_USERNAME;
  const priorPassword = process.env.HEB_PASSWORD;
  const priorLoginShouldSucceed = process.env.HEB_LOGIN_SHOULD_SUCCEED;
  process.env.HEB_USERNAME = "owner@example.com";
  process.env.HEB_PASSWORD = "synthetic-password";
  process.env.HEB_LOGIN_SHOULD_SUCCEED = "1";
  try {
    await run();
  } finally {
    if (priorUsername === undefined) {
      delete process.env.HEB_USERNAME;
    } else {
      process.env.HEB_USERNAME = priorUsername;
    }
    if (priorPassword === undefined) {
      delete process.env.HEB_PASSWORD;
    } else {
      process.env.HEB_PASSWORD = priorPassword;
    }
    if (priorLoginShouldSucceed === undefined) {
      delete process.env.HEB_LOGIN_SHOULD_SUCCEED;
    } else {
      process.env.HEB_LOGIN_SHOULD_SUCCEED = priorLoginShouldSucceed;
    }
  }
}

// ─── Passkey-enrollment interstitial (run_1787109487130) ──────────────────
// Live ground truth: 4s after submit the page was
// https://accounts.heb.com/interaction/<id>/passkey_registration, sign-in had
// ALREADY succeeded, and no code was ever dispatched. The connector emitted a
// fabricated `otp` interaction and blocked for 10+ minutes. Clicking "Not now"
// navigated straight to the logged-in orders page.

test("ensureHebSession declines the post-submit passkey-enrollment upsell and continues WITHOUT any OTP prompt", async () => {
  await withHebCredentials(async () => {
    const page = makePage({
      html: SIGNIN_HTML,
      live: false,
      postSubmitOutcomes: [
        {
          atMs: 200,
          kind: "passkey_enrollment",
        },
      ],
      url: SIGNIN_URL,
      view: "login",
    });
    const harness = makeInteractionHarness({ makeSessionLiveOnManualAction: false });

    const ok = await ensureHebSession({
      page,
      postSubmitWaitClock: makePostSubmitWaitClock(page),
      sendInteraction: harness.sendInteraction,
    });

    assert.equal(ok, true);
    // The defect being fixed: no interaction of ANY kind, and above all no otp.
    assert.equal(harness.requests.length, 0, "the enrollment upsell must never prompt the owner");
    assert.equal(
      harness.requests.filter((req) => req.kind === "otp").length,
      0,
      "no OTP may be fabricated for a screen that never sent a code"
    );
    assert.equal(state.declineClicks, 1, "the decline control must be clicked exactly once");
    assert.equal(state.enrollClicks, 0, "PDPP must never enroll a passkey");
    assert.equal(state.live, true);
    assert.equal(state.url, ORDERS_URL);
  });
});

test("ensureHebSession declines a passkey-enrollment page reached on the initial probe, without an OTP prompt", async () => {
  const page = makePage({
    buttons: passkeyEnrollmentButtons(),
    html: PASSKEY_ENROLLMENT_HTML,
    live: false,
    url: PASSKEY_ENROLLMENT_URL,
    view: "passkey_enrollment",
  });
  const harness = makeInteractionHarness({ makeSessionLiveOnManualAction: false });

  const ok = await ensureHebSession({
    page,
    postSubmitWaitClock: makePostSubmitWaitClock(page),
    sendInteraction: harness.sendInteraction,
  });

  assert.equal(ok, true);
  assert.equal(harness.requests.length, 0);
  assert.equal(state.declineClicks, 1);
  assert.equal(state.enrollClicks, 0);
  assert.equal(state.live, true);
});

test("ensureHebSession fails honestly when the passkey decline control is unusable — never an OTP prompt", async () => {
  await withHebCredentials(async () => {
    const page = makePage({
      html: SIGNIN_HTML,
      live: false,
      postSubmitOutcomes: [
        {
          atMs: 200,
          // "Not now" present in the copy but not actually clickable.
          buttons: passkeyEnrollmentButtons({ declineVisible: false }),
          kind: "passkey_enrollment",
        },
      ],
      url: SIGNIN_URL,
      view: "login",
    });
    const harness = makeInteractionHarness({ makeSessionLiveOnManualAction: false });

    await assert.rejects(
      ensureHebSession({
        page,
        postSubmitWaitClock: makePostSubmitWaitClock(page),
        sendInteraction: harness.sendInteraction,
      }),
      /heb_passkey_enrollment_decline_control_missing/
    );
    assert.equal(
      harness.requests.filter((req) => req.kind === "otp").length,
      0,
      "a failed decline must never degrade into a fabricated OTP prompt"
    );
    assert.equal(state.declineClicks, 0);
    assert.equal(state.enrollClicks, 0);
    assert.equal(state.live, false);
  });
});

test("ensureHebSession fails honestly when the passkey decline click does not take effect — bounded, no OTP, no spin", async () => {
  await withHebCredentials(async () => {
    const page = makePage({
      html: SIGNIN_HTML,
      live: false,
      postSubmitOutcomes: [
        {
          atMs: 200,
          // Clickable, but the page stays on passkey_registration afterward.
          buttons: passkeyEnrollmentButtons({ declineEffective: false }),
          kind: "passkey_enrollment",
        },
      ],
      url: SIGNIN_URL,
      view: "login",
    });
    const harness = makeInteractionHarness({ makeSessionLiveOnManualAction: false });

    await assert.rejects(
      ensureHebSession({
        page,
        postSubmitWaitClock: makePostSubmitWaitClock(page),
        sendInteraction: harness.sendInteraction,
      }),
      /heb_passkey_enrollment_decline_ineffective/
    );
    assert.equal(
      harness.requests.filter((req) => req.kind === "otp").length,
      0,
      "an ineffective decline must never degrade into a fabricated OTP prompt"
    );
    assert.equal(state.enrollClicks, 0, "PDPP must never click Add passkey, even while retrying");
    // Bounded: retries stop rather than spinning for the full timeout.
    assert.ok(state.declineClicks >= 1);
    assert.ok(state.declineClicks <= 4, `decline retries must be bounded, saw ${state.declineClicks}`);
    assert.equal(state.live, false);
  });
});

test("a genuine verification-code surface on the accounts.heb.com interaction host STILL prompts for OTP", async () => {
  await withHebCredentials(async () => {
    const page = makePage({
      html: VERIFICATION_HTML,
      live: false,
      postSubmitOutcomes: [
        {
          atMs: 200,
          html: LIVE_HTML,
          kind: "live",
          url: ORDERS_URL,
        },
      ],
      // A sibling interaction route that is NOT passkey_registration.
      url: "https://accounts.heb.com/interaction/abc123xyz/verification",
      view: "verification",
    });
    const harness = makeInteractionHarness();

    const ok = await ensureHebSession({
      page,
      postSubmitWaitClock: makePostSubmitWaitClock(page),
      sendInteraction: harness.sendInteraction,
    });

    assert.equal(ok, true);
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0]?.kind, "otp", "real challenges must be unaffected by the passkey fix");
    assert.match(harness.requests[0]?.message ?? "", VERIFICATION_MSG_RE);
    assert.equal(state.declineClicks, 0);
  });
});

// ─── Login-method chooser (run_1787109487130) ─────────────────────────────
// Live ground truth: 340ms after the login form loaded, the page was still
// https://accounts.heb.com/interaction/<id>/login — a chooser reading "Choose
// how you log in" with radios "Email me a one-time code" and "Enter password"
// (the latter ALREADY CHECKED). It has no code input. VERIFICATION_CODE_RE
// matched the radio LABEL, so the connector classified it `verification_code`
// and prompted the owner for a code that H-E-B had never sent.

test("the login-method chooser never prompts for an OTP — a radio label offering a code is not a challenge", async () => {
  await withHebCredentials(async () => {
    const page = makePage({
      // The chooser has a password field but NO code field, exactly as captured.
      forms: [createForm({ codeControls: [], submitControls: [createControl(true)] })],
      html: LOGIN_METHOD_CHOOSER_HTML,
      live: false,
      postSubmitOutcomes: [
        {
          atMs: 200,
          html: LIVE_HTML,
          kind: "live",
          url: ORDERS_URL,
        },
      ],
      url: LOGIN_METHOD_CHOOSER_URL,
      view: "login",
    });
    const harness = makeInteractionHarness({ makeSessionLiveOnManualAction: false });

    const ok = await ensureHebSession({
      page,
      postSubmitWaitClock: makePostSubmitWaitClock(page),
      sendInteraction: harness.sendInteraction,
    });

    // The defect: the owner was asked for a code that was never sent.
    assert.equal(
      harness.requests.filter((req) => req.kind === "otp").length,
      0,
      "a page merely OFFERING to send a code must never trigger an OTP prompt"
    );
    assert.equal(ok, true, "the already-selected password path must carry the sign-in through");
    assert.equal(state.live, true);
  });
});

test("the chooser's own copy cannot fabricate an OTP prompt on the post-submit wait either", async () => {
  await withHebCredentials(async () => {
    // Post-submit, H-E-B re-renders the SAME chooser route. The wait loop must
    // keep waiting rather than reclassifying that re-render as a challenge.
    const page = makePage({
      html: SIGNIN_HTML,
      live: false,
      postSubmitOutcomes: [
        {
          atMs: 200,
          html: LOGIN_METHOD_CHOOSER_HTML,
          kind: "unknown",
          url: LOGIN_METHOD_CHOOSER_URL,
        },
        {
          atMs: 600,
          html: LIVE_HTML,
          kind: "live",
          url: ORDERS_URL,
        },
      ],
      url: SIGNIN_URL,
      view: "login",
    });
    const harness = makeInteractionHarness({ makeSessionLiveOnManualAction: false });

    const ok = await ensureHebSession({
      page,
      postSubmitWaitClock: makePostSubmitWaitClock(page),
      sendInteraction: harness.sendInteraction,
    });

    assert.equal(ok, true);
    assert.equal(
      harness.requests.filter((req) => req.kind === "otp").length,
      0,
      "the post-submit re-render of the chooser must not be read as a code challenge"
    );
  });
});

test("prose mentioning a one-time code with no code input never prompts — text alone is not evidence", async () => {
  await withHebCredentials(async () => {
    // Every VERIFICATION_CODE_RE phrase, on a page with no code input at all.
    const proseOnly = [
      "<!DOCTYPE html><html><body><main>",
      "<h1>Account security</h1>",
      "<p>We can send a verification code to your email.</p>",
      "<p>Your security code keeps your account safe.</p>",
      "<p>Choose “Email me a one-time code” to receive one.</p>",
      "<p>No code sent yet.</p>",
      "</main></body></html>",
    ].join("");

    const page = makePage({
      // No forms at all: nothing on this page can accept a code.
      forms: [],
      html: proseOnly,
      live: false,
      url: "https://accounts.heb.com/interaction/abc123xyz/notice",
      view: "unknown",
    });
    const harness = makeInteractionHarness({ makeSessionLiveOnManualAction: false });

    await assert.rejects(
      ensureHebSession({
        page,
        postSubmitWaitClock: makePostSubmitWaitClock(page),
        sendInteraction: harness.sendInteraction,
      }),
      /heb_login_unexpected_ui/,
      "an unrecognized page must fail with a named error, never a fabricated OTP prompt"
    );

    assert.equal(
      harness.requests.filter((req) => req.kind === "otp").length,
      0,
      "code copy without a code input must never prompt"
    );
    // Requirement 4: no silent fallthrough. The owner is handed the browser.
    const handoffs = harness.requests.filter((req) => req.kind === "manual_action");
    assert.equal(handoffs.length, 1, "the honest path is a browser handoff, not an invented secret");
    assert.match(handoffs[0]?.message ?? "", SECURE_BROWSER_MSG_RE);
  });
});

test("a code input that disappears between classification and the prompt fails honestly instead of prompting", async () => {
  await withHebCredentials(async () => {
    // H-E-B re-renders the interaction route mid-flight. Classification saw a
    // real code input; by the time the owner would be asked, it is gone. The
    // owner must not be sent hunting for a code this page can no longer take.
    const page = makePage({
      html: VERIFICATION_HTML,
      live: false,
      url: "https://accounts.heb.com/interaction/abc123xyz/verification",
      view: "verification",
    });
    // The code input is real when the surface is classified, then H-E-B
    // re-renders the route and it is gone before the owner would be asked.
    // `checkpoint` is the connector's own progress signal, so the removal is
    // pinned to the exact step after classification rather than to a poll count.
    const harness = makeInteractionHarness();
    const checkpoint = (name: string): Promise<void> => {
      if (name === "heb-verification-code-loaded") {
        state.forms = [createForm({ codeControls: [], submitControls: [] })];
      }
      return Promise.resolve();
    };

    await assert.rejects(
      ensureHebSession({
        checkpoint,
        page,
        postSubmitWaitClock: makePostSubmitWaitClock(page),
        sendInteraction: harness.sendInteraction,
      }),
      /heb_verification_code_input_missing/,
      "the prompt site must re-verify that the page can still accept a code"
    );
    assert.equal(
      harness.requests.filter((req) => req.kind === "otp").length,
      0,
      "no OTP may be requested once the code input is gone"
    );
  });
});

test("the enrollment control is never clicked — only an exact decline label is actionable", async () => {
  // The enrollment screen's only control is "Add passkey". No decline label
  // matches it, so the run must stop with a named error rather than clicking
  // the one button on screen.
  const page = makePage({
    buttons: [
      {
        enabled: true,
        onClick: (): void => {
          state.enrollClicks += 1;
        },
        text: "Add passkey",
        visible: true,
      },
    ],
    html: PASSKEY_ENROLLMENT_HTML,
    live: false,
    url: PASSKEY_ENROLLMENT_URL,
    view: "passkey_enrollment",
  });
  const harness = makeInteractionHarness({ makeSessionLiveOnManualAction: false });

  await assert.rejects(
    ensureHebSession({
      page,
      postSubmitWaitClock: makePostSubmitWaitClock(page),
      sendInteraction: harness.sendInteraction,
    }),
    /heb_passkey_enrollment_decline_control_missing/
  );
  assert.equal(state.enrollClicks, 0, "PDPP must never click Add passkey");
  assert.equal(harness.requests.filter((req) => req.kind === "otp").length, 0);
});

test("passkey-enrollment detection does not fire on a lookalike URL or on enrollment copy alone", async () => {
  // Copy-only lookalike: the enrollment marketing text on a page whose URL is
  // NOT the passkey_registration route must not be auto-declined.
  const copyOnly = makePage({
    buttons: passkeyEnrollmentButtons(),
    html: PASSKEY_ENROLLMENT_HTML,
    live: false,
    url: "https://accounts.heb.com/interaction/abc123xyz/login",
    view: "unknown",
  });
  const copyHarness = makeInteractionHarness();
  await ensureHebSession({
    page: copyOnly,
    postSubmitWaitClock: makePostSubmitWaitClock(copyOnly),
    sendInteraction: copyHarness.sendInteraction,
  });
  assert.equal(state.declineClicks, 0, "URL is required — marketing copy alone must not trigger a decline");

  // Foreign-host lookalike: the route name on a host that is not accounts.heb.com.
  const foreignHost = makePage({
    buttons: passkeyEnrollmentButtons(),
    html: PASSKEY_ENROLLMENT_HTML,
    live: false,
    url: "https://evil.example.com/interaction/abc/passkey_registration",
    view: "unknown",
  });
  const foreignHarness = makeInteractionHarness();
  await ensureHebSession({
    page: foreignHost,
    postSubmitWaitClock: makePostSubmitWaitClock(foreignHost),
    sendInteraction: foreignHarness.sendInteraction,
  });
  assert.equal(state.declineClicks, 0, "the host must be accounts.heb.com");
});

test("probeHebSession returns true when the persisted profile already reaches orders", async () => {
  const page = makePage({ html: LIVE_HTML, live: true, url: ORDERS_URL, view: "live" });
  assert.equal(await probeHebSession(page), true);
});

test("probeHebSession returns false when orders redirects to a sign-in form", async () => {
  const page = makePage({ html: SIGNIN_HTML, live: false, url: SIGNIN_URL, view: "login" });
  assert.equal(await probeHebSession(page), false);
});

test("probeHebSession does not treat a loading orders page as live", async () => {
  const page = makePage({ html: LOADING_HTML, live: false, url: ORDERS_URL, view: "unknown" });
  assert.equal(await probeHebSession(page), false);
});

test("probeHebSession returns true when the orders page carries authenticated evidence", async () => {
  const page = makePage({ html: LIVE_HTML, live: false, url: ORDERS_URL, view: "unknown" });
  assert.equal(await probeHebSession(page), true);
});

test("ensureHebSession fills the verified login form, submits, and waits for the live transition", async () => {
  await withHebCredentials(async () => {
    const page = makePage({ html: SIGNIN_HTML, live: false, url: SIGNIN_URL, view: "login" });
    const harness = makeInteractionHarness();
    const ok = await ensureHebSession({
      page,
      postSubmitWaitClock: makePostSubmitWaitClock(page),
      sendInteraction: harness.sendInteraction,
    });
    assert.equal(ok, true);
    assert.equal(harness.requests.length, 0);
    assert.equal(state.submitClicks, 1);
    assert.equal(state.live, true);
    assert.equal(state.url, ORDERS_URL);
    assert.equal(state.gotoEvents.length, 1);
  });
});

test("ensureHebSession fires onCredentialSubmit exactly once, and only when the verified form was actually submitted", async () => {
  await withHebCredentials(async () => {
    const page = makePage({ html: SIGNIN_HTML, live: false, url: SIGNIN_URL, view: "login" });
    const harness = makeInteractionHarness();
    let markerCount = 0;
    const ok = await ensureHebSession({
      onCredentialSubmit: () => {
        markerCount += 1;
        assert.equal(state.submitClicks, 1, "the marker must fire after the submit click, never before it");
      },
      page,
      postSubmitWaitClock: makePostSubmitWaitClock(page),
      sendInteraction: harness.sendInteraction,
    });
    assert.equal(ok, true);
    assert.equal(markerCount, 1);
  });
});

test("ensureHebSession does NOT fire onCredentialSubmit on the authenticated fast path — no credential went out", async () => {
  const page = makePage({ html: LIVE_HTML, live: false, url: ORDERS_URL, view: "unknown" });
  const harness = makeInteractionHarness({ makeSessionLiveOnManualAction: false });
  let markerCount = 0;
  const ok = await ensureHebSession({
    onCredentialSubmit: () => {
      markerCount += 1;
    },
    page,
    postSubmitWaitClock: makePostSubmitWaitClock(page),
    sendInteraction: harness.sendInteraction,
  });
  assert.equal(ok, true);
  assert.equal(markerCount, 0);
});

test("ensureHebSession does not fast-path a loading orders page as a live session", async () => {
  const page = makePage({ html: LOADING_HTML, live: false, url: ORDERS_URL, view: "unknown" });
  const harness = makeInteractionHarness({ makeSessionLiveOnManualAction: false });
  await assert.rejects(
    ensureHebSession({
      page,
      postSubmitWaitClock: makePostSubmitWaitClock(page),
      sendInteraction: harness.sendInteraction,
    }),
    /heb_login_unexpected_ui/
  );
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0]?.kind, "manual_action");
  assert.match(harness.requests[0]?.message ?? "", /did not render the expected login form|open the secure browser/i);
});

test("ensureHebSession fast-paths authenticated orders evidence", async () => {
  const page = makePage({ html: LIVE_HTML, live: false, url: ORDERS_URL, view: "unknown" });
  const harness = makeInteractionHarness({ makeSessionLiveOnManualAction: false });
  const ok = await ensureHebSession({
    page,
    postSubmitWaitClock: makePostSubmitWaitClock(page),
    sendInteraction: harness.sendInteraction,
  });
  assert.equal(ok, true);
  assert.equal(harness.requests.length, 0);
  assert.equal(state.gotoEvents.length, 1);
});

test("ensureHebSession fills the live optional-passkey form instead of handing off before credentials are used", async () => {
  await withHebCredentials(async () => {
    const page = makePage({ html: OPTIONAL_LOGIN_HTML, live: false, url: SIGNIN_URL, view: "login" });
    const harness = makeInteractionHarness();
    const ok = await ensureHebSession({
      page,
      postSubmitWaitClock: makePostSubmitWaitClock(page),
      sendInteraction: harness.sendInteraction,
    });
    assert.equal(ok, true);
    assert.equal(harness.requests.length, 0);
    assert.equal(state.submitClicks, 1);
    assert.equal(state.live, true);
    assert.equal(state.url, ORDERS_URL);
    assert.equal(state.gotoEvents.length, 1);
  });
});

test("ensureHebSession waits through an unknown intermediate page before succeeding", async () => {
  await withHebCredentials(async () => {
    const page = makePage({
      html: SIGNIN_HTML,
      live: false,
      postSubmitOutcomes: [
        {
          atMs: 200,
          html: LOADING_HTML,
          kind: "unknown",
          url: ORDERS_URL,
        },
        {
          atMs: 600,
          html: LIVE_HTML,
          kind: "live",
          url: ORDERS_URL,
        },
      ],
      url: SIGNIN_URL,
      view: "login",
    });
    const harness = makeInteractionHarness();
    const ok = await ensureHebSession({
      page,
      postSubmitWaitClock: makePostSubmitWaitClock(page),
      sendInteraction: harness.sendInteraction,
    });
    assert.equal(ok, true);
    assert.equal(harness.requests.length, 0);
    assert.equal(state.submitClicks, 1);
    assert.equal(state.live, true);
    assert.equal(state.url, ORDERS_URL);
    assert.equal(state.gotoEvents.length, 1);
    assert.ok(state.nowMs >= 600);
  });
});

test("ensureHebSession routes a post-submit verification-code challenge through structured otp, fills it, submits it, and re-probes live", async () => {
  await withHebCredentials(async () => {
    const page = makePage({
      html: SIGNIN_HTML,
      live: false,
      postSubmitOutcomes: [
        {
          atMs: 200,
          html: VERIFICATION_HTML,
          kind: "verification",
          url: SIGNIN_URL,
        },
        {
          atMs: 400,
          html: LIVE_HTML,
          kind: "live",
          url: ORDERS_URL,
        },
      ],
      url: SIGNIN_URL,
      view: "login",
    });
    const harness = makeInteractionHarness();
    const ok = await ensureHebSession({
      page,
      postSubmitWaitClock: makePostSubmitWaitClock(page),
      sendInteraction: harness.sendInteraction,
    });
    assert.equal(ok, true);
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0]?.kind, "otp");
    assert.match(harness.requests[0]?.message ?? "", VERIFICATION_MSG_RE);
    assert.deepEqual(harness.requests[0]?.schema, {
      properties: { code: { pattern: "^\\d{6}$", type: "string" } },
      required: ["code"],
      type: "object",
    });
    assert.equal(state.submitClicks, 2);
    assert.equal(state.live, true);
    assert.equal(state.url, ORDERS_URL);
    assert.equal(state.gotoEvents.length, 2);
    assert.ok(state.nowMs >= 400);
  });
});

test("ensureHebSession emits structured otp for verification-code pages, fills the code, submits it, and re-probes live", async () => {
  await withHebCredentials(async () => {
    const page = makePage({
      html: VERIFICATION_HTML,
      live: false,
      postSubmitOutcomes: [
        {
          atMs: 200,
          html: LIVE_HTML,
          kind: "live",
          url: ORDERS_URL,
        },
      ],
      url: SIGNIN_URL,
      view: "verification",
    });
    const harness = makeInteractionHarness();
    const ok = await ensureHebSession({
      page,
      postSubmitWaitClock: makePostSubmitWaitClock(page),
      sendInteraction: harness.sendInteraction,
    });
    assert.equal(ok, true);
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0]?.kind, "otp");
    assert.match(harness.requests[0]?.message ?? "", VERIFICATION_MSG_RE);
    assert.deepEqual(harness.requests[0]?.schema, {
      properties: { code: { pattern: "^\\d{6}$", type: "string" } },
      required: ["code"],
      type: "object",
    });
    assert.equal(state.submitClicks, 1);
    assert.equal(state.live, true);
    assert.equal(state.url, ORDERS_URL);
    assert.equal(state.gotoEvents.length, 2);
    assert.ok(state.nowMs >= 200);
  });
});

test("ensureHebSession rejects cancelled or invalid otp responses on the post-submit verification-code path without submitting the code", async () => {
  await withHebCredentials(async () => {
    const cases: Array<{
      label: string;
      responseForRequest: (req: InteractionRequest) => InteractionResponse;
    }> = [
      {
        label: "cancelled",
        responseForRequest: (req: InteractionRequest): InteractionResponse => ({
          request_id: req.request_id ?? "test_interaction",
          status: "cancelled",
          type: "INTERACTION_RESPONSE",
        }),
      },
      {
        label: "invalid",
        responseForRequest: (req: InteractionRequest): InteractionResponse => ({
          request_id: req.request_id ?? "test_interaction",
          status: "success",
          type: "INTERACTION_RESPONSE",
        }),
      },
    ];

    for (const { responseForRequest } of cases) {
      const page = makePage({
        html: SIGNIN_HTML,
        live: false,
        postSubmitOutcomes: [
          {
            atMs: 200,
            html: VERIFICATION_HTML,
            kind: "verification",
            url: SIGNIN_URL,
          },
        ],
        url: SIGNIN_URL,
        view: "login",
      });
      const harness = makeInteractionHarness({ responseForRequest });
      await assert.rejects(
        ensureHebSession({
          page,
          postSubmitWaitClock: makePostSubmitWaitClock(page),
          sendInteraction: harness.sendInteraction,
        }),
        /heb_verification_code_not_provided/
      );
      assert.equal(harness.requests.length, 1);
      assert.equal(harness.requests[0]?.kind, "otp");
      assert.equal(state.submitClicks, 1);
      assert.equal(state.live, false);
      assert.equal(state.gotoEvents.length, 2);
    }
  });
});

test("ensureHebSession rejects cancelled or invalid otp responses without submitting the code", async () => {
  await withHebCredentials(async () => {
    const cases: Array<{
      label: string;
      responseForRequest: (req: InteractionRequest) => InteractionResponse;
    }> = [
      {
        label: "cancelled",
        responseForRequest: (req: InteractionRequest): InteractionResponse => ({
          request_id: req.request_id ?? "test_interaction",
          status: "cancelled",
          type: "INTERACTION_RESPONSE",
        }),
      },
      {
        label: "invalid",
        responseForRequest: (req: InteractionRequest): InteractionResponse => ({
          request_id: req.request_id ?? "test_interaction",
          status: "success",
          type: "INTERACTION_RESPONSE",
        }),
      },
    ];

    for (const { responseForRequest } of cases) {
      const page = makePage({
        html: VERIFICATION_HTML,
        live: false,
        url: SIGNIN_URL,
        view: "verification",
      });
      const harness = makeInteractionHarness({ responseForRequest });
      await assert.rejects(
        ensureHebSession({
          page,
          postSubmitWaitClock: makePostSubmitWaitClock(page),
          sendInteraction: harness.sendInteraction,
        }),
        /heb_verification_code_not_provided/
      );
      assert.equal(harness.requests.length, 1);
      assert.equal(harness.requests[0]?.kind, "otp");
      assert.equal(state.submitClicks, 0);
      assert.equal(state.live, false);
      assert.equal(state.gotoEvents.length, 2);
    }
  });
});

test("ensureHebSession does not treat orders URL login/loading/challenge bodies as live", async () => {
  await withHebCredentials(async () => {
    const cases: Array<{
      expectedMessage: RegExp;
      postSubmitOutcomes: PostSubmitTransition[];
    }> = [
      {
        expectedMessage: /did not finish signing in automatically/i,
        postSubmitOutcomes: [
          {
            atMs: 200,
            html: SIGNIN_HTML,
            kind: "unknown",
            url: ORDERS_URL,
          },
        ],
      },
      {
        expectedMessage: /did not render the expected login form|open the secure browser/i,
        postSubmitOutcomes: [
          {
            atMs: 200,
            html: LOADING_HTML,
            kind: "unknown",
            url: ORDERS_URL,
          },
        ],
      },
      {
        expectedMessage: PASSKEY_MSG_RE,
        postSubmitOutcomes: [
          {
            atMs: 200,
            html: PASSKEY_HTML,
            kind: "passkey",
            url: ORDERS_URL,
          },
        ],
      },
    ];

    for (const { expectedMessage, postSubmitOutcomes } of cases) {
      const page = makePage({
        html: SIGNIN_HTML,
        live: false,
        postSubmitOutcomes,
        url: SIGNIN_URL,
        view: "login",
      });
      const harness = makeInteractionHarness({ makeSessionLiveOnManualAction: false });
      await assert.rejects(
        ensureHebSession({
          page,
          postSubmitWaitClock: makePostSubmitWaitClock(page),
          sendInteraction: harness.sendInteraction,
        }),
        /heb_login_unexpected_ui/
      );
      assert.equal(state.live, false);
      assert.equal(harness.requests.length, 1);
      assert.equal(harness.requests[0]?.kind, "manual_action");
      assert.match(harness.requests[0]?.message ?? "", expectedMessage);
      assert.doesNotMatch(harness.requests[0]?.message ?? "", /owner@example\.com|synthetic-password/);
      assert.equal(state.gotoEvents.length, 2);
      assert.ok(state.gotoEvents[1]?.atMs !== undefined && state.gotoEvents[1].atMs >= 200);
    }
  });
});

test("ensureHebSession hands off passkey, CAPTCHA, Incapsula, and unknown UI to the secure browser", async () => {
  const cases: [string, PageStateKind, string][] = [
    [PASSKEY_HTML, "passkey", PASSKEY_MSG_RE.source],
    [CAPTCHA_HTML, "captcha", CAPTCHA_MSG_RE.source],
    [INCAPSULA_HTML, "incapsula", INCAPSULA_MSG_RE.source],
    [UNKNOWN_HTML, "unknown", SECURE_BROWSER_MSG_RE.source],
  ];
  for (const [html, view, pattern] of cases) {
    const page = makePage({ html, live: false, url: SIGNIN_URL, view });
    const harness = makeInteractionHarness();
    const ok = await ensureHebSession({
      page,
      postSubmitWaitClock: makePostSubmitWaitClock(page),
      sendInteraction: harness.sendInteraction,
    });
    assert.equal(ok, true);
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0]?.kind, "manual_action");
    assert.match(harness.requests[0]?.message ?? "", new RegExp(pattern, "i"));
    assert.doesNotMatch(harness.requests[0]?.message ?? "", /owner@example\.com|synthetic-password/);
  }
});

test("ensureHebSession hands off when multiple visible login roots are present", async () => {
  await withHebCredentials(async () => {
    const page = makePage({
      html: SIGNIN_HTML,
      live: false,
      forms: [createForm(), createForm()],
      url: SIGNIN_URL,
      view: "login",
    });
    const harness = makeInteractionHarness({ makeSessionLiveOnManualAction: false });
    await assert.rejects(
      ensureHebSession({
        page,
        postSubmitWaitClock: makePostSubmitWaitClock(page),
        sendInteraction: harness.sendInteraction,
      }),
      /heb_login_unexpected_ui/
    );
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0]?.kind, "manual_action");
    assert.doesNotMatch(harness.requests[0]?.message ?? "", /owner@example\.com|synthetic-password/);
  });
});

test("ensureHebSession ignores hidden and disabled distractors inside the chosen login root", async () => {
  await withHebCredentials(async () => {
    const page = makePage({
      html: OPTIONAL_LOGIN_HTML,
      live: false,
      forms: [
        createForm({
          emailControls: [createControl(false), createControl(true)],
          passwordControls: [createControl(false), createControl(true)],
          submitControls: [createControl(false), createControl(true)],
        }),
      ],
      url: SIGNIN_URL,
      view: "login",
    });
    const harness = makeInteractionHarness();
    const ok = await ensureHebSession({
      page,
      postSubmitWaitClock: makePostSubmitWaitClock(page),
      sendInteraction: harness.sendInteraction,
    });
    assert.equal(ok, true);
    assert.equal(harness.requests.length, 0);
    assert.equal(state.submitClicks, 1);
    assert.equal(state.live, true);
    assert.equal(state.url, ORDERS_URL);
  });
});

test("ensureHebSession waits through an unknown intermediate page before handing off on challenge", async () => {
  await withHebCredentials(async () => {
    const page = makePage({
      html: SIGNIN_HTML,
      live: false,
      postSubmitOutcomes: [
        {
          atMs: 200,
          html: LOADING_HTML,
          kind: "unknown",
          url: ORDERS_URL,
        },
        {
          atMs: 400,
          html: PASSKEY_HTML,
          kind: "passkey",
          url: ORDERS_URL,
        },
      ],
      url: SIGNIN_URL,
      view: "login",
    });
    const harness = makeInteractionHarness();
    const ok = await ensureHebSession({
      page,
      postSubmitWaitClock: makePostSubmitWaitClock(page),
      sendInteraction: harness.sendInteraction,
    });
    assert.equal(ok, true);
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0]?.kind, "manual_action");
    assert.match(harness.requests[0]?.message ?? "", PASSKEY_MSG_RE);
    assert.doesNotMatch(harness.requests[0]?.message ?? "", /owner@example\.com|synthetic-password/);
    assert.equal(state.gotoEvents.length, 2);
    assert.ok(state.gotoEvents[1]?.atMs !== undefined && state.gotoEvents[1].atMs >= 400);
  });
});

test("ensureHebSession falls back to manual action when the auto-login submit does not establish a session", async () => {
  await withHebCredentials(async () => {
    process.env.HEB_LOGIN_SHOULD_SUCCEED = "0";
    const page = makePage({ html: SIGNIN_HTML, live: false, url: SIGNIN_URL, view: "login" });
    const harness = makeInteractionHarness({ makeSessionLiveOnManualAction: false });
    await assert.rejects(
      ensureHebSession({
        page,
        postSubmitWaitClock: makePostSubmitWaitClock(page),
        sendInteraction: harness.sendInteraction,
      }),
      /heb_login_unexpected_ui/
    );
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0]?.kind, "manual_action");
  });
});

test("ensureHebSession times out on a stable unknown post-submit page", async () => {
  await withHebCredentials(async () => {
    const page = makePage({
      html: SIGNIN_HTML,
      live: false,
      postSubmitOutcomes: [
        {
          atMs: 200,
          html: LOADING_HTML,
          kind: "unknown",
          url: ORDERS_URL,
        },
      ],
      url: SIGNIN_URL,
      view: "login",
    });
    const harness = makeInteractionHarness({ makeSessionLiveOnManualAction: false });
    await assert.rejects(
      ensureHebSession({
        page,
        postSubmitWaitClock: makePostSubmitWaitClock(page),
        sendInteraction: harness.sendInteraction,
      }),
      /heb_login_unexpected_ui/
    );
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0]?.kind, "manual_action");
    assert.match(harness.requests[0]?.message ?? "", /did not render the expected login form|open the secure browser/i);
    assert.equal(state.gotoEvents.length, 2);
    assert.ok(state.gotoEvents[1]?.atMs !== undefined && state.gotoEvents[1].atMs >= 8000);
  });
});

test("ensureHebSession recognizes authenticated evidence that appears after the old eight-second window", async () => {
  await withHebCredentials(async () => {
    const page = makePage({
      html: SIGNIN_HTML,
      live: false,
      postSubmitOutcomes: [
        {
          atMs: 9500,
          html: LIVE_HTML,
          kind: "live",
          url: ORDERS_URL,
        },
      ],
      url: SIGNIN_URL,
      view: "login",
    });
    const harness = makeInteractionHarness();

    const ok = await ensureHebSession({
      page,
      postSubmitWaitClock: makePostSubmitWaitClock(page),
      sendInteraction: harness.sendInteraction,
    });

    assert.equal(ok, true);
    assert.equal(harness.requests.length, 0);
    assert.equal(state.submitClicks, 1);
    assert.equal(state.live, true);
    assert.ok(state.nowMs >= 9500);
  });
});

test("ensureHebSession re-resolves a remounted OTP form after a delayed owner response", async () => {
  await withHebCredentials(async () => {
    const page = makePage({
      html: VERIFICATION_HTML,
      live: false,
      postSubmitOutcome: {
        atMs: 200,
        html: LIVE_HTML,
        kind: "live",
        url: ORDERS_URL,
      },
      url: SIGNIN_URL,
      view: "verification",
    });
    const harness = makeInteractionHarness({
      responseForRequest: (req: InteractionRequest): InteractionResponse => {
        assert.equal(req.kind, "otp");
        // Model the UAT shape: the owner response arrives after the page has
        // had time to replace the original OTP root, but before the new root
        // is available to the resumed connector.
        state.nowMs += 19_000;
        state.forms = [];
        state.onWaitForTimeout = () => {
          state.forms = [createForm({ codeControls: [createControl(true)], submitControls: [] })];
          state.onWaitForTimeout = undefined;
        };
        return {
          data: { code: "123456" },
          request_id: req.request_id ?? "test_interaction",
          status: "success",
          type: "INTERACTION_RESPONSE",
        };
      },
    });

    const ok = await ensureHebSession({
      page,
      postSubmitWaitClock: makePostSubmitWaitClock(page),
      sendInteraction: harness.sendInteraction,
    });

    assert.equal(ok, true);
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0]?.kind, "otp");
    assert.equal(state.submitClicks, 1);
    assert.equal(state.live, true);
    assert.ok(state.nowMs >= 19_000);
  });
});

test("ensureHebSession keeps OTP root ambiguity fail-closed after a valid response", async () => {
  await withHebCredentials(async () => {
    const page = makePage({
      html: VERIFICATION_HTML,
      forms: [
        createForm({ codeControls: [createControl(true)], submitControls: [] }),
        createForm({ codeControls: [createControl(true)], submitControls: [] }),
      ],
      live: false,
      url: SIGNIN_URL,
      view: "verification",
    });
    const harness = makeInteractionHarness();

    await assert.rejects(
      ensureHebSession({
        page,
        postSubmitWaitClock: makePostSubmitWaitClock(page),
        sendInteraction: harness.sendInteraction,
      }),
      /heb_verification_code_input_missing/
    );
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0]?.kind, "otp");
    assert.equal(state.submitClicks, 0);
    assert.equal(state.live, false);
  });
});

// Models the exact DOM shape captured from run_1786117042566: H-E-B's
// verification-code page renders six single-digit `code_input_N` inputs
// (all sharing autocomplete="one-time-code", so VERIFICATION_CODE_SELECTOR
// matches all six) plus two type="submit" buttons ("Verify" and "Back")
// inside the same <form>, instead of the single named `code`/`otp` field the
// prior selector-uniqueness check assumed.
function splitCodeForm(): FakeFormState {
  return createForm({
    codeControls: [
      createControl(true),
      createControl(true),
      createControl(true),
      createControl(true),
      createControl(true),
      createControl(true),
    ],
    submitControls: [createControl(true, true, "Verify"), createControl(true, true, "Back")],
  });
}

test("ensureHebSession fills a split six-digit OTP form one digit per input and clicks Verify, not Back", async () => {
  await withHebCredentials(async () => {
    const page = makePage({
      html: VERIFICATION_HTML,
      forms: [splitCodeForm()],
      live: false,
      url: SIGNIN_URL,
      view: "verification",
    });
    const harness = makeInteractionHarness();

    const ok = await ensureHebSession({
      page,
      postSubmitWaitClock: makePostSubmitWaitClock(page),
      sendInteraction: harness.sendInteraction,
    });

    assert.equal(ok, true);
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0]?.kind, "otp");
    assert.equal(state.submitClicks, 1);
    assert.equal(state.live, true);
  });
});

test("ensureHebSession reports a clear provider-rejected error when the split OTP form remains visible after submit", async () => {
  await withHebCredentials(async () => {
    process.env.HEB_LOGIN_SHOULD_SUCCEED = "0";
    const page = makePage({
      html: VERIFICATION_HTML,
      forms: [splitCodeForm()],
      live: false,
      postSubmitOutcomes: [],
      url: SIGNIN_URL,
      view: "verification",
    });
    const harness = makeInteractionHarness();

    await assert.rejects(
      ensureHebSession({
        page,
        postSubmitWaitClock: makePostSubmitWaitClock(page),
        sendInteraction: harness.sendInteraction,
      }),
      /heb_verification_code_not_accepted/
    );
    assert.equal(harness.requests.length, 1);
    assert.equal(state.submitClicks, 1);
    assert.equal(state.live, false);
  });
});
