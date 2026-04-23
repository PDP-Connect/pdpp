'use server';

import { redirect } from 'next/navigation';
import {
  DASHBOARD_BOOTSTRAP_CLIENT_ID,
  approveOwnerBootstrapFlow,
  denyOwnerBootstrapFlow,
  exchangeOwnerBootstrapToken,
  introspectOwnerBootstrapToken,
  setOwnerBootstrapFlowError,
  startOwnerBootstrapFlow,
} from '../../lib/operator-bootstrap';

function asString(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function flowHref(flowId: string): string {
  return `/dashboard/grants/bootstrap?flow=${encodeURIComponent(flowId)}`;
}

function errorHref(message: string): string {
  return `/dashboard/grants/bootstrap?error=${encodeURIComponent(message)}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected operator action failure';
}

export async function startOwnerTokenFlowAction(formData: FormData) {
  const clientId = asString(formData.get('client_id')) || DASHBOARD_BOOTSTRAP_CLIENT_ID;
  let target: string;
  try {
    const flow = await startOwnerBootstrapFlow(clientId);
    target = flowHref(flow.flowId);
  } catch (err) {
    target = errorHref(errorMessage(err));
  }
  redirect(target);
}

export async function approveOwnerTokenFlowAction(formData: FormData) {
  const flowId = asString(formData.get('flow_id'));
  const subjectId = asString(formData.get('subject_id')) || 'owner_local';
  try {
    await approveOwnerBootstrapFlow(flowId, subjectId);
  } catch (err) {
    setOwnerBootstrapFlowError(flowId, errorMessage(err));
  }
  redirect(flowHref(flowId));
}

export async function denyOwnerTokenFlowAction(formData: FormData) {
  const flowId = asString(formData.get('flow_id'));
  const subjectId = asString(formData.get('subject_id')) || 'owner_local';
  try {
    await denyOwnerBootstrapFlow(flowId, subjectId);
  } catch (err) {
    setOwnerBootstrapFlowError(flowId, errorMessage(err));
  }
  redirect(flowHref(flowId));
}

export async function exchangeOwnerTokenFlowAction(formData: FormData) {
  const flowId = asString(formData.get('flow_id'));
  try {
    await exchangeOwnerBootstrapToken(flowId);
  } catch (err) {
    setOwnerBootstrapFlowError(flowId, errorMessage(err));
  }
  redirect(flowHref(flowId));
}

export async function introspectOwnerTokenFlowAction(formData: FormData) {
  const flowId = asString(formData.get('flow_id'));
  try {
    await introspectOwnerBootstrapToken(flowId);
  } catch (err) {
    setOwnerBootstrapFlowError(flowId, errorMessage(err));
  }
  redirect(flowHref(flowId));
}
