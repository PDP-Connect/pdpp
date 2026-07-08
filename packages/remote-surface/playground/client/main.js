import {
  createFormOverlayReconciliationState,
  formFieldToControlHint,
  planFormOverlaySpecialKeyCommit,
  planFormOverlayValueCommit,
  reconcileFormOverlayFields,
} from "/remote-surface/client/form-overlay/planner.js";
import { createContainerFitStreamViewerSurface } from "/remote-surface/client/stream-viewer-surface.js";
import { createViewportMatchController } from "/remote-surface/client/viewport-match-controller.js";

const workspace = document.getElementById("workspace");
const viewerShell = document.getElementById("viewer-shell");
const stageFrame = document.getElementById("stage-frame");
const stage = document.getElementById("stage");
const streamCanvas = document.getElementById("stream");
const overlayCanvas = document.getElementById("overlay");
const formOverlayLayer = document.getElementById("form-overlay-layer");
const formOverlayToggle = document.getElementById("form-overlay-toggle");
const viewerModeLabel = document.getElementById("viewer-mode-label");
const containerClose = document.getElementById("container-close");
const actionStrip = document.querySelector(".action-strip");
const panels = document.querySelector(".panels");
const keyboardProxy = document.getElementById("keyboard-proxy");
const emptyState = document.getElementById("empty-state");
const statusText = document.getElementById("connection-status");
const quality = document.getElementById("quality");
const intrinsicSize = document.getElementById("intrinsic-size");
const containerMode = document.getElementById("container-mode");
const checklistEl = document.getElementById("checklist");
const inputLogEl = document.getElementById("input-log");
const pointerMetricsEl = document.getElementById("pointer-metrics");
const geometryMetricsEl = document.getElementById("geometry-metrics");
const viewportMatchMetricsEl = document.getElementById("viewport-match-metrics");
const clearProbe = document.getElementById("clear-probe");

const CHECKS = [
  ["oneTap", "One tap equals one click"],
  ["noLongPressSave", "No long-press save image"],
  ["keyboardStable", "Keyboard opens and stays"],
  ["emailEntry", "Email entry"],
  ["passwordEntry", "Password entry"],
  ["otpEntry", "Numeric 2FA entry"],
  ["backspaceEnter", "Backspace and enter"],
  ["viewportSurvivesKeyboard", "Viewport survives keyboard"],
  ["streamStable", "Stream stable"],
];

const state = {
  ws: null,
  frameCount: 0,
  frameWindow: [],
  captureSize: { width: 0, height: 0 },
  viewportSize: { width: 390, height: 844 },
  displayRect: null,
  pointer: null,
  cursor: null,
  snapshot: null,
  inputLog: [],
  ui: {
    containerMode: "inline",
    initialized: false,
  },
  viewportMatch: {
    telemetry: null,
  },
  formOverlay: {
    enabled: false,
    controls: new Map(),
    reconciliation: createFormOverlayReconciliationState(),
    snapshot: { type: "form_fields", fields: [] },
  },
  checks: Object.fromEntries(CHECKS.map(([id]) => [id, { state: "pending", evidence: "" }])),
};

let viewerSurface = null;
let viewportMatchController = null;

function send(message) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(message));
  }
}

function setStatus(text) {
  statusText.textContent = text;
}

function setCheck(id, nextState, evidence = "") {
  const check = state.checks[id];
  if (!check) return;
  if (check.state === "pass" && nextState === "pending") return;
  check.state = nextState;
  check.evidence = evidence;
  renderChecklist();
}

function renderChecklist() {
  checklistEl.replaceChildren(...CHECKS.map(([id, label]) => {
    const item = document.createElement("li");
    item.className = "check";
    item.dataset.state = state.checks[id].state;
    item.dataset.checkId = id;
    item.dataset.testid = `check-${id}`;
    const body = document.createElement("div");
    body.textContent = label;
    const evidence = document.createElement("span");
    evidence.textContent = state.checks[id].evidence || state.checks[id].state;
    body.append(document.createElement("br"), evidence);
    item.append(body);
    return item;
  }));
}

