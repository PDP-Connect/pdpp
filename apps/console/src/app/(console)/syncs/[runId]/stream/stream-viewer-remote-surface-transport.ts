// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RemoteSurfaceTransport } from "@opendatalabs/remote-surface/client";

type RemoteSurfaceMessage = Record<string, unknown>;
type TransportLogger = (event: string, payload?: Record<string, unknown>) => void;

export interface PdppRemoteSurfaceTransport extends RemoteSurfaceTransport {
  receiveSseMessage: (name: string, payload: Record<string, unknown>) => void;
  sendClipboardText: (text: string) => Promise<boolean>;
  setPresentationAttachmentReady: (ready: boolean) => void;
}

interface CreatePdppRemoteSurfaceTransportOptions {
  clipboardUrlRef: { current: string | null };
  inputUrlRef: { current: string | null };
  logDebug: TransportLogger;
  presentationAttachmentReadyRef: { current: boolean };
  viewportUrlRef: { current: string | null };
}

function responseMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const { error } = body as { error?: unknown };
    if (error && typeof error === "object" && !Array.isArray(error)) {
      const { message } = error as { message?: unknown };
      if (typeof message === "string" && message.length > 0) {
        return message;
      }
    }
  }
  return fallback;
}

async function readResponseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function createPdppRemoteSurfaceTransport({
  clipboardUrlRef,
  inputUrlRef,
  logDebug,
  presentationAttachmentReadyRef,
  viewportUrlRef,
}: CreatePdppRemoteSurfaceTransportOptions): PdppRemoteSurfaceTransport {
  const handlers = new Set<(message: RemoteSurfaceMessage) => void>();
  let frameSequence = 0;
  let queuedViewport: RemoteSurfaceMessage | null = null;

  const emit = (message: RemoteSurfaceMessage): void => {
    for (const handler of handlers) {
      handler(message);
    }
  };

  const post = async (url: string, payload: RemoteSurfaceMessage): Promise<Response> =>
    fetch(url, {
      body: JSON.stringify(payload),
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

  const postInput = (payload: RemoteSurfaceMessage): void => {
    const url = inputUrlRef.current;
    if (!url) {
      logDebug("stream.remote_surface.input.skip", { reason: "missing-input-url", type: payload.type });
      return;
    }
    post(url, payload)
      .then(async (response) => {
        if (!response.ok) {
          const body = await readResponseBody(response);
          throw new Error(responseMessage(body, `Input rejected by server: ${response.status}`));
        }
      })
      .catch((error) => {
        logDebug("stream.remote_surface.input.error", {
          error: error instanceof Error ? error.message : String(error),
          type: payload.type,
        });
      });
  };

  const postClipboard = (payload: RemoteSurfaceMessage): Promise<Response> => {
    const url = clipboardUrlRef.current;
    if (!url) {
      throw new Error("Cannot send clipboard operation: no active stream clipboard URL");
    }
    return post(url, payload);
  };

  const sendViewport = (payload: RemoteSurfaceMessage): void => {
    if (!presentationAttachmentReadyRef.current) {
      queuedViewport = payload;
      logDebug("stream.remote_surface.viewport.queue", { reason: "awaiting-presentation-attachment" });
      return;
    }
    const url = viewportUrlRef.current;
    const { requestId } = payload;
    if (!url || typeof requestId !== "number") {
      emit({
        reason: url ? "viewport request is missing requestId" : "missing viewport URL",
        requestId,
        type: "viewport-error",
      });
      return;
    }
    post(url, payload)
      .then(async (response) => {
        const body = await readResponseBody(response);
        if (!response.ok) {
          throw new Error(responseMessage(body, `Viewport rejected by server: ${response.status}`));
        }
        emit({
          ...(body && typeof body === "object" && !Array.isArray(body) ? body : {}),
          requestId,
          type: "viewport-applied",
        });
      })
      .catch((error) => {
        emit({
          reason: error instanceof Error ? error.message : String(error),
          requestId,
          type: "viewport-error",
        });
      });
  };

  const sendRemoteSelectionRead = (requestId: number): void => {
    let request: Promise<Response>;
    try {
      request = postClipboard({ type: "clipboard", action: "remote_to_local", requestId });
    } catch (error) {
      emit({
        reason: error instanceof Error ? error.message : String(error),
        requestId,
        type: "remote-selection-error",
      });
      return;
    }
    request
      .then(async (response) => {
        const body = await readResponseBody(response);
        if (!response.ok) {
          throw new Error(responseMessage(body, `Remote selection rejected by server: ${response.status}`));
        }
        const text = body && typeof body === "object" && !Array.isArray(body) ? (body as { text?: unknown }).text : "";
        emit({ requestId, text: typeof text === "string" ? text : "", type: "remote-selection" });
      })
      .catch((error) => {
        emit({
          reason: error instanceof Error ? error.message : String(error),
          requestId,
          type: "remote-selection-error",
        });
      });
  };

  const sendClipboardText = async (text: string): Promise<boolean> => {
    try {
      const response = await postClipboard({ action: "local_to_remote", text, type: "clipboard" });
      const body = await readResponseBody(response);
      if (!response.ok) {
        throw new Error(responseMessage(body, `Clipboard rejected by server: ${response.status}`));
      }
      return true;
    } catch (error) {
      logDebug("stream.remote_surface.clipboard.error", {
        error: error instanceof Error ? error.message : String(error),
        phase: "local-to-remote",
      });
      return false;
    }
  };

  const receiveSseMessage = (name: string, payload: Record<string, unknown>): void => {
    if (name === "frame") {
      frameSequence += 1;
      emit({
        contentType: "image/jpeg",
        data: typeof payload.data_base64 === "string" ? payload.data_base64 : "",
        sequence: frameSequence,
        type: "frame",
      });
      return;
    }
    if (name === "keyboard_focus") {
      emit({
        name: "keyboard_focus",
        payload,
        type: "backend_event",
      });
    }
  };

  return {
    receiveSseMessage,
    send(message) {
      if (message.type === "viewport") {
        sendViewport(message);
        return;
      }
      if (message.type === "read_remote_selection" && typeof message.requestId === "number") {
        sendRemoteSelectionRead(message.requestId);
        return;
      }
      if (message.type === "clipboard") {
        if (message.action === "local_to_remote" && typeof message.text === "string") {
          sendClipboardText(message.text).catch(() => undefined);
        }
        return;
      }
      postInput(message);
    },
    sendClipboardText,
    setPresentationAttachmentReady(ready) {
      presentationAttachmentReadyRef.current = ready;
      if (!(ready && queuedViewport)) {
        return;
      }
      const next = queuedViewport;
      queuedViewport = null;
      sendViewport(next);
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}
