/**
 * The viewer owns session hooks, while the console owns an injected adapter.
 * Keep that split explicit on the readiness-error path as well as teardown.
 */
export interface NekoViewerMountAdapter {
  unmount(): Promise<void>;
}

export interface NekoViewerMountHandle {
  mount(container: HTMLElement): Promise<void>;
  unmount(): void;
}

export async function mountNekoViewer({
  adapter,
  container,
  onAdapterReleased,
  viewer,
}: {
  adapter: NekoViewerMountAdapter;
  container: HTMLElement;
  onAdapterReleased: () => void;
  viewer: NekoViewerMountHandle;
}): Promise<void> {
  try {
    await viewer.mount(container);
  } catch (error) {
    viewer.unmount();
    await adapter.unmount().catch(() => {
      /* preserve the readiness failure as the console's inline error */
    });
    onAdapterReleased();
    throw error;
  }
}
