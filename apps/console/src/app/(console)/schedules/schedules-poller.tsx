"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { LivePoller } from "../components/live-poller.tsx";

export function SchedulesPoller({ enabled }: { enabled: boolean }) {
  return <LivePoller enabled={enabled} />;
}
