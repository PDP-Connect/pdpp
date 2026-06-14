"use client";

import { IcButton, IcInput } from "@pdpp/brand-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { type RenameConnectionResult, renameConnectionAction } from "./actions.ts";

interface Props {
  /**
   * Stable connection selector (`connection_id` / `connector_instance_id`).
   * Null only when the row is a connector-type fallback with no addressable
   * connection yet — rename is disabled in that case.
   */
  connectionId: string | null;
  /**
   * The owner-set label to seed the input with. Empty when the current label
   * is a fallback (bare connector type / registry URL), so the operator
   * starts from a blank field rather than re-typing a meaningless default.
   */
  currentLabel: string;
  /** Connector type name, shown as placeholder guidance (e.g. "Gmail"). */
  typeName: string;
}

/**
 * Inline edit-in-place rename for a connection's `display_name`. A "Rename"
 * button reveals a text field with Save/Cancel; the server action returns a
 * discriminated result so we can toast and refresh in place without a
 * redirect. The stable selector stays `connection_id`; the label is a
 * human-facing alias only.
 */
export function RenameConnection({ connectionId, currentLabel, typeName }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentLabel);
  const [isPending, startTransition] = useTransition();
  const [toast, setToast] = useState<{ tone: "info" | "error"; message: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Re-seed the field whenever the server-confirmed label changes (e.g. a
  // successful rename revalidates the page and feeds a new currentLabel).
  useEffect(() => {
    setValue(currentLabel);
  }, [currentLabel]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const id = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(id);
  }, [toast]);

  const cancel = useCallback(() => {
    setEditing(false);
    setValue(currentLabel);
    setToast(null);
  }, [currentLabel]);

  const submit = useCallback(() => {
    setToast(null);
    startTransition(async () => {
      const res: RenameConnectionResult = await renameConnectionAction(connectionId, value);
      if (res.ok === true) {
        setEditing(false);
        setToast({ tone: "info", message: `Renamed to "${res.display_name}"` });
        router.refresh();
        return;
      }
      setToast({ tone: "error", message: res.message });
    });
  }, [connectionId, router, value]);

  if (connectionId === null) {
    return null;
  }

  if (!editing) {
    return (
      <div className="flex flex-col items-end gap-1">
        <IcButton onClick={() => setEditing(true)} size="sm" variant="ghost">
          Rename
        </IcButton>
        {toast ? <Toast message={toast.message} tone={toast.tone} /> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <IcInput
          aria-label="Connection label"
          className="w-56"
          disabled={isPending}
          maxLength={200}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              cancel();
            }
          }}
          placeholder={`e.g. ${typeName} · personal`}
          ref={inputRef}
          value={value}
        />
        <IcButton disabled={isPending || !value.trim()} size="sm" type="submit">
          {isPending ? "Saving…" : "Save"}
        </IcButton>
        <IcButton disabled={isPending} onClick={cancel} size="sm" type="button" variant="ghost">
          Cancel
        </IcButton>
      </form>
      {toast ? <Toast message={toast.message} tone={toast.tone} /> : null}
    </div>
  );
}

function Toast({ message, tone }: { message: string; tone: "info" | "error" }) {
  return (
    <span
      aria-live="polite"
      className={tone === "error" ? "pdpp-caption text-destructive" : "pdpp-caption text-muted-foreground"}
      role="status"
    >
      {message}
    </span>
  );
}
