// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { Inter, JetBrains_Mono, Source_Serif_4 } from "next/font/google";
// Trail: was Newsreader — swap back via:
// import { Inter, JetBrains_Mono, Newsreader } from "next/font/google";

export const brandSans = Inter({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-pdpp-sans",
  weight: "variable",
});

export const brandMono = JetBrains_Mono({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-pdpp-mono",
  weight: "variable",
});

// Trail: previous serif
// export const brandSerif = Newsreader({
//   display: "swap",
//   style: ["normal", "italic"],
//   subsets: ["latin"],
//   variable: "--font-pdpp-serif",
//   weight: ["300", "400", "600"],
// });

export const brandSerif = Source_Serif_4({
  display: "swap",
  style: ["normal", "italic"],
  subsets: ["latin"],
  variable: "--font-pdpp-serif",
  weight: ["300", "400", "600"],
});
