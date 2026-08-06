// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { useEffect, useRef } from "react";
import { createField } from "./hero-field.ts";
import { HERO_WATER_STREAMS } from "./hero-water-data.ts";
import { PdppHeroWaterStill } from "./hero-water-still.tsx";

// Records floating on water.
//
// Three columns of real record text drift downward at a constant speed. That
// baseline never changes and never reacts: a reader looking at the headline
// should not be pulled away from it. The pointer's whole effect is on the
// MEDIUM the records float in, not on the records themselves.
//
// Two earlier attempts are worth recording because both are the obvious answer
// and both are wrong. Carving a hole in the text and reflowing around the
// cursor reads as the page breaking. A spring per record reads as a transition
// with extra steps: one body reacting to a cursor is not physics, because there
// is nothing between the bodies. What makes it read as water is that
// disturbing one place moves a record somewhere else a moment LATER, carried.
//
// So hero-field.ts holds a velocity grid and a height field. Pointer motion
// injects momentum and presses a trough into the surface; the surface springs
// back and throws a ring outward. Records sample the field where they sit:
// velocity drifts them, height lifts them, and the surface SLOPE shades them,
// which is the cue that makes it read as depth rather than as sliding.

const ROW_GAP = 34;
const FONT_SIZE = 12;
const COL_PAD = 18;
const LINE_ALPHA_EDGE = 90; // px fade at top and bottom
// Well under 1: a record is heavy relative to the water, so it leans with the
// current rather than being swept by it. Above ~0.2 the columns visibly break
// formation and it stops reading as a calm surface.
const DRIFT_SCALE = 0.11;
const DRIFT_DRAG = 3.2;
const DRIFT_CLAMP = 7; // px, keeps the monospace column grid intact

interface Line {
  col: number;
  driftX: number;
  driftY: number;
  key: string;
  lift: number;
  shade: number;
  span: number;
  speed: number;
  value: string;
  y: number;
}

