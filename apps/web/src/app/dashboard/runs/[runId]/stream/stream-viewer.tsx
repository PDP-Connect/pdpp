/** biome-ignore-all lint/a11y/noNoninteractiveElementInteractions: ARIA application surface forwards
 * pointer/keyboard input to the streamed browser session — there is no underlying interactive
 * semantic to fall back to. */
/** biome-ignore-all lint/a11y/noNoninteractiveTabindex: focusable so the surface receives keystrokes
 * for the streaming companion. */
/** biome-ignore-all lint/correctness/useImageSize: streaming frames are dynamic data URLs at the
 * active viewport size; the container's aspect-ratio style avoids layout shift. */
"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type SyntheticEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button.tsx";
import { type MintedStreamSession, mintStreamSessionAction } from "./actions.ts";
import { STREAMING_UNAVAILABLE_TAG } from "./streaming-protocol.ts";

interface Props {
  interactionId: string;
  interactionKind: string;
  runId: string;
}

interface FrameMessage {
  data_base64: string;
  metadata?: { device_width?: number; device_height?: number } | null;
  session_id?: number;
}

interface AttachedMessage {
  browser_session_id: string;
  interaction_id: string;
  run_id: string;
  viewport: { width: number; height: number } | null;
}

interface StatusState {
  message: string;
  state: "idle" | "minting" | "connecting" | "live" | "closed" | "error" | "unavailable";
}

const SUPPORTED_KINDS = new Set(["manual_action"]);

/**
 * Owner-facing run-interaction streaming companion viewer. Mints a
 * short-lived session, opens the SSE frame channel, and forwards mouse,
 * keyboard, and touch input to the bound browser session.
 *
 * The token returned by the mint endpoint never leaves this client component.
 * If the user closes the page, the SSE channel ends server-side and the
 * session is invalidated.
 */