function metricRows(rows) {
  const nodes = [];
  for (const [key, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = value;
    nodes.push(dt, dd);
  }
  return nodes;
}

function formatViewport(viewport) {
  if (!viewport) return "none";
  return `${viewport.width} x ${viewport.height}`;
}

function getViewportMatchDefaults() {
  const preset = viewportPreset(intrinsicSize.value);
  const mobile = preset.width < 1000;
  return {
    deviceScaleFactor: mobile ? 2 : 1,
    hasTouch: mobile,
    mobile,
    userAgent: navigator.userAgent,
  };
}

function renderViewportMatchTelemetry() {
  const telemetry = state.viewportMatch.telemetry ?? viewportMatchController?.getTelemetry?.() ?? null;
  if (!telemetry) {
    viewportMatchMetricsEl.replaceChildren(...metricRows([["matched", "pending"]]));
    return;
  }
  const bars = telemetry.letterboxBars;
  viewportMatchMetricsEl.replaceChildren(...metricRows([
    ["target", formatViewport(telemetry.targetViewport)],
    ["actual", formatViewport(telemetry.actualViewport)],
    ["container", telemetry.containerBox ? `${Math.round(telemetry.containerBox.width)} x ${Math.round(telemetry.containerBox.height)}` : "none"],
    ["bars", `${Math.round(bars.left)}, ${Math.round(bars.top)}, ${Math.round(bars.right)}, ${Math.round(bars.bottom)} px`],
    ["max bar", `${Math.round(telemetry.maxLetterboxPx)} px`],
    ["matched", telemetry.matched ? "yes" : "no"],
    ["decision", telemetry.transition ? `${telemetry.transition.remoteResize}:${telemetry.transition.kind}` : "none"],
    ["error", telemetry.lastError ?? "none"],
  ]));
}

function viewportPreset(value) {
  if (value === "desktop") {
    return { width: 1280, height: 720 };
  }
  return { width: 390, height: 844 };
}

function getGeometry() {
  return viewerSurface?.getGeometry() ?? null;
}

function applyGeometry() {
  const geometry = getGeometry();
  if (!geometry) return;
  const localDisplay = {
    left: geometry.displayRect.left - geometry.containerBox.left - stageFrame.clientLeft,
    top: geometry.displayRect.top - geometry.containerBox.top - stageFrame.clientTop,
    width: geometry.displayRect.width,
    height: geometry.displayRect.height,
  };
  state.displayRect = geometry.displayRect;
  for (const canvas of [streamCanvas, overlayCanvas]) {
    canvas.style.left = `${localDisplay.left}px`;
    canvas.style.top = `${localDisplay.top}px`;
    canvas.style.width = `${localDisplay.width}px`;
    canvas.style.height = `${localDisplay.height}px`;
  }
  overlayCanvas.width = Math.max(1, Math.round(localDisplay.width));
  overlayCanvas.height = Math.max(1, Math.round(localDisplay.height));
  const maxBar = Math.max(
    geometry.letterboxBars.left,
    geometry.letterboxBars.right,
    geometry.letterboxBars.top,
    geometry.letterboxBars.bottom
  );
  geometryMetricsEl.replaceChildren(...metricRows([
    ["container", `${Math.round(geometry.containerBox.width)} x ${Math.round(geometry.containerBox.height)}`],
    ["viewport", `${geometry.viewport.width} x ${geometry.viewport.height}`],
    ["display", `${Math.round(geometry.displayRect.width)} x ${Math.round(geometry.displayRect.height)}`],
    ["scale", geometry.scale.toFixed(3)],
    ["bars", `${Math.round(geometry.letterboxBars.left)}, ${Math.round(geometry.letterboxBars.top)}, ${Math.round(geometry.letterboxBars.right)}, ${Math.round(geometry.letterboxBars.bottom)} px`],
    ["max bar", `${Math.round(maxBar)} px`],
    ["1:1", geometry.isOneToOne ? "yes" : "no"],
  ]));
  renderViewportMatchTelemetry();
  drawOverlay();
  repositionFormOverlayControls();
}

function mapClientToRemote(clientX, clientY) {
  const geometry = getGeometry();
  const stageRect = stageFrame.getBoundingClientRect();
  if (!geometry) return null;
  const localX = clientX - stageRect.left;
  const localY = clientY - stageRect.top;
  const remote = viewerSurface?.mapClientPointToStream(clientX, clientY) ?? null;
  if (!remote) return null;
  return {
    local: { x: Math.round(localX - stageFrame.clientLeft), y: Math.round(localY - stageFrame.clientTop) },
    remote,
  };
}

function remoteToOverlay(remote) {
  const geometry = getGeometry();
  if (!geometry) return null;
  const width = geometry.displayRect.width;
  const height = geometry.displayRect.height;
  return {
    x: (remote.x / geometry.viewport.width) * width,
    y: (remote.y / geometry.viewport.height) * height,
  };
}

function drawCross(ctx, point, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(point.x - 8, point.y);
  ctx.lineTo(point.x + 8, point.y);
  ctx.moveTo(point.x, point.y - 8);
  ctx.lineTo(point.x, point.y + 8);
  ctx.stroke();
}

function drawOverlay() {
  const ctx = overlayCanvas.getContext("2d");
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  const geometry = getGeometry();
  if (!geometry) return;
  const localDisplay = {
    left: geometry.displayRect.left - geometry.containerBox.left - stageFrame.clientLeft,
    top: geometry.displayRect.top - geometry.containerBox.top - stageFrame.clientTop,
    width: geometry.displayRect.width,
    height: geometry.displayRect.height,
  };
  const scaleX = overlayCanvas.width / localDisplay.width;
  const scaleY = overlayCanvas.height / localDisplay.height;
  ctx.save();
  ctx.scale(scaleX, scaleY);
  if (state.cursor) {
    ctx.fillStyle = "oklch(0.58 0.12 54 / 0.9)";
    ctx.beginPath();
    ctx.arc(state.cursor.x - localDisplay.left, state.cursor.y - localDisplay.top, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  if (state.pointer) {
    const dispatched = remoteToOverlay(state.pointer.dispatched);
    const observed = state.pointer.observed ? remoteToOverlay(state.pointer.observed) : null;
    if (dispatched) drawCross(ctx, dispatched, "oklch(0.52 0.14 238)");
    if (observed) drawCross(ctx, observed, "oklch(0.57 0.12 156)");
  }
  ctx.restore();
}

function updatePointerMetrics(result) {
  state.pointer = result;
  pointerMetricsEl.replaceChildren(...metricRows([
    ["intended", `${result.intended.x}, ${result.intended.y}`],
    ["dispatched", `${result.dispatched.x}, ${result.dispatched.y}`],
    ["observed", result.observed ? `${result.observed.x}, ${result.observed.y}` : "none"],
    ["error", result.pxError === null ? "n/a" : `${result.pxError.toFixed(2)} px`],
  ]));
  if (result.pxError !== null && result.pxError <= 1.5) {
    setCheck("oneTap", "pass", `${result.pxError.toFixed(2)} px error`);
  } else if (result.pxError !== null) {
    setCheck("oneTap", "fail", `${result.pxError.toFixed(2)} px error`);
  }
  drawOverlay();
}

function summarizeSnapshot(snapshot) {
  const values = snapshot?.values ?? {};
  return `email=${values.email ?? ""} password=${values.password ?? ""} otp=${values.otp ?? ""} active=${snapshot?.active?.id ?? ""}`;
}

function updateChecksFromSnapshot(snapshot) {
  const values = snapshot?.values ?? {};
  if (values.email === "tim@example.com") setCheck("emailEntry", "pass", values.email);
  if (values.password === "correct horse") setCheck("passwordEntry", "pass", `${values.password.length} chars`);
  if (/^\d{6}$/.test(values.otp ?? "") || values.otp === "12345") setCheck("otpEntry", "pass", values.otp);
  if ((snapshot?.submitCount ?? 0) > 0) setCheck("backspaceEnter", "pass", snapshot.effect ?? "submitted");
}

function appendInputResult(result) {
  state.snapshot = result.snapshot;
  updateChecksFromSnapshot(result.snapshot);
  const telemetry = Array.isArray(result.telemetry) ? result.telemetry : [];
  const paths = result.inputPaths?.length ? result.inputPaths : [result.inputPath ?? "unknown"];
  const chars = telemetry.map((item) => `${JSON.stringify(item.text)}:${item.path}`).join(" ");
  const entry = {
    chars,
    handler: result.handler,
    path: paths.join(", "),
    text: result.text || result.key || "",
    timestamp: result.timestamp,
    remote: summarizeSnapshot(result.snapshot),
  };
  state.inputLog.unshift(entry);
  state.inputLog = state.inputLog.slice(0, 30);
  inputLogEl.replaceChildren(...state.inputLog.map((item) => {
    const row = document.createElement("div");
    row.className = "log-entry";
    const time = new Date(item.timestamp).toISOString().split("T")[1].replace("Z", "");
    row.textContent = `${time} ${item.handler} ${item.path} ${JSON.stringify(item.text)}`;
    const remote = document.createElement("span");
    remote.textContent = item.chars ? `${item.remote} paths=${item.chars}` : item.remote;
    row.append(remote);
    return row;
  }));
}

async function drawFrame(message) {
  const bytes = Uint8Array.from(atob(message.data), (char) => char.charCodeAt(0));
  const blob = new Blob([bytes], { type: "image/jpeg" });
  const bitmap = await createImageBitmap(blob);
  streamCanvas.width = bitmap.width;
  streamCanvas.height = bitmap.height;
  state.captureSize = { width: bitmap.width, height: bitmap.height };
  state.viewportSize = {
    width: Math.round(Number(message.metadata.deviceWidth) || bitmap.width),
    height: Math.round(Number(message.metadata.deviceHeight) || bitmap.height),
  };
  viewerSurface?.setViewport({
    width: state.viewportSize.width,
    height: state.viewportSize.height,
    deviceScaleFactor: Number(message.metadata.deviceScaleFactor) || 1,
    mobile: Boolean(message.metadata.mobile),
    hasTouch: Boolean(message.metadata.hasTouch),
    screenWidth: Number(message.metadata.screenWidth) || undefined,
    screenHeight: Number(message.metadata.screenHeight) || undefined,
    userAgent: typeof message.metadata.userAgent === "string" ? message.metadata.userAgent : "",
  });
  const ctx = streamCanvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  emptyState.hidden = true;
  state.frameCount += 1;
  state.frameWindow.push(performance.now());
  const cutoff = performance.now() - 3000;
  state.frameWindow = state.frameWindow.filter((value) => value >= cutoff);
  if (state.frameWindow.length >= 6) {
    setCheck("streamStable", "pass", `${state.frameWindow.length} frames / 3s`);
  }
  applyGeometry();
}

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${location.host}/surface`);
  state.ws = ws;
  ws.addEventListener("open", () => {
    setStatus("Connected");
    send({ type: "hello" });
    applyIntrinsicSizePreset();
  });
  ws.addEventListener("close", () => {
    setStatus("Disconnected");
    setTimeout(connect, 800);
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "ready" || message.type === "snapshot") {
      state.snapshot = message.snapshot;
      updateChecksFromSnapshot(message.snapshot);
      return;
    }
    if (message.type === "frame") {
      void drawFrame(message);
      return;
    }
    if (message.type === "form_fields") {
      renderFormOverlaySnapshot(message.snapshot);
      return;
    }
    if (message.type === "pointer_result") {
      state.snapshot = message.snapshot;
      updateChecksFromSnapshot(message.snapshot);
      updatePointerMetrics(message);
      keyboardProxy.focus();
      setTimeout(() => {
        if (document.activeElement === keyboardProxy) {
          setCheck("keyboardStable", "pass", "proxy retained focus");
        }
      }, 250);
      return;
    }
    if (message.type === "input_result") {
      appendInputResult(message);
      return;
    }
    if (message.type === "error") {
      setStatus(message.message);
    }
  });
}

function clickStage(event) {
  if (event.target.closest?.(".form-overlay-field")) return;
  const mapped = mapClientToRemote(event.clientX, event.clientY);
  if (!mapped) return;
  state.cursor = mapped.local;
  drawOverlay();
  send({
    type: "pointer_click",
    local: mapped.local,
    remote: mapped.remote,
    pointerType: event.pointerType === "mouse" ? "mouse" : "touch",
  });
  stage.focus();
  keyboardProxy.focus();
}

function sendRawKey(event) {
  if (event.target.closest?.(".form-overlay-field")) return;
  if (event.key === "v" && (event.ctrlKey || event.metaKey)) return;
  if (event.key === "Unidentified") return;
  if (event.key.length === 1 || event.key === "Backspace" || event.key === "Enter") {
    event.preventDefault();
  }
  if (event.key === "Backspace" || event.key === "Enter") {
    send({ type: "keysym", handler: "raw-keydown", key: event.key });
    return;
  }
  send({ type: "raw_key", key: event.key, code: event.code, modifiers: getModifiers(event) });
}

function getModifiers(event) {
  let value = 0;
  if (event.altKey) value |= 1;
  if (event.ctrlKey) value |= 2;
  if (event.metaKey) value |= 4;
  if (event.shiftKey) value |= 8;
  return value;
}

function getModifierNames(event) {
  const modifiers = [];
  if (event.altKey) modifiers.push("Alt");
  if (event.ctrlKey) modifiers.push("Control");
  if (event.metaKey) modifiers.push("Meta");
  if (event.shiftKey) modifiers.push("Shift");
  return modifiers;
}

function commitText(handler, text) {
  if (!text) return;
  send({ type: "text_commit", handler, text });
}

function isFormOverlayEnabled() {
  return state.formOverlay.enabled === true;
}

function fieldSelectorId(selector) {
  return selector.startsWith("#") ? selector.slice(1) : selector;
}

function remoteFieldToLocalBox(field) {
  const geometry = getGeometry();
  if (!geometry) return null;
  const projected = viewerSurface?.projectStreamViewportRectToClientBox(field) ?? null;
  if (!projected) return null;
  return {
    left: projected.left - geometry.containerBox.left - stageFrame.clientLeft,
    top: projected.top - geometry.containerBox.top - stageFrame.clientTop,
    width: projected.width,
    height: projected.height,
  };
}

function findOverlayEntryById(id) {
  return state.formOverlay.reconciliation.entries.find((entry) => entry.field.id === id || entry.field.name === id) ?? null;
}

function controlForEntry(entry) {
  return state.formOverlay.controls.get(entry.overlayId)?.el ?? null;
}

function createOverlayControl(entry) {
  const hint = formFieldToControlHint(entry.field);
  const el = document.createElement(hint.element);
  el.className = "form-overlay-field";
  el.dataset.overlayId = entry.overlayId;
  el.dataset.fieldId = entry.field.id || entry.field.name || entry.overlayId;
  el.dataset.testid = `overlay-field-${el.dataset.fieldId}`;
  el.autocapitalize = "none";
  el.autocomplete = hint.autocomplete;
  el.spellcheck = false;
  if (hint.element === "input") {
    const safeInputTypes = new Set(["email", "number", "password", "search", "tel", "text", "url"]);
    el.type = safeInputTypes.has(hint.inputType) ? hint.inputType : "text";
  }
  el.addEventListener("compositionstart", () => {
    const control = state.formOverlay.controls.get(el.dataset.overlayId);
    if (control) control.isComposing = true;
  });
  el.addEventListener("compositionend", () => {
    const control = state.formOverlay.controls.get(el.dataset.overlayId);
    if (!control) return;
    control.isComposing = false;
    commitOverlayValue(el);
  });
  el.addEventListener("input", () => commitOverlayValue(el));
  el.addEventListener("keydown", (event) => {
    const control = state.formOverlay.controls.get(el.dataset.overlayId);
    if (!control) return;
    const plan = planFormOverlaySpecialKeyCommit({
      code: event.code,
      fieldState: control.entry,
      isComposing: control.isComposing,
      key: event.key,
      modifiers: getModifierNames(event),
    });
    if (plan.status !== "committed") return;
    event.preventDefault();
    send({ type: "form_overlay_commit", operations: plan.operations });
  });
  formOverlayLayer.append(el);
  return el;
}

function updateOverlayControl(entry) {
  let control = state.formOverlay.controls.get(entry.overlayId);
  const el = control?.el ?? createOverlayControl(entry);
  const hint = formFieldToControlHint(entry.field);
  el.disabled = hint.disabled;
  el.readOnly = hint.readOnly;
  el.placeholder = entry.field.placeholder || "";
  if (document.activeElement !== el && el.value !== entry.field.value) {
    el.value = entry.field.value;
    el.dataset.previousValue = entry.field.value;
  }
  const box = remoteFieldToLocalBox(entry.field);
  el.hidden = !box || !isFormOverlayEnabled();
  if (box) {
    el.style.left = `${box.left}px`;
    el.style.top = `${box.top}px`;
    el.style.width = `${box.width}px`;
    el.style.height = `${box.height}px`;
    el.style.fontSize = `${Math.max(12, Math.min(20, box.height * 0.45))}px`;
  }
  state.formOverlay.controls.set(entry.overlayId, {
    el,
    entry,
    isComposing: control?.isComposing ?? false,
  });
}

function renderFormOverlaySnapshot(snapshot) {
  state.formOverlay.snapshot = snapshot;
  const result = reconcileFormOverlayFields(state.formOverlay.reconciliation, snapshot.fields ?? []);
  state.formOverlay.reconciliation = result.state;
  const liveIds = new Set(result.state.entries.map((entry) => entry.overlayId));
  for (const [overlayId, control] of state.formOverlay.controls) {
    if (!liveIds.has(overlayId)) {
      control.el.remove();
      state.formOverlay.controls.delete(overlayId);
    }
  }
  for (const entry of result.state.entries) {
    updateOverlayControl(entry);
  }
  formOverlayLayer.classList.toggle("form-overlay-disabled", !isFormOverlayEnabled());
}

function repositionFormOverlayControls() {
  for (const entry of state.formOverlay.reconciliation.entries) {
    updateOverlayControl(entry);
  }
}

function commitOverlayValue(el) {
  const control = state.formOverlay.controls.get(el.dataset.overlayId);
  if (!control) return;
  const previousValue = el.dataset.previousValue ?? "";
  const plan = planFormOverlayValueCommit({
    currentValue: el.value,
    fieldState: control.entry,
    isComposing: control.isComposing,
    previousValue,
  });
  if (plan.status !== "committed") return;
  el.dataset.previousValue = el.value;
  send({ type: "form_overlay_commit", operations: plan.operations });
}

function focusOverlayField(selector) {
  const entry = findOverlayEntryById(fieldSelectorId(selector));
  if (!entry) return false;
  const control = controlForEntry(entry);
  if (!control) return false;
  control.focus({ preventScroll: true });
  setTimeout(() => {
    if (document.activeElement === control) {
      setCheck("keyboardStable", "pass", "overlay control focused");
    }
  }, 250);
  return true;
}

function setOverlayFieldValue(selector, value) {
  const entry = findOverlayEntryById(fieldSelectorId(selector));
  if (!entry) return false;
  const control = controlForEntry(entry);
  if (!control) return false;
  control.focus({ preventScroll: true });
  control.value = value;
  commitOverlayValue(control);
  return true;
}

function pressOverlaySpecialKey(selector, key, code = key) {
  const entry = findOverlayEntryById(fieldSelectorId(selector));
  if (!entry) return false;
  const control = controlForEntry(entry);
  const stateEntry = state.formOverlay.controls.get(entry.overlayId);
  if (!control || !stateEntry) return false;
  control.focus({ preventScroll: true });
  const plan = planFormOverlaySpecialKeyCommit({ key, code, fieldState: stateEntry.entry });
  if (plan.status !== "committed") return false;
  send({ type: "form_overlay_commit", operations: plan.operations });
  return true;
}

function focusProxy(inputMode = "text") {
  keyboardProxy.inputMode = inputMode;
  keyboardProxy.value = "";
  keyboardProxy.focus();
}

function syntheticText(text, inputMode = "text") {
  focusProxy(inputMode);
  commitText("synthetic", text);
}

function clickSelector(selector) {
  send({ type: "click_selector", selector });
  focusProxy(selector === "#otp" ? "numeric" : selector === "#email" ? "email" : "text");
}

async function runAction(action) {
  if (action === "tap-email") {
    if (isFormOverlayEnabled()) {
      clickSelector("#email");
      setTimeout(() => focusOverlayField("#email"), 120);
      return;
    }
    clickSelector("#email");
    return;
  }
  if (action === "type-email") {
    if (isFormOverlayEnabled() && setOverlayFieldValue("#email", "tim@example.com")) return;
    clickSelector("#email");
    setTimeout(() => syntheticText("tim@example.com", "email"), 80);
    return;
  }
  if (action === "type-password") {
    if (isFormOverlayEnabled() && setOverlayFieldValue("#password", "correct horse")) return;
    clickSelector("#password");
    setTimeout(() => syntheticText("correct horse"), 80);
    return;
  }
  if (action === "type-otp") {
    if (isFormOverlayEnabled() && setOverlayFieldValue("#otp", "123456")) return;
    clickSelector("#otp");
    setTimeout(() => syntheticText("123456", "numeric"), 80);
    return;
  }
  if (action === "backspace-enter") {
    if (isFormOverlayEnabled()) {
      const entry = findOverlayEntryById("otp");
      const control = entry ? controlForEntry(entry) : null;
      if (control) {
        control.value = control.value.slice(0, -1);
        commitOverlayValue(control);
        setTimeout(() => pressOverlaySpecialKey("#otp", "Enter", "Enter"), 80);
        return;
      }
    }
    clickSelector("#otp");
    setTimeout(() => {
      send({ type: "keysym", handler: "synthetic", key: "Backspace" });
      setTimeout(() => send({ type: "keysym", handler: "synthetic", key: "Enter" }), 80);
    }, 80);
    return;
  }
  if (action === "keyboard-inset") {
    focusProxy();
    stageFrame.classList.toggle("keyboard-inset");
    requestAnimationFrame(() => {
      applyGeometry();
      const geometry = getGeometry();
      if (
        geometry &&
        geometry.displayRect.width > 40 &&
        geometry.displayRect.height > 40 &&
        document.activeElement === keyboardProxy
      ) {
        setCheck(
          "viewportSurvivesKeyboard",
          "pass",
          `${Math.round(geometry.displayRect.width)} x ${Math.round(geometry.displayRect.height)}`
        );
      }
    });
  }
}

function syncContainerModeUi() {
  const mode = state.ui.containerMode;
  workspace.dataset.containerMode = mode;
  viewerShell.dataset.containerMode = mode;
  viewerModeLabel.textContent = mode === "modal" ? "Modal container" : mode === "odd" ? "Odd-shaped container" : "Inline container";
  containerClose.hidden = mode !== "modal";
  containerMode.value = mode;
}

function handleStageKeydown(event) {
  if (event.key === "Escape" && state.ui.containerMode === "modal") {
    event.preventDefault();
    setContainerMode("inline");
    return;
  }
  sendRawKey(event);
}

function setContainerMode(nextMode) {
  if (state.ui.containerMode === nextMode) {
    return;
  }
  state.ui.containerMode = nextMode;
  syncContainerModeUi();
  requestAnimationFrame(() => {
    applyGeometry();
    viewportMatchController?.requestMatch();
  });
}

viewerSurface = createContainerFitStreamViewerSurface(stageFrame, viewportPreset(intrinsicSize.value), {
  onGeometryChange: applyGeometry,
});
viewportMatchController = createViewportMatchController({
  surface: viewerSurface,
  applyViewport(viewport) {
    if (state.ws?.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not ready");
    }
    send({
      type: "resize",
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor,
      mobile: viewport.mobile,
    });
  },
  options: {
    debounceMs: 180,
    viewportDefaults: getViewportMatchDefaults,
  },
});
viewportMatchController.subscribe((telemetry) => {
  state.viewportMatch.telemetry = telemetry;
  renderViewportMatchTelemetry();
});

stage.addEventListener("pointermove", (event) => {
  const mapped = mapClientToRemote(event.clientX, event.clientY);
  if (!mapped) return;
  state.cursor = mapped.local;
  drawOverlay();
});
stage.addEventListener("click", clickStage);
stage.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  setCheck("noLongPressSave", "pass", "context menu suppressed");
});
stage.addEventListener("keydown", handleStageKeydown);
containerClose.addEventListener("click", () => {
  setContainerMode("inline");
});
keyboardProxy.addEventListener("beforeinput", (event) => {
  if (event.inputType === "insertText" && event.data) {
    event.preventDefault();
    commitText("ime-commit", event.data);
    keyboardProxy.value = "";
  }
});
keyboardProxy.addEventListener("compositionend", (event) => {
  if (event.data) {
    commitText("ime-commit", event.data);
    keyboardProxy.value = "";
  }
});
keyboardProxy.addEventListener("paste", (event) => {
  event.preventDefault();
  const text = event.clipboardData?.getData("text") ?? "";
  commitText("paste", text);
});
keyboardProxy.addEventListener("focus", () => {
  setTimeout(() => {
    if (document.activeElement === keyboardProxy) {
      setCheck("keyboardStable", "pass", "proxy focused");
    }
  }, 250);
});
actionStrip.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (button) void runAction(button.dataset.action);
});
quality.addEventListener("input", () => {
  send({ type: "set_quality", quality: Number(quality.value) });
});
intrinsicSize.addEventListener("change", () => {
  applyIntrinsicSizePreset();
});
containerMode.addEventListener("change", () => {
  setContainerMode(containerMode.value);
});
clearProbe.addEventListener("click", () => {
  send({ type: "clear_probe" });
  state.inputLog = [];
  inputLogEl.replaceChildren();
});
formOverlayToggle.addEventListener("change", () => {
  state.formOverlay.enabled = formOverlayToggle.checked;
  renderFormOverlaySnapshot(state.formOverlay.snapshot);
  if (!state.formOverlay.enabled) {
    keyboardProxy.focus();
  }
});
document.addEventListener(
  "keydown",
  (event) => {
    if (event.key !== "Escape" || state.ui.containerMode !== "modal") return;
    event.preventDefault();
    event.stopPropagation();
    setContainerMode("inline");
  },
  true,
);
window.addEventListener("resize", () => {
  if (state.ui.containerMode === "modal") {
    syncContainerModeUi();
  }
  requestAnimationFrame(() => viewportMatchController?.requestMatch());
});

window.__remoteSurfacePlayground = {
  pressOverlaySpecialKey,
  setOverlayFieldValue,
};

function applyIntrinsicSizePreset() {
  const preset = viewportPreset(intrinsicSize.value);
  state.viewportSize = preset;
  const mobile = preset.width < 1000;
  viewerSurface?.setViewport({ width: preset.width, height: preset.height, deviceScaleFactor: mobile ? 2 : 1, mobile, hasTouch: mobile });
  viewportMatchController?.requestMatch();
}

syncContainerModeUi();
containerMode.value = state.ui.containerMode;
requestAnimationFrame(() => {
  applyIntrinsicSizePreset();
  applyGeometry();
});
renderChecklist();
connect();
setInterval(() => send({ type: "snapshot" }), 1500);
