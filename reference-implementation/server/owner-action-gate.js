const AUTOMATION_BLOCKING_OWNER_ACTION_KINDS = new Set(["add_info", "reauth"]);
const AUTOMATION_BLOCKING_OWNER_ACTION_URGENCIES = new Set(["now", "overdue"]);

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function actionSatisfactionKind(action) {
  const satisfiedWhen = action && typeof action === "object" ? action.satisfied_when : null;
  const kind = satisfiedWhen && typeof satisfiedWhen === "object" ? satisfiedWhen.kind : null;
  return readString(kind);
}

function actionSurfaceKind(action) {
  const surface = action && typeof action === "object" ? action.surface : null;
  const kind = surface && typeof surface === "object" ? surface.kind : null;
  return readString(kind) ?? "unknown";
}

function isAutomationBlockingOwnerAction(action) {
  if (!action || typeof action !== "object") {
    return false;
  }
  const kind = readString(action.kind);
  const audience = readString(action.audience);
  const urgency = readString(action.urgency);
  const satisfiedWhen = actionSatisfactionKind(action);
  return (
    audience === "owner" &&
    kind !== null &&
    AUTOMATION_BLOCKING_OWNER_ACTION_KINDS.has(kind) &&
    urgency !== null &&
    AUTOMATION_BLOCKING_OWNER_ACTION_URGENCIES.has(urgency) &&
    satisfiedWhen !== null &&
    satisfiedWhen !== "none"
  );
}

export function unresolvedOwnerActionEvidenceFromSummary(summary, routeId = null) {
  if (!summary || typeof summary !== "object") {
    return null;
  }
  const actions = summary.rendered_verdict?.required_actions;
  if (!Array.isArray(actions)) {
    return null;
  }
  const action = actions.find(isAutomationBlockingOwnerAction);
  if (!action) {
    return null;
  }
  const connectionId =
    readString(summary.connection_id) ??
    readString(summary.connector_instance_id) ??
    readString(routeId) ??
    readString(summary.connector_id) ??
    "unknown";
  const actionKind = readString(action.kind) ?? "owner_action";
  const surfaceKind = actionSurfaceKind(action);
  const satisfiedWhen = actionSatisfactionKind(action) ?? "unknown";
  const reason = readString(summary.connection_health?.reason_code) ?? `${actionKind}:${surfaceKind}`;
  return {
    key: `owner_action:${connectionId}:${actionKind}:${surfaceKind}:${satisfiedWhen}:${reason}`,
    reason,
  };
}
