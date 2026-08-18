// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { useEffect, useId, useState } from "react";
import {
  buildCommand,
  commandText,
  defaultChoices,
  METHODS,
  PUBLIC_URL_PLACEHOLDER,
  type SelfHostChoices,
} from "@/lib/self-host-command.ts";

const STORAGE_KEY = "pdpp-command-tab";
const SELF_MANAGED_METHODS = METHODS.filter(
  (entry): entry is (typeof METHODS)[number] & { id: "docker" | "compose" } =>
    entry.id === "docker" || entry.id === "compose"
);

type SelfManagedMethod = (typeof SELF_MANAGED_METHODS)[number]["id"];

function Segments({ method, choices }: { method: SelfManagedMethod; choices: SelfHostChoices }) {
  const built = buildCommand(method, choices);
  if (!built.segments) {
    return null;
  }

  return built.segments.map((part, index) =>
    part.emphasis ? (
      <b className="pdpp-cmd__em" key={`${index}-${part.text}`}>
        {part.text}
      </b>
    ) : (
      <span key={`${index}-${part.text}`}>{part.text}</span>
    )
  );
}

function ProviderCard({ method }: { method: "fly" | "railway" }) {
  const built = buildCommand(method, defaultChoices);
  const label = METHODS.find((entry) => entry.id === method)?.label ?? method;

  return (
    <article className="pdpp-cmd__provider">
      <h3 className="pdpp-cmd__provider-title">{label}</h3>
      <p className="pdpp-cmd__provider-copy">{built.unavailable}</p>
      {built.unavailableHref ? (
        <a className="pdpp-cmd__provider-action" href={built.unavailableHref} rel="noopener noreferrer" target="_blank">
          {built.unavailableLinkLabel ?? "Learn more"} →
        </a>
      ) : null}
    </article>
  );
}

export function PdppCommandBuilder({ compact = false }: { compact?: boolean }) {
  const [method, setMethod] = useState<SelfManagedMethod>("docker");
  const [choices, setChoices] = useState<SelfHostChoices>(defaultChoices);
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const urlInputId = useId();
  const commandPanelId = useId();
  const accessDescriptionId = useId();
  const searchDescriptionId = useId();

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "docker" || saved === "compose") {
      setMethod(saved);
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

  function select(id: SelfManagedMethod) {
    setMethod(id);
    window.localStorage.setItem(STORAGE_KEY, id);
  }

  async function copy() {
    if (!built.segments) {
      return;
    }
    setCopied(false);
    setFailed(false);
    try {
      await navigator.clipboard.writeText(commandText(built.segments));
      setCopied(true);
    } catch {
      setFailed(true);
    }
  }

  let copyLabel = "Copy";
  let copyStatus = "";
  if (copied) {
    copyLabel = "Copied";
    copyStatus = "Command copied to clipboard.";
  } else if (failed) {
    copyLabel = "Copy failed";
    copyStatus = "Copy failed.";
  }

  return (
    <div className={compact ? "pdpp-cmd pdpp-cmd--compact" : "pdpp-cmd"}>
      <section aria-labelledby="pdpp-cmd-self-managed-title" className="pdpp-cmd__flow">
        <div className="pdpp-cmd__flow-heading">
          <h3 id="pdpp-cmd-self-managed-title">Run it yourself</h3>
          <p>Use Docker on a computer you control.</p>
        </div>

        <div aria-label="Self-managed deployment method" className="pdpp-cmd__tabs" role="tablist">
          {SELF_MANAGED_METHODS.map((entry) => (
            <button
              aria-controls={commandPanelId}
              aria-selected={entry.id === method}
              className="pdpp-cmd__tab"
              id={`pdpp-cmd-tab-${entry.id}`}
              key={entry.id}
              onClick={() => select(entry.id)}
              role="tab"
              type="button"
            >
              {entry.label}
              {entry.id === "docker" ? <span className="pdpp-cmd__recommended">Recommended</span> : null}
            </button>
          ))}
        </div>

        <div className="pdpp-cmd__config">
          <fieldset aria-describedby={accessDescriptionId} className="pdpp-cmd__choice">
            <legend className="pdpp-cmd__choice-label">Where will you use PDPP?</legend>
            <p className="pdpp-cmd__choice-help" id={accessDescriptionId}>
              Keeping it on this computer is private by default; sharing it requires a public address.
            </p>
            <div className="pdpp-cmd__seg">
              <button
                aria-pressed={choices.access === "local"}
                className="pdpp-cmd__seg-btn"
                onClick={() => setChoices((prev) => ({ ...prev, access: "local" }))}
                type="button"
              >
                Only this computer
              </button>
              <button
                aria-pressed={choices.access === "public"}
                className="pdpp-cmd__seg-btn"
                onClick={() => setChoices((prev) => ({ ...prev, access: "public" }))}
                type="button"
              >
                Other devices or web apps
              </button>
            </div>
          </fieldset>

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
            <p className="pdpp-cmd__hint">Makes PDPP reachable over the internet and still requires your sign-in.</p>
          </div>

          <fieldset aria-describedby={searchDescriptionId} className="pdpp-cmd__choice">
            <legend className="pdpp-cmd__choice-label">Choose a search mode</legend>
            <p className="pdpp-cmd__choice-help" id={searchDescriptionId}>
              Meaning-based search downloads extra search data; exact-word search uses less storage but only matches the
              words you type.
            </p>
            <div className="pdpp-cmd__seg">
              <button
                aria-pressed={choices.semanticSearch}
                className="pdpp-cmd__seg-btn"
                onClick={() => setChoices((prev) => ({ ...prev, semanticSearch: true }))}
                type="button"
              >
                Meaning-based search
              </button>
              <button
                aria-pressed={!choices.semanticSearch}
                className="pdpp-cmd__seg-btn"
                onClick={() => setChoices((prev) => ({ ...prev, semanticSearch: false }))}
                type="button"
              >
                Exact-word search
              </button>
            </div>
          </fieldset>
        </div>

        <button
          aria-label={`Copy ${method === "docker" ? "Docker" : "Docker Compose"} command to the clipboard`}
          className="pdpp-cmd__panel pdpp-cmd__panel--copyable"
          id={commandPanelId}
          onClick={copy}
          type="button"
        >
          <span className="pdpp-cmd__command-heading">
            <span className="pdpp-cmd__command-label">Your command</span>
            <span className="pdpp-cmd__command-instruction">
              Copy this command, paste it into Terminal, then press Enter.
            </span>
          </span>
          <pre className="pdpp-cmd__line">
            <code>
              <Segments choices={choices} method={method} />
            </code>
          </pre>
          <span aria-hidden="true" className="pdpp-cmd__copy">
            {copyLabel}
          </span>
        </button>
        <span aria-live="polite" className="pdpp-visually-hidden" role="status">
          {copyStatus}
        </span>
      </section>

      <section aria-labelledby="pdpp-cmd-provider-title" className="pdpp-cmd__flow pdpp-cmd__flow--providers">
        <div className="pdpp-cmd__flow-heading">
          <h3 id="pdpp-cmd-provider-title">Or deploy with a provider</h3>
          <p>Let a hosting platform run it for you.</p>
        </div>
        <div className="pdpp-cmd__providers">
          <ProviderCard method="railway" />
          <ProviderCard method="fly" />
        </div>
      </section>
    </div>
  );
}
