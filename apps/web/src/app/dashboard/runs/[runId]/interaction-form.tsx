'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { submitRunInteractionAction, type RunInteractionActionState } from './actions';

type InteractionField = {
  name: string;
  label: string | null;
  format: 'password' | 'text';
  required: boolean;
};

type Props = {
  runId: string;
  interactionId: string;
  kind: 'credentials' | 'otp' | 'manual_action' | string;
  message: string;
  fields: InteractionField[];
};

const INITIAL: RunInteractionActionState = { error: null, status: null };

export function RunInteractionForm({ runId, interactionId, kind, message, fields }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = React.useTransition();
  const [state, setState] = React.useState<RunInteractionActionState>(INITIAL);

  // Reset local state if a new interaction supersedes the current one.
  React.useEffect(() => {
    setState(INITIAL);
  }, [interactionId]);

  const submitWithStatus = React.useCallback(
    (formData: FormData, status: 'success' | 'cancelled') => {
      formData.set('status', status);
      formData.set('run_id', runId);
      formData.set('interaction_id', interactionId);
      startTransition(async () => {
        const next = await submitRunInteractionAction(INITIAL, formData);
        setState(next);
        if (!next.error) router.refresh();
      });
    },
    [runId, interactionId, router],
  );

  const handleSubmit = React.useCallback(
    (event: React.SyntheticEvent<HTMLFormElement>) => {
      event.preventDefault();
      const formData = new FormData(event.currentTarget);
      submitWithStatus(formData, 'success');
    },
    [submitWithStatus],
  );

  const handleCancel = React.useCallback(() => {
    submitWithStatus(new FormData(), 'cancelled');
  }, [submitWithStatus]);

  const showFields = kind !== 'manual_action' && fields.length > 0;
  const submitLabel =
    kind === 'manual_action'
      ? "I've completed this step — continue"
      : kind === 'otp'
        ? 'Submit code'
        : 'Submit credentials';

  return (
    <form
      onSubmit={handleSubmit}
      autoComplete="off"
      className="mt-3 flex flex-col gap-3"
      aria-label={`Answer interaction ${interactionId}`}
    >
      <p className="pdpp-caption text-muted-foreground">{message}</p>
      {showFields ? (
        <div className="grid gap-2">
          {fields.map((field) => (
            <label key={field.name} className="flex flex-col gap-1">
              <span className="pdpp-caption text-muted-foreground">
                {field.label || field.name}
                {field.required ? <span aria-hidden="true"> *</span> : null}
              </span>
              <Input
                name={field.name}
                type={field.format === 'password' ? 'password' : 'text'}
                autoComplete="off"
                required={field.required}
                spellCheck={false}
              />
            </label>
          ))}
        </div>
      ) : null}
      <p className="pdpp-caption text-muted-foreground">
        Values you submit here satisfy this run only. The reference server does not persist them as
        durable connector credentials, env vars, or timeline payloads.
      </p>
      {state.error ? (
        <p role="alert" className="pdpp-caption text-destructive">
          {state.error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? 'Submitting…' : submitLabel}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleCancel}
          disabled={isPending}
        >
          Cancel interaction
        </Button>
      </div>
    </form>
  );
}
