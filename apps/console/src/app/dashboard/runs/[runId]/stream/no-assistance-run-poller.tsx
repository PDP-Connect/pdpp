"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const NO_ASSISTANCE_REFRESH_MS = 3000;

export function NoAssistanceRunPoller() {
  const router = useRouter();

  useEffect(() => {
    const timer = window.setInterval(() => {
      router.refresh();
    }, NO_ASSISTANCE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [router]);

  return null;
}
