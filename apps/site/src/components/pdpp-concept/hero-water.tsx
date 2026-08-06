// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { PdppHeroWaterStill } from "./hero-water-still.tsx";

export function PdppHeroWater() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none h-[clamp(260px,36vh,380px)] min-w-0 self-center max-[1200px]:hidden"
    >
      <PdppHeroWaterStill />
    </div>
  );
}
