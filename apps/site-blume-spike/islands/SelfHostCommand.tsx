import { useState } from "react";

import {
  buildCommand,
  commandText,
  defaultChoices,
  METHODS,
  type MethodId,
} from "../../site/src/lib/self-host-command.ts";

export default function SelfHostCommand() {
  const [method, setMethod] = useState<MethodId>("docker");
  const [access, setAccess] = useState(defaultChoices.access);
  const [publicUrl, setPublicUrl] = useState(defaultChoices.publicUrl);
  const [semanticSearch, setSemanticSearch] = useState(defaultChoices.semanticSearch);
  const [copied, setCopied] = useState(false);
  const built = buildCommand(method, { access, publicUrl, semanticSearch });
  const command = built.segments ? commandText(built.segments) : null;

  const copy = async () => {
    if (!command) {
      return;
    }
    await navigator.clipboard.writeText(command);
    setCopied(true);
  };

  return (
    <section
      aria-label="Self-host command builder"
      className="my-6 rounded-blume border border-border bg-muted p-5"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-medium text-foreground">
          Method
          <select
            className="rounded-blume border border-border bg-background px-3 py-2"
            onChange={(event) => setMethod(event.target.value as MethodId)}
            value={method}
          >
            {METHODS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm font-medium text-foreground">
          Access
          <select
            className="rounded-blume border border-border bg-background px-3 py-2"
            onChange={(event) => setAccess(event.target.value as "local" | "public")}
            value={access}
          >
            <option value="local">This machine</option>
            <option value="public">Public HTTPS address</option>
          </select>
        </label>
      </div>
      {access === "public" && (
        <label className="mt-4 grid gap-1 text-sm font-medium text-foreground">
          Public address
          <input
            className="rounded-blume border border-border bg-background px-3 py-2"
            onChange={(event) => setPublicUrl(event.target.value)}
            placeholder="https://your-host"
            type="url"
            value={publicUrl}
          />
        </label>
      )}
      <label className="mt-4 flex items-center gap-2 text-sm text-foreground">
        <input
          checked={semanticSearch}
          onChange={(event) => setSemanticSearch(event.target.checked)}
          type="checkbox"
        />
        Full text and semantic search
      </label>
      {command ? (
        <>
          <div className="mt-4 overflow-x-auto whitespace-pre rounded-blume bg-foreground p-4 font-mono text-sm text-background">
            {command}
          </div>
          <button
            className="mt-4 rounded-blume bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
            onClick={copy}
            type="button"
          >
            {copied ? "Copied" : "Copy command"}
          </button>
        </>
      ) : (
        <p className="mt-4 text-muted-foreground">
          {built.unavailable} {built.unavailableHref && <a href={built.unavailableHref}>{built.unavailableLinkLabel}</a>}
        </p>
      )}
    </section>
  );
}