export function RunInteractionStreamViewer({ runId, interactionId, interactionKind }: Props) {
  const [status, setStatus] = useState<StatusState>({ state: "idle", message: "Ready to start streaming." });
  const [session, setSession] = useState<MintedStreamSession | null>(null);
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [viewportInfo, setViewportInfo] = useState<{ width: number; height: number } | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputUrlRef = useRef<string | null>(null);

  useEffect(() => {
    const closeUrl = session?.close_url;
    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      if (closeUrl) {
        try {
          navigator.sendBeacon(closeUrl);
        } catch {
          /* navigator may be unavailable */
        }
      }
    };
  }, [session?.close_url]);

  if (!SUPPORTED_KINDS.has(interactionKind)) {
    return (
      <p className="pdpp-caption text-muted-foreground">
        This interaction kind ({interactionKind}) is satisfied with credential or OTP fields and does not need a browser
        stream.
      </p>
    );
  }

  async function handleStart(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (eventSourceRef.current) {
      return;
    }
    setStatus({ state: "minting", message: "Requesting a streaming session…" });

    let viewport: { width: number; height: number } | undefined;
    if (typeof window !== "undefined") {
      viewport = { width: Math.max(320, window.innerWidth), height: Math.max(480, window.innerHeight) };
    }

    let minted: MintedStreamSession;
    try {
      minted = await mintStreamSessionAction({ runId, interactionId, viewport });
    } catch (err) {
      // Next.js server actions strip the Error class identity across the RPC
      // boundary, so the action tags unavailable errors with a stable prefix
      // the client can match. See STREAMING_UNAVAILABLE_TAG.
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith(STREAMING_UNAVAILABLE_TAG)) {
        setStatus({
          state: "unavailable",
          message:
            "Streaming companion is not configured on this reference server. Set PDPP_RUN_INTERACTION_CDP_WS_URL to a Chrome DevTools page-target WebSocket URL to enable run-interaction streaming.",
        });
        return;
      }
      setStatus({ state: "error", message: message || "Mint failed" });
      return;
    }

    setSession(minted);
    inputUrlRef.current = minted.input_url;
    setStatus({ state: "connecting", message: "Connecting to companion browser…" });

    const source = new EventSource(minted.viewer_url, { withCredentials: false });
    eventSourceRef.current = source;

    source.addEventListener("attached", (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data) as AttachedMessage;
        if (payload.viewport) {
          setViewportInfo(payload.viewport);
        }
        setStatus({ state: "live", message: "Streaming. Click and type as if you were in the browser." });
      } catch {
        setStatus({ state: "error", message: "Malformed attach event from streaming server" });
      }
    });

    source.addEventListener("frame", (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data) as FrameMessage;
        if (typeof payload.data_base64 === "string" && payload.data_base64.length > 0) {
          setImgSrc(`data:image/jpeg;base64,${payload.data_base64}`);
        }
      } catch {
        /* malformed frame is non-fatal */
      }
    });

    source.addEventListener("error", () => {
      // EventSource will retry by default; surface a soft error but don't tear
      // the page down — the server may still be alive.
      setStatus({ state: "error", message: "Streaming connection interrupted" });
    });
  }

  async function postInput(payload: Record<string, unknown>) {
    const url = inputUrlRef.current;
    if (!url) {
      return;
    }
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "omit",
      });
    } catch {
      // Single dropped input is non-fatal; the user will retry.
    }
  }

  function localCoords(event: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const node = containerRef.current;
    if (!node) {
      return null;
    }
    const rect = node.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (!(Number.isFinite(x) && Number.isFinite(y))) {
      return null;
    }
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
      return null;
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  function handleMouseMove(e: ReactMouseEvent<HTMLDivElement>) {
    const c = localCoords(e);
    if (!c) {
      return;
    }
    postInput({ type: "mouse", action: "mousemove", x: c.x, y: c.y }).catch(() => undefined);
  }

  function handleClick(e: ReactMouseEvent<HTMLDivElement>) {
    const c = localCoords(e);
    if (!c) {
      return;
    }
    postInput({ type: "mouse", action: "click", x: c.x, y: c.y, button: e.button ?? 0 }).catch(() => undefined);
  }

  function handleKey(e: ReactKeyboardEvent<HTMLDivElement>, action: "keydown" | "keyup") {
    e.preventDefault();
    postInput({
      type: "keyboard",
      action,
      key: e.key,
      code: e.code,
      modifiers: (e.altKey ? 1 : 0) + (e.ctrlKey ? 2 : 0) + (e.metaKey ? 4 : 0) + (e.shiftKey ? 8 : 0),
    }).catch(() => undefined);
  }

  if (status.state === "unavailable") {
    return (
      <div className="flex flex-col gap-2">
        <p className="pdpp-caption">{status.message}</p>
        <p className="pdpp-caption text-muted-foreground">
          Until streaming is configured, satisfy this interaction by running the connector locally with a real browser
          (see the local collector runner).
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <form className="flex flex-wrap items-center gap-2" onSubmit={handleStart}>
        <Button
          disabled={status.state === "minting" || status.state === "connecting" || status.state === "live"}
          type="submit"
        >
          {session ? "Streaming" : "Start streaming"}
        </Button>
        <span className="pdpp-caption text-muted-foreground">{status.message}</span>
      </form>
      <div
        aria-label="Run interaction stream viewer"
        className="relative aspect-video w-full max-w-3xl overflow-hidden rounded-md border border-border bg-muted/30"
        onClick={handleClick}
        onKeyDown={(e: ReactKeyboardEvent<HTMLDivElement>) => handleKey(e, "keydown")}
        onKeyUp={(e: ReactKeyboardEvent<HTMLDivElement>) => handleKey(e, "keyup")}
        onMouseMove={handleMouseMove}
        ref={containerRef}
        role="application"
        style={viewportInfo ? { aspectRatio: `${viewportInfo.width} / ${viewportInfo.height}` } : undefined}
        tabIndex={0}
      >
        {imgSrc ? (
          <img alt="streaming frame" className="h-full w-full select-none object-contain" src={imgSrc} />
        ) : (
          <p className="pdpp-caption m-3 text-muted-foreground">
            No frames yet. Press <em>Start streaming</em> when you're ready to satisfy the pending step.
          </p>
        )}
      </div>
      <p className="pdpp-caption text-muted-foreground">
        This stream is bound to the current pending interaction. It does not authorize record reads, consent approval,
        grant issuance, or unrelated browser access. The session expires automatically when you close this page or when
        the interaction is resolved.
      </p>
    </div>
  );
}
