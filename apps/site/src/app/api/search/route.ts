// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/docs-source.ts";

// The fumadocs search dialog (fumadocs-ui DefaultSearchDialog) defaults to
// type: "fetch" against `/api/search` (fumadocs-core/search/client/fetch.js).
// Without this route every keystroke in the dialog 404s. RootProvider needs no
// `search` prop: the default already targets this URL.
export const { GET } = createFromSource(source);
