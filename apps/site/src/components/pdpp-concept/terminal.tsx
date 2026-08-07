// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { useEffect, useState } from "react";

// A command block with a working Copy button.
//
// The concept site's copy-as-markdown was DEAD sitewide — the script bound to a
// class that had been renamed, so the button rendered and did nothing. That is
// the failure mode this component exists to prevent: the handler lives with the
// markup it drives, so a rename cannot silently unbind them.
export function PdppTerminal({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!(copied || failed)) {
      return;
    }
    const timer = setTimeout(() => {
      setCopied(false);
      setFailed(false);
    }, 2000);
    return () => clearTimeout(timer);
  }, [copied, failed]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      // navigator.clipboard is undefined on insecure origins and rejects when
      // the permission is denied. Say so rather than showing a false "Copied".
      setFailed(true);
    }
  }

  let buttonLabel = "Copy";
  if (copied) {
    buttonLabel = "Copied";
  } else if (failed) {
    buttonLabel = "Copy failed";
  }

  return (
    <figure aria-label={label} className="pdpp-terminal" data-selection-ground="teal-deep">
      <div className="pdpp-terminal__head">
        <span className="pdpp-terminal__label">{label}</span>
        <button aria-label="Copy the command to the clipboard" className="pdpp-copy-btn" onClick={copy} type="button">
          {buttonLabel}
        </button>
      </div>
      <pre>
        <code>{command}</code>
      </pre>
    </figure>
  );
}
