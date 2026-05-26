"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { type RenameConnectionResult, renameConnectionAction } from "./actions.ts";

interface Props {
  connectionId: string;
  currentDisplayName: string;
}

export function RenameConnectionButton({ connectionId, currentDisplayName }: Props) {
  const router = useRouter();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(currentDisplayName);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  // Reset draft when the source-of-truth changes underneath us (e.g. after
  // a successful submit + router.refresh).
  useEffect(() => {
    setDraft(currentDisplayName);
  }, [currentDisplayName]);

  const startEditing = useCallback(() => {
    setError(null);
    setDraft(currentDisplayName);
    setIsEditing(true);
  }, [currentDisplayName]);

  const cancel = useCallback(() => {
    setIsEditing(false);
    setError(null);
    setDraft(currentDisplayName);
  }, [currentDisplayName]);

  const submit = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setError("Name cannot be empty.");
      return;
    }
    if (trimmed === currentDisplayName) {
      cancel();
      return;
    }
    setError(null);
    startTransition(async () => {
      const res: RenameConnectionResult = await renameConnectionAction(connectionId, trimmed);
      if (res.ok === true) {
        setIsEditing(false);
        router.refresh();
        return;
      }
      setError(res.message);
    });
  }, [cancel, connectionId, currentDisplayName, draft, router]);

  if (!isEditing) {
    return (
      <Button
        aria-label={`Rename ${currentDisplayName}`}
        onClick={startEditing}
        size="sm"
        type="button"
        variant="outline"
      >
        Rename
      </Button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <Input
          aria-label="New connection name"
          className="w-48"
          disabled={isPending}
          maxLength={200}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          ref={inputRef}
          value={draft}
        />
        <Button disabled={isPending} onClick={submit} size="sm" type="button">
          {isPending ? "Saving…" : "Save"}
        </Button>
        <Button disabled={isPending} onClick={cancel} size="sm" type="button" variant="outline">
          Cancel
        </Button>
      </div>
      {error ? (
        <span aria-live="polite" className="pdpp-caption text-destructive" role="status">
          {error}
        </span>
      ) : null}
    </div>
  );
}
