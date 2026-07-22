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
const LOADING_HTML = "<html><body><main><p>Loading your orders...</p></main></body></html>";
const VERIFICATION_HTML = readFileSync(
  new URL("../../connectors/heb/__fixtures__/verification-code-page.html", import.meta.url),
  "utf8"
);
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

type PageStateKind = "live" | "login" | "incapsula" | "passkey" | "verification" | "captcha" | "unknown";
type ControlKind = "email" | "password" | "submit" | "code";
type PostSubmitOutcomeKind = Exclude<PageStateKind, "login">;

interface PostSubmitTransition {
  atMs: number;
  html?: string;
  kind: PostSubmitOutcomeKind;
  url?: string;
}

interface FakeControlState {
  enabled: boolean;
  filledValue?: string;
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
    email?: string;
    password?: string;
  };
  visible: boolean;
}

interface FakePageState {
  forms: FakeFormState[];
  gotoEvents: Array<{
    atMs: number;
    url: string;
  }>;
  html: string;
  live: boolean;
  loginHtml: string;
  nowMs: number;
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

function createControl(visible: boolean, enabled = visible): FakeControlState {
  return { enabled, visible };
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
  const outcome = state.postSubmitOutcomes[0];
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
    "click" | "count" | "fill" | "first" | "inputValue" | "isEnabled" | "isVisible" | "locator" | "nth" | "press"
  > = {
    click: (): Promise<void> => Promise.resolve(),
    count: async (): Promise<number> => 0,
    fill: (): Promise<void> => Promise.resolve(),
    first(): Locator {
      return locator as Locator;
    },
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
    const canSucceed =
      process.env.HEB_LOGIN_SHOULD_SUCCEED !== "0" &&
      Boolean(form.values.code || (form.values.email && form.values.password));
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
    "click" | "count" | "fill" | "first" | "inputValue" | "isEnabled" | "isVisible" | "locator" | "nth" | "press"
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
        form.values.code = value;
      } else if (kind === "password") {
        form.values.password = value;
      }
      return Promise.resolve();
    },
    first(): Locator {
      return locator as Locator;
    },
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
    "click" | "count" | "fill" | "first" | "inputValue" | "isEnabled" | "isVisible" | "locator" | "nth" | "press"
  > = {
    click: (): Promise<void> => Promise.resolve(),
    count: async (): Promise<number> => controls.length,
    fill: (): Promise<void> => Promise.resolve(),
    first(): Locator {
      return controls[0] ? controlLocator(form, formIndex, kind, 0) : emptyLocator();
    },
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
    "click" | "count" | "fill" | "first" | "inputValue" | "isEnabled" | "isVisible" | "locator" | "nth" | "press"
  > = {
    click: (): Promise<void> => Promise.resolve(),
    count: async (): Promise<number> => 1,
    fill: (): Promise<void> => Promise.resolve(),
    first(): Locator {
      return locator as Locator;
    },
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
  let forms = initial.forms;
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
    forms,
    html: initial.html ?? UNKNOWN_HTML,
    gotoEvents: [],
    live: initial.live ?? false,
    loginHtml: initial.html ?? SIGNIN_HTML,
    nowMs: 0,
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
      return emptyLocator();
    },
    url: (): string => state.url,
    waitForTimeout: (ms: number): Promise<void> => {
      state.nowMs += ms;
      maybeApplyPostSubmitOutcome();
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
