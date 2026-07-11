export type RunTriggerKind = "manual" | "retry" | "scheduled" | "webhook";
export type RunAutomationMode = "ask_before_run" | "assisted" | "manual_only" | "unattended";

export interface AutomationRefreshPolicy {
  readonly assisted_after_owner_auth?: boolean;
  readonly background_safe?: boolean;
  readonly interaction_posture?: "credentials" | "manual_action_likely" | "none" | "otp_likely";
  readonly recommended_mode?: "automatic" | "manual" | "paused";
}

export interface DeploymentReadinessInput {
  readonly ready: boolean;
  readonly reason?: string | null;
}

export interface RunAutomationPolicyInput {
  readonly deploymentReadiness?: DeploymentReadinessInput | null;
  readonly humanAttentionNeeded?: boolean;
  readonly refreshPolicy?: AutomationRefreshPolicy | null;
  readonly triggerKind: RunTriggerKind;
}

export interface RunAutomationPolicyProjection {
  readonly allowed_to_start: boolean;
  readonly automation_mode: RunAutomationMode;
  readonly deployment_readiness: DeploymentReadinessInput;
  readonly notification_posture: "action_required" | "informational" | "none";
  readonly reason: string | null;
  readonly requires_owner_approval: boolean;
  readonly trigger_kind: RunTriggerKind;
}

function createRunAutomationPolicyProjection({
  allowedToStart,
  automationMode,
  deploymentReadiness,
  notificationPosture,
  reason,
  requiresOwnerApproval,
  triggerKind,
}: {
  readonly allowedToStart: boolean;
  readonly automationMode: RunAutomationMode;
  readonly deploymentReadiness: DeploymentReadinessInput;
  readonly notificationPosture: RunAutomationPolicyProjection["notification_posture"];
  readonly reason: string | null;
  readonly requiresOwnerApproval: boolean;
  readonly triggerKind: RunTriggerKind;
}): RunAutomationPolicyProjection {
  return {
    allowed_to_start: allowedToStart,
    automation_mode: automationMode,
    deployment_readiness: deploymentReadiness,
    notification_posture: notificationPosture,
    reason,
    requires_owner_approval: requiresOwnerApproval,
    trigger_kind: triggerKind,
  };
}

function policyBlocksScheduledRuns(refreshPolicy: AutomationRefreshPolicy | null | undefined): string | null {
  if (!refreshPolicy) {
    return null;
  }
  if (refreshPolicy.recommended_mode === "paused") {
    return "Connector refresh policy recommends paused refresh; automatic scheduling is disabled.";
  }
  if (refreshPolicy.background_safe === false) {
    return "Connector refresh policy is not background-safe; automatic scheduling is disabled.";
  }
  if (refreshPolicy.recommended_mode === "manual" && refreshPolicy.background_safe !== true) {
    return "Connector refresh policy recommends manual runs; automatic scheduling is disabled until background_safe=true is declared.";
  }
  return null;
}

function canNotifyDuringRun(
  refreshPolicy: AutomationRefreshPolicy | null | undefined,
  options: { isManualTrigger: boolean }
): boolean {
  if (!options.isManualTrigger && refreshPolicy?.assisted_after_owner_auth === true) {
    return false;
  }
  const posture = refreshPolicy?.interaction_posture;
  return posture === "credentials" || posture === "manual_action_likely" || posture === "otp_likely";
}

export function projectRunAutomationPolicy(input: RunAutomationPolicyInput): RunAutomationPolicyProjection {
  const deploymentReadiness = input.deploymentReadiness ?? { ready: true };
  const automaticPolicyReason = policyBlocksScheduledRuns(input.refreshPolicy);
  const isManualTrigger = input.triggerKind === "manual";
  const manualAwareNotificationPosture = isManualTrigger ? "none" : "informational";
  const requiresOwnerApproval = !isManualTrigger;

  if (automaticPolicyReason) {
    return createRunAutomationPolicyProjection({
      allowedToStart: isManualTrigger,
      automationMode: "manual_only",
      deploymentReadiness,
      notificationPosture: manualAwareNotificationPosture,
      reason: automaticPolicyReason,
      requiresOwnerApproval,
      triggerKind: input.triggerKind,
    });
  }

  if (!deploymentReadiness.ready) {
    return createRunAutomationPolicyProjection({
      allowedToStart: isManualTrigger,
      automationMode: isManualTrigger ? "assisted" : "ask_before_run",
      deploymentReadiness,
      notificationPosture: manualAwareNotificationPosture,
      reason: deploymentReadiness.reason || "Runtime prerequisites are not currently satisfied.",
      requiresOwnerApproval,
      triggerKind: input.triggerKind,
    });
  }

  if (input.humanAttentionNeeded && !isManualTrigger) {
    return createRunAutomationPolicyProjection({
      allowedToStart: false,
      automationMode: "ask_before_run",
      deploymentReadiness,
      notificationPosture: "action_required",
      reason: "Connector needs owner attention before automatic refresh can continue.",
      requiresOwnerApproval: true,
      triggerKind: input.triggerKind,
    });
  }

  const automationMode: RunAutomationMode = canNotifyDuringRun(input.refreshPolicy, { isManualTrigger })
    ? "assisted"
    : "unattended";
  return createRunAutomationPolicyProjection({
    allowedToStart: true,
    automationMode,
    deploymentReadiness,
    notificationPosture: automationMode === "assisted" ? "action_required" : "none",
    reason: null,
    requiresOwnerApproval: false,
    triggerKind: input.triggerKind,
  });
}

export function automationModeCopy(mode: RunAutomationMode): string {
  if (mode === "unattended") {
    return "Can refresh in the background without expected owner action.";
  }
  if (mode === "assisted") {
    return "Can start in the background and may ask for bounded owner assistance.";
  }
  if (mode === "ask_before_run") {
    return "Will preserve automatic intent but asks before starting owner-present work.";
  }
  return "Starts only from an owner gesture.";
}

export function automaticIneligibilityReason(refreshPolicy: AutomationRefreshPolicy | null): string | null {
  return policyBlocksScheduledRuns(refreshPolicy);
}
