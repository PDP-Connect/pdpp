// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { Inter, JetBrains_Mono, Source_Serif_4 } from "next/font/google";
// Trail: local faces are off — reinstate the import alongside a localFont block
// import localFont from "next/font/local";
// (the serif was Newsreader before Source_Serif_4)

// Trail: local General Sans — swap back by commenting out Inter below
// export const brandSans = localFont({
//   display: "swap",
//   src: [
//     {
//       path: "./GeneralSans-Variable.woff2",
//       style: "normal",
//       weight: "200 700",
//     },
//     {
//       path: "./GeneralSans-VariableItalic.woff2",
//       style: "italic",
//       weight: "200 700",
//     },
//   ],
//   variable: "--font-pdpp-sans",
// });

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

// Trail: local Zodiak — swap back by commenting out Source_Serif_4 below
// (and uncommenting the next/font/local import above)
// export const brandSerif = localFont({
//   display: "swap",
//   src: [
//     {
//       path: "./Zodiak-Variable.woff2",
//       style: "normal",
//       weight: "100 900",
//     },
//     {
//       path: "./Zodiak-VariableItalic.woff2",
//       style: "italic",
//       weight: "100 900",
//     },
//   ],
//   variable: "--font-pdpp-serif",
// });

export const brandSerif = Source_Serif_4({
  display: "swap",
  style: ["normal", "italic"],
  subsets: ["latin"],
  variable: "--font-pdpp-serif",
  weight: ["300", "400", "600"],
});
