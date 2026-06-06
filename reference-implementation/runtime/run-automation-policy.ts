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

function policyBlocksAutomatic(refreshPolicy: AutomationRefreshPolicy | null | undefined): string | null {
  if (!refreshPolicy) {
    return null;
  }
  if (refreshPolicy.recommended_mode === "manual") {
    return "Connector refresh policy recommends manual runs; automatic scheduling is disabled.";
  }
  if (refreshPolicy.recommended_mode === "paused") {
    return "Connector refresh policy recommends paused refresh; automatic scheduling is disabled.";
  }
  if (refreshPolicy.background_safe === false) {
    return "Connector refresh policy is not background-safe; automatic scheduling is disabled.";
  }
  return null;
}

function canNotifyDuringRun(refreshPolicy: AutomationRefreshPolicy | null | undefined): boolean {
  const posture = refreshPolicy?.interaction_posture;
  return posture === "credentials" || posture === "manual_action_likely" || posture === "otp_likely";
}

export function projectRunAutomationPolicy(input: RunAutomationPolicyInput): RunAutomationPolicyProjection {
  const deploymentReadiness = input.deploymentReadiness ?? { ready: true };
  const automaticPolicyReason = policyBlocksAutomatic(input.refreshPolicy);
  const isManualTrigger = input.triggerKind === "manual";

  if (automaticPolicyReason) {
    return {
      allowed_to_start: isManualTrigger,
      automation_mode: "manual_only",
      deployment_readiness: deploymentReadiness,
      notification_posture: isManualTrigger ? "none" : "informational",
      reason: automaticPolicyReason,
      requires_owner_approval: !isManualTrigger,
      trigger_kind: input.triggerKind,
    };
  }

  if (!deploymentReadiness.ready) {
    return {
      allowed_to_start: isManualTrigger,
      automation_mode: isManualTrigger ? "assisted" : "ask_before_run",
      deployment_readiness: deploymentReadiness,
      notification_posture: isManualTrigger ? "none" : "informational",
      reason: deploymentReadiness.reason || "Runtime prerequisites are not currently satisfied.",
      requires_owner_approval: !isManualTrigger,
      trigger_kind: input.triggerKind,
    };
  }

  if (input.humanAttentionNeeded && !isManualTrigger) {
    return {
      allowed_to_start: false,
      automation_mode: "ask_before_run",
      deployment_readiness: deploymentReadiness,
      notification_posture: "action_required",
      reason: "Connector needs owner attention before automatic refresh can continue.",
      requires_owner_approval: true,
      trigger_kind: input.triggerKind,
    };
  }

  const automationMode: RunAutomationMode = canNotifyDuringRun(input.refreshPolicy) ? "assisted" : "unattended";
  return {
    allowed_to_start: true,
    automation_mode: automationMode,
    deployment_readiness: deploymentReadiness,
    notification_posture: automationMode === "assisted" ? "action_required" : "none",
    reason: null,
    requires_owner_approval: false,
    trigger_kind: input.triggerKind,
  };
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
  return policyBlocksAutomatic(refreshPolicy);
}
