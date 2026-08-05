// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { useEffect, useState } from "react";

// One dominant command with tabs above it. The tabs carry the choice, the
// command carries the instruction, and nothing else is present — no heading, no
// lead-in sentence, no button styling on the tabs.
//
// Adapted from the opencode.ai install block (the owner's reference), NOT
// copied: theirs is a dark ground, ours is paper with teal, so the pattern
// translates as restraint and hierarchy rather than colour. Active tab is ink
// with an underline inset to the label width; inactive tabs recede to ink-faint.
//
// Selective emphasis inside the command: opencode brightens only the domain and
// dims the surrounding flags. The equivalent here is the image reference — the
// one token that says WHAT you are running. Applied only where a single token
// genuinely carries the meaning; the Compose tab's two lines are all signal, so
// they get no emphasis rather than fake emphasis.
//
// Tab choice persists in localStorage, because a reader who picked Compose
// should not re-pick it on every visit (the docs-site equivalent of `ni`
// scanning for a lockfile).

const STORAGE_KEY = "pdpp-command-tab";

export interface CommandTab {
  /** Segments of the command line. `emphasis` marks the token the eye should land on. */
  readonly command: readonly { readonly emphasis?: boolean; readonly text: string }[];
  /**
   * Command to show when the reader asks for browser-backed sources. The
   * default `reference` image is browser-free, so connectors that sign in
   * through a real browser (ChatGPT, Amazon, USAA) fail at Patchright launch.
   * `deploy/docker/README.md` documents the fix as one env var, so the browser
   * choice rewrites the command rather than adding a footnote nobody reads.
   * Absent means this tab cannot serve browser sources at all, and the UI says
   * so instead of emitting a command that predictably blocks sign-in.
   */
  readonly browserCommand?: readonly { readonly emphasis?: boolean; readonly text: string }[];
  /** Shown in place of a command when this tab has no browser-capable path. */
  readonly browserUnavailable?: React.ReactNode;
  readonly id: string;
  readonly label: string;
  /** One short line under the command. Optional, and kept to one line where present. */
  readonly note?: React.ReactNode;
}

function commandText(tab: CommandTab, browser: boolean): string {
  return activeCommand(tab, browser)
    .map((part) => part.text)
    .join("");
}

function activeCommand(tab: CommandTab, browser: boolean) {
  return browser && tab.browserCommand ? tab.browserCommand : tab.command;
}

export function PdppCommandTabs({ tabs }: { tabs: readonly CommandTab[] }) {
  const [activeId, setActiveId] = useState(tabs[0]?.id ?? "");
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  // Off by default: the browser image carries Chromium and its apt deps, which
  // a network-only owner should not pay for. The choice is explicit either way
  // so nobody lands on a browser-free command by accident.
  const [browser, setBrowser] = useState(false);

  // Restore after mount, not during render: the server has no localStorage, and
  // reading it during render would desync the first client paint from the HTML.
  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved && tabs.some((tab) => tab.id === saved)) {
      setActiveId(saved);
    }
  }, [tabs]);

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

  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];
  if (!active) {
    return null;
  }

  function select(id: string) {
    setActiveId(id);
    window.localStorage.setItem(STORAGE_KEY, id);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(commandText(active as CommandTab, browser));
      setCopied(true);
    } catch {
      // clipboard is undefined on insecure origins and rejects when denied. Say
      // so rather than showing a false "Copied".
      setFailed(true);
    }
  }

  // A tab with no browser-capable path says so rather than emitting a command
  // that would fail at sign-in.
  const browserBlocked = browser && !active.browserCommand;

  let copyLabel = "Copy";
  if (copied) {
    copyLabel = "Copied";
  } else if (failed) {
    copyLabel = "Copy failed";
  }

  return (
    <div className="pdpp-cmd">
      <div aria-label="Install method" className="pdpp-cmd__tabs" role="tablist">
        {tabs.map((tab) => (
          <button
            aria-controls="pdpp-cmd-panel"
            aria-selected={tab.id === active.id}
            className="pdpp-cmd__tab"
            id={`pdpp-cmd-tab-${tab.id}`}
            key={tab.id}
            onClick={() => select(tab.id)}
            role="tab"
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        aria-labelledby={`pdpp-cmd-tab-${active.id}`}
        className="pdpp-cmd__panel"
        id="pdpp-cmd-panel"
        role="tabpanel"
      >
        {browserBlocked ? (
          <p className="pdpp-cmd__blocked">{active.browserUnavailable}</p>
        ) : (
          <>
            <pre className="pdpp-cmd__line">
              <code>
                {activeCommand(active, browser).map((part) =>
                  part.emphasis ? (
                    <b className="pdpp-cmd__em" key={part.text}>
                      {part.text}
                    </b>
                  ) : (
                    <span key={part.text}>{part.text}</span>
                  )
                )}
              </code>
            </pre>
            <button
              aria-label="Copy the command to the clipboard"
              className="pdpp-cmd__copy"
              onClick={copy}
              type="button"
            >
              {copyLabel}
            </button>
          </>
        )}
      </div>

      <label className="pdpp-cmd__opt">
        <input checked={browser} onChange={(event) => setBrowser(event.target.checked)} type="checkbox" />
        Sources that sign in through a browser (ChatGPT, Amazon, USAA)
      </label>

      {active.note ? <p className="pdpp-cmd__note">{active.note}</p> : null}
    </div>
  );
}
