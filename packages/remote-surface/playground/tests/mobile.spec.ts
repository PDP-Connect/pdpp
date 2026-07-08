import { devices, expect, test } from "@playwright/test";
import type { CDPSession, Page } from "@playwright/test";

type ProbeSnapshot = {
  clickCount?: number;
  eventLog?: Array<{ target?: { id?: string; tag?: string }; type?: string }>;
  lastClick?: { target?: { id?: string; tag?: string } } | null;
  submitCount?: number;
  targetRects?: Record<string, { height: number; left: number; top: number; width: number } | null>;
  viewport?: { height: number; width: number };
};

type Point = {
  x: number;
  y: number;
};

test.use({
  ...devices["Pixel 5"],
  hasTouch: true,
  isMobile: true,
});

async function waitForPlayground(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByText("Connected")).toBeVisible();
  await expect(page.locator("#empty-state")).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('[data-testid="check-streamStable"]')).toHaveAttribute("data-state", "pass", {
    timeout: 15_000,
  });
}

async function readProbeSnapshot(page: Page): Promise<ProbeSnapshot> {
  return page.evaluate<ProbeSnapshot>(async () => {
    const wsUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/surface`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timeout = window.setTimeout(() => {
        ws.close();
        reject(new Error("Timed out waiting for probe snapshot"));
      }, 5000);

      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ type: "snapshot" }));
      });
      ws.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.type !== "ready" && message.type !== "snapshot") {
          return;
        }
        window.clearTimeout(timeout);
        ws.close();
        resolve(message.snapshot ?? {});
      });
      ws.addEventListener("error", () => {
        window.clearTimeout(timeout);
        ws.close();
        reject(new Error("Probe snapshot websocket failed"));
      });
    });
  });
}

async function resetProbe(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Reset" }).click();
  await expect.poll(async () => (await readProbeSnapshot(page)).clickCount ?? 0).toBe(0);
}

async function remotePointToClient(page: Page, remote: Point): Promise<Point> {
  await page.locator("#stage").scrollIntoViewIfNeeded();
  const snapshot = await readProbeSnapshot(page);
  const viewport = snapshot.viewport ?? { height: 844, width: 390 };
  return page.evaluate(
    ({ remote, viewport }) => {
      const stream = document.getElementById("stream");
      if (!(stream instanceof HTMLElement)) {
        throw new Error("Stream canvas is not mounted");
      }
      const rect = stream.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        throw new Error("Stream canvas has no displayed size");
      }
      return {
        x: Math.round(rect.left + (remote.x / viewport.width) * rect.width),
        y: Math.round(rect.top + (remote.y / viewport.height) * rect.height),
      };
    },
    { remote, viewport },
  );
}

async function remoteTargetCenterToClient(page: Page, targetId: string): Promise<Point> {
  const snapshot = await readProbeSnapshot(page);
  const rect = snapshot.targetRects?.[targetId];
  if (!rect) {
    throw new Error(`Probe target ${targetId} is missing from snapshot telemetry`);
  }
  return remotePointToClient(page, {
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
  });
}

async function withTouchSession(page: Page, run: (cdp: CDPSession) => Promise<void>): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await run(cdp);
  } finally {
    await cdp.detach();
  }
}

async function touchStart(cdp: CDPSession, point: Point): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", {
    touchPoints: [{ id: 1, radiusX: 1, radiusY: 1, x: point.x, y: point.y }],
    type: "touchStart",
  });
}

async function touchMove(cdp: CDPSession, point: Point): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", {
    touchPoints: [{ id: 1, radiusX: 1, radiusY: 1, x: point.x, y: point.y }],
    type: "touchMove",
  });
}

async function touchEnd(cdp: CDPSession): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", {
    touchPoints: [],
    type: "touchEnd",
  });
}

async function tap(page: Page, point: Point): Promise<void> {
  await withTouchSession(page, async (cdp) => {
    await touchStart(cdp, point);
    await page.waitForTimeout(40);
    await touchEnd(cdp);
  });
}

async function drag(page: Page, start: Point, end: Point): Promise<void> {
  await withTouchSession(page, async (cdp) => {
    await touchStart(cdp, start);
    await page.waitForTimeout(50);
    await touchMove(cdp, {
      x: Math.round((start.x + end.x) / 2),
      y: Math.round((start.y + end.y) / 2),
    });
    await page.waitForTimeout(50);
    await touchMove(cdp, end);
    await page.waitForTimeout(50);
    await touchEnd(cdp);
  });
}

async function longPress(page: Page, point: Point): Promise<void> {
  await withTouchSession(page, async (cdp) => {
    await touchStart(cdp, point);
    await page.waitForTimeout(700);
    await touchEnd(cdp);
  });
}

function clickEvents(snapshot: ProbeSnapshot): Array<{ target?: { id?: string; tag?: string }; type?: string }> {
  return (snapshot.eventLog ?? []).filter((event) => event.type === "click");
}

test("mobile tap on the stage produces one remote click", async ({ page }) => {
  await waitForPlayground(page);
  await resetProbe(page);

  const emailPoint = await remoteTargetCenterToClient(page, "email");
  await tap(page, emailPoint);

  await expect(page.locator('[data-testid="check-oneTap"]')).toHaveAttribute("data-state", "pass");
  await page.waitForTimeout(1100);

  const snapshot = await readProbeSnapshot(page);
  expect(snapshot.clickCount).toBe(1);
  expect(clickEvents(snapshot)).toHaveLength(1);
  expect(snapshot.lastClick?.target?.id).toBe("email");
});

test("mobile drag on the stage does not register as a remote click", async ({ page }) => {
  await waitForPlayground(page);
  await resetProbe(page);

  const start = await remoteTargetCenterToClient(page, "email");
  await drag(page, start, { x: start.x, y: start.y + 90 });
  await page.waitForTimeout(1100);

  const snapshot = await readProbeSnapshot(page);
  expect(snapshot.clickCount).toBe(0);
  expect(clickEvents(snapshot)).toHaveLength(0);
  expect(snapshot.lastClick).toBeNull();
});

test("mobile long press does not produce a duplicate remote action", async ({ page }) => {
  await waitForPlayground(page);
  await resetProbe(page);

  const emailPoint = await remoteTargetCenterToClient(page, "email");
  await longPress(page, emailPoint);
  await page.waitForTimeout(1100);

  const snapshot = await readProbeSnapshot(page);
  expect(snapshot.clickCount ?? 0).toBeLessThanOrEqual(1);
  expect(clickEvents(snapshot).length).toBeLessThanOrEqual(1);
  expect(snapshot.submitCount ?? 0).toBe(0);
});
