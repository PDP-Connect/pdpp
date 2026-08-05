// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { useEffect, useId, useState } from "react";
import {
  buildCommand,
  commandText,
  defaultChoices,
  METHODS,
  type MethodId,
  PUBLIC_URL_PLACEHOLDER,
  type SelfHostChoices,
} from "@/lib/self-host-command.ts";

// THE SELF-HOST COMMAND BUILDER.
//
// THREE ROWS, which is the owner's constraint and the whole layout budget:
//   1. method tabs
//   2. one dominant command, the whole panel being the copy target
//   3. the configuration choices
// Anything that does not earn a place in those three rows goes under Advanced,
// which sits OUTSIDE the panel so it reads as a fourth-tier affordance rather
// than a fourth row.
//
// A GOAL-BASED BUILDER IS JUSTIFIED because the choices change what the node
// can do — reachable-from-hosted-clients or not, semantic search or lexical.
// Only outcomes are exposed. No env var, port, profile, service or image name
// appears in the UI; those are written by `self-host-command.ts`.
//
// WHAT IS DELIBERATELY NOT A CHOICE:
//   - Persistent storage. Always on. A data server that forgets is not one.
//   - Browser-based sources. Always on, and streamed so a human can watch and
//     take over a sign-in. It costs one image tag; making a reader opt into it
//     only produces nodes that fail at the first ChatGPT login.
//
// PRECEDENT, and what was taken from each:
//   opencode.ai   plain-text tabs with an underline on the active one, and —
//                 the highest-value detail — the ENTIRE command panel is the
//                 copy button, not a small icon with a tiny hit target.
//   PyTorch       the install matrix never hides or moves anything when a
//                 choice changes; geometry is frozen and the command sits in a
//                 permanently reserved slot. That is why the URL input's space
//                 is always reserved here and only its visibility toggles.
//   GOV.UK        conditional reveals are fine when kept to a single input,
//                 but must not be tethered ambiguously between two inline
//                 options — so the input sits below the whole control.
const STORAGE_KEY = "pdpp-command-tab";

function Segments({ method, choices }: { method: MethodId; choices: SelfHostChoices }) {
  const built = buildCommand(method, choices);
  if (!built.segments) {
    return null;
  }
  return (
    <>
      {built.segments.map((part, index) =>
        part.emphasis ? (
          <b className="pdpp-cmd__em" key={`${index}-${part.text}`}>
            {part.text}
          </b>
        ) : (
          <span key={`${index}-${part.text}`}>{part.text}</span>
        )
      )}
    </>
  );
}