export function PdppHeroWater() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    // Matches the `display: none` breakpoint in editorial.css. If one moves
    // the other must; they describe the same decision, and a disagreement
    // means either an invisible canvas still running a loop or a visible empty
    // box. Below it the figure is not built at all, so a phone never pays for
    // the canvas, the loop or the listeners.
    if (window.matchMedia("(max-width: 1200px)").matches) {
      return;
    }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const canvas = document.createElement("canvas");
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "Records from three data streams drifting downward on a still surface.");
    canvas.style.display = "block";
    host.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      // No 2d context: leave the server-rendered still frame as the
      // permanent figure rather than showing nothing.
      canvas.remove();
      return;
    }

    function removeStillFrame() {
      host?.querySelector("[data-hero-water-still]")?.remove();
    }

    const field = createField();
    const pointer = { active: false, x: -9999, y: -9999 };
    let lines: Line[] = [];
    let w = 0;
    let h = 0;
    let raf = 0;
    let last = 0;

    function build() {
      lines = [];
      const perCol = Math.ceil(h / ROW_GAP) + 2;
      for (let c = 0; c < HERO_WATER_STREAMS.length; c++) {
        const rows = HERO_WATER_STREAMS[c] as readonly (readonly [string, string])[];
        for (let i = 0; i < perCol; i++) {
          const row = rows[i % rows.length] as readonly [string, string];
          lines.push({
            col: c,
            driftX: 0,
            driftY: 0,
            key: row[0],
            lift: 0,
            shade: 0,
            span: perCol * ROW_GAP,
            // Columns drift at slightly different speeds so the three never
            // lock into one moving block.
            speed: 15 + c * 2.5,
            value: row[1],
            y: i * ROW_GAP + (c * ROW_GAP) / 3,
          });
        }
      }
    }

    function resize() {
      const rect = host?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = rect.width;
      h = rect.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      field.resize(w, h);
      build();
    }

    function paint() {
      if (!ctx) {
        return;
      }
      ctx.clearRect(0, 0, w, h);
      const monoFamily = getComputedStyle(document.documentElement).getPropertyValue("--font-pdpp-mono").trim();
      ctx.font = `300 ${FONT_SIZE}px ${monoFamily || "ui-monospace, monospace"}`;
      ctx.textBaseline = "alphabetic";
      const colW = w / HERO_WATER_STREAMS.length;

      for (const line of lines) {
        const edge = Math.min(line.y, h - line.y);
        const alpha = Math.max(0, Math.min(1, edge / LINE_ALPHA_EDGE));
        if (alpha <= 0.02) {
          continue;
        }
        const drift = Math.max(-DRIFT_CLAMP, Math.min(DRIFT_CLAMP, line.driftX));
        const x = line.col * colW + COL_PAD + drift;
        const y = line.y + line.lift;
        // Slope reads as light: a face tilted one way sits a little darker and
        // more present, the far side of the same crest lightens. Bounded
        // tightly, because the legibility floor is not negotiable.
        const lit = 1 + Math.max(-0.12, Math.min(0.12, line.shade * 0.12));
        ctx.fillStyle = `rgba(14, 90, 84, ${(0.78 * alpha * lit).toFixed(3)})`;
        ctx.fillText(line.key, x, y);
        const keyW = ctx.measureText(`${line.key}  `).width;
        ctx.fillStyle = `rgba(26, 26, 23, ${(0.92 * alpha * lit).toFixed(3)})`;
        ctx.fillText(line.value, x + keyW, y);
      }
    }

    function tick(now: number) {
      const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
      last = now;
      field.step(dt);
      const colW = w / HERO_WATER_STREAMS.length;

      for (const line of lines) {
        line.y += line.speed * dt;
        if (line.y > h + ROW_GAP) {
          line.y -= line.span;
        }
        // Ride the medium. A disturbance made upstream a moment ago arrives
        // here late, carried by the water rather than applied directly. Drag
        // is what keeps a record from tracking the field instantly.
        const sx = line.col * colW + colW / 2;
        const flow = field.sample(sx, line.y);
        const wave = field.surface(sx, line.y);
        line.driftX += (flow.x * DRIFT_SCALE - line.driftX) * Math.min(1, dt * DRIFT_DRAG);
        line.driftY += (flow.y * DRIFT_SCALE - line.driftY) * Math.min(1, dt * DRIFT_DRAG);
        line.lift += (wave.lift - line.lift) * Math.min(1, dt * 12);
        line.shade += (wave.shade - line.shade) * Math.min(1, dt * 12);
      }
      paint();
      raf = requestAnimationFrame(tick);
    }

    function onMove(event: PointerEvent) {
      const rect = host?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      const nx = event.clientX - rect.left;
      const ny = event.clientY - rect.top;
      // Momentum, not position. A resting pointer injects nothing, so the water
      // under a still cursor goes flat instead of holding a permanent dent.
      if (pointer.active) {
        field.inject(nx, ny, nx - pointer.x, ny - pointer.y);
      }
      pointer.x = nx;
      pointer.y = ny;
      pointer.active = true;
    }

    function onLeave() {
      pointer.active = false;
    }

    resize();
    // Paint synchronously, before the first rAF, so the canvas already has
    // pixels the instant it replaces the server-rendered still frame below —
    // otherwise there is a one-frame gap where neither is visible.
    paint();
    removeStillFrame();
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    if (reduced) {
      // One still frame, no loop, no listeners.
      return () => {
        observer.disconnect();
        canvas.remove();
      };
    }

    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerleave", onLeave);
    raf = requestAnimationFrame(tick);

    // Stop entirely when the figure is offscreen or the tab is hidden, so an
    // unread page costs nothing.
    const io = new IntersectionObserver((entries) => {
      const visible = entries[0]?.isIntersecting ?? false;
      if (visible && raf === 0) {
        last = performance.now();
        raf = requestAnimationFrame(tick);
      } else if (!visible && raf !== 0) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    });
    io.observe(host);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      io.disconnect();
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
      canvas.remove();
    };
  }, []);

  return (
    <div aria-hidden="true" className="pdpp-frontdoor__water" ref={hostRef}>
      <PdppHeroWaterStill />
    </div>
  );
}
