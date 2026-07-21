// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { type ViewportPayload, viewportPayloadsAreEquivalent } from "@opendatalabs/remote-surface/client";

export interface ViewportLastPostState {
  current: ViewportPayload | null;
}

export interface ViewportWriterContext {
  force?: boolean;
}

interface PreparedViewportTransport {
  onEquivalent(): void;
  post(): void;
}

interface ViewportWritePreparation<Context extends ViewportWriterContext> {
  context: Context;
  previous: ViewportPayload | null;
  viewport: ViewportPayload;
}

/**
 * A physical resize can be observed both by PDPP's policy listener and the
 * remote-surface viewer's container-fit matcher. These production adapters
 * share one injected last-post state, so a target viewport reaches transport
 * at most once.
 */
export function shouldPostViewport(previous: ViewportPayload | null, next: ViewportPayload): boolean {
  return !viewportPayloadsAreEquivalent(previous, next);
}

export function createViewportWriters<Context extends ViewportWriterContext>({
  lastPostState,
  onMissingViewport,
  prepareTransport,
  readViewport,
}: {
  lastPostState: ViewportLastPostState;
  onMissingViewport?: (width: number, height: number, context: Context) => void;
  prepareTransport: (preparation: ViewportWritePreparation<Context>) => PreparedViewportTransport | null;
  readViewport: (width: number, height: number) => ViewportPayload | null | undefined;
}) {
  const writeViewport = (viewport: ViewportPayload, context: Context) => {
    const previous = lastPostState.current;
    const transport = prepareTransport({ context, previous, viewport });
    if (!transport) {
      return false;
    }
    if (!(context.force || shouldPostViewport(previous, viewport))) {
      transport.onEquivalent();
      return false;
    }
    lastPostState.current = viewport;
    transport.post();
    return true;
  };

  return {
    applyViewport: writeViewport,
    postViewport: (width: number, height: number, context: Context) => {
      const viewport = readViewport(width, height);
      if (!viewport) {
        onMissingViewport?.(width, height, context);
        return false;
      }
      return writeViewport(viewport, context);
    },
  };
}