export function PdppCommandBuilder({ compact = false }: { compact?: boolean }) {
  const [method, setMethod] = useState<MethodId>(METHODS[0]?.id ?? "compose");
  const [choices, setChoices] = useState<SelfHostChoices>(defaultChoices);
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const urlInputId = useId();

  // Restore after mount, not during render: the server has no localStorage, and
  // reading it during render would desync the first client paint from the HTML.
  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved && METHODS.some((entry) => entry.id === saved)) {
      setMethod(saved as MethodId);
    }
  }, []);

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

  const built = buildCommand(method, choices);

  function select(id: MethodId) {
    setMethod(id);
    window.localStorage.setItem(STORAGE_KEY, id);
  }

  async function copy() {
    if (!built.segments) {
      return;
    }
    try {
      await navigator.clipboard.writeText(commandText(built.segments));
      setCopied(true);
    } catch {
      // clipboard is undefined on insecure origins and rejects when denied.
      // Say so rather than showing a false "Copied".
      setFailed(true);
    }
  }

  let copyLabel = "Copy";
  if (copied) {
    copyLabel = "Copied";
  } else if (failed) {
    copyLabel = "Copy failed";
  }

  return (
    <div className={compact ? "pdpp-cmd pdpp-cmd--compact" : "pdpp-cmd"}>
      <div aria-label="Deployment method" className="pdpp-cmd__tabs" role="tablist">
        {METHODS.map((entry) => (
          <button
            aria-controls="pdpp-cmd-panel"
            aria-selected={entry.id === method}
            className="pdpp-cmd__tab"
            id={`pdpp-cmd-tab-${entry.id}`}
            key={entry.id}
            onClick={() => select(entry.id)}
            role="tab"
            type="button"
          >
            {entry.label}
          </button>
        ))}
      </div>

      {/* The whole panel is the copy target (opencode), so the hit area is the
          command rather than a 16px icon. It is a plain button when there is a
          command and a plain div when there is not — a button that copies
          nothing would be a lie about what clicking does. */}
      {built.segments ? (
        <button
          aria-label="Copy the command to the clipboard"
          aria-labelledby={`pdpp-cmd-tab-${method}`}
          className="pdpp-cmd__panel pdpp-cmd__panel--copyable"
          id="pdpp-cmd-panel"
          onClick={copy}
          type="button"
        >
          <pre className="pdpp-cmd__line">
            <code>
              <Segments choices={choices} method={method} />
            </code>
          </pre>
          <span aria-hidden="true" className="pdpp-cmd__copy">
            {copyLabel}
          </span>
        </button>
      ) : (
        <div className="pdpp-cmd__panel" id="pdpp-cmd-panel">
          <p className="pdpp-cmd__blocked">
            {built.unavailable}{" "}
            {built.unavailableHref ? (
              <a href={built.unavailableHref} rel="noopener noreferrer" target="_blank">
                {built.unavailableLinkLabel ?? "Learn more"} →
              </a>
            ) : null}
          </p>
        </div>
      )}

      {/* ROW 3. Two binary controls with the same shape, so "off" is always a
          named alternative rather than an absence.
          HIDDEN ON RAILWAY AND FLY, deliberately: neither path can carry these
          values into the single command shown. Railway's template link cannot
          carry variable values at all; Fly's command always advertises its own
          `https://<app>.fly.dev` origin (Fly assigns that hostname before the
          app exists) and has no per-run search-mode flag, so leaving the
          controls live would let a reader set them and silently get something
          else. The panel above says where those settings are actually made. */}
      {built.segments === null || method !== "compose" ? null : (
        <div className="pdpp-cmd__config">
          <fieldset className="pdpp-cmd__choice">
            <legend className="pdpp-cmd__choice-label">Access</legend>
            <div className="pdpp-cmd__seg">
              <button
                aria-pressed={choices.access === "local"}
                className="pdpp-cmd__seg-btn"
                onClick={() => setChoices((prev) => ({ ...prev, access: "local" }))}
                type="button"
              >
                This machine only
              </button>
              <button
                aria-pressed={choices.access === "public"}
                className="pdpp-cmd__seg-btn"
                onClick={() => setChoices((prev) => ({ ...prev, access: "public" }))}
                type="button"
              >
                Web apps and other devices
              </button>
            </div>
          </fieldset>

          {/* The space is ALWAYS reserved and only visibility toggles, so
            choosing "web apps" cannot make the command below jump. */}
          <div className={choices.access === "public" ? "pdpp-cmd__reveal is-shown" : "pdpp-cmd__reveal"}>
            <label className="pdpp-cmd__url" htmlFor={urlInputId}>
              <span>Public address</span>
              <input
                id={urlInputId}
                inputMode="url"
                onChange={(event) => setChoices((prev) => ({ ...prev, publicUrl: event.target.value }))}
                placeholder={PUBLIC_URL_PLACEHOLDER}
                tabIndex={choices.access === "public" ? undefined : -1}
                type="text"
                value={choices.publicUrl}
              />
            </label>
            {/* The one sentence that says what choosing this actually creates. */}
            <p className="pdpp-cmd__hint">
              Creates an internet-reachable MCP endpoint that still requires your sign-in.
            </p>
          </div>

          <fieldset className="pdpp-cmd__choice">
            <legend className="pdpp-cmd__choice-label">Search</legend>
            <div className="pdpp-cmd__seg">
              <button
                aria-pressed={choices.semanticSearch}
                className="pdpp-cmd__seg-btn"
                onClick={() => setChoices((prev) => ({ ...prev, semanticSearch: true }))}
                type="button"
              >
                By meaning
              </button>
              <button
                aria-pressed={!choices.semanticSearch}
                className="pdpp-cmd__seg-btn"
                onClick={() => setChoices((prev) => ({ ...prev, semanticSearch: false }))}
                type="button"
              >
                Keywords only
              </button>
            </div>
          </fieldset>
        </div>
      )}
    </div>
  );
}
