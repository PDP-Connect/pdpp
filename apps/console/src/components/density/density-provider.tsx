"use client";

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { buildDensityCookie, DENSITY_KEY, type Density, normalizeDensity } from "./density-state.ts";

interface DensityContextValue {
  density: Density;
  setDensity: (next: Density) => void;
}

const DensityContext = createContext<DensityContextValue | null>(null);

function readStoredDensity(): Density {
  if (typeof document === "undefined") {
    return "comfortable";
  }

  const match = document.cookie
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${DENSITY_KEY}=`));

  if (!match) {
    return "comfortable";
  }

  try {
    return normalizeDensity(decodeURIComponent(match.slice(DENSITY_KEY.length + 1)));
  } catch {
    return "comfortable";
  }
}

function applyDensity(density: Density): void {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.dataset.density = density;
}

function persistDensity(next: Density): void {
  if (typeof document === "undefined") {
    return;
  }

  const secure = window.location.protocol === "https:";
  // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API is not supported across the dashboard's target browsers.
  document.cookie = buildDensityCookie(next, secure);
}

export function DensityProvider({ children, initialDensity }: { children: ReactNode; initialDensity?: Density }) {
  const [density, setDensityState] = useState<Density>(() => initialDensity ?? readStoredDensity());

  useEffect(() => {
    applyDensity(density);
  }, [density]);

  const setDensity = useCallback((next: Density) => {
    setDensityState(next);
    persistDensity(next);
  }, []);

  const value = useMemo<DensityContextValue>(() => ({ density, setDensity }), [density, setDensity]);

  return <DensityContext.Provider value={value}>{children}</DensityContext.Provider>;
}

export function useDensity(): DensityContextValue {
  const context = useContext(DensityContext);

  if (!context) {
    throw new Error("useDensity must be used inside <DensityProvider>");
  }

  return context;
}

export default DensityProvider;
