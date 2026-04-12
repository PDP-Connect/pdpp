'use client';

import { useRef, useEffect, useState } from 'react';
import { DemoPhase, InputRequest } from '@/lib/types';
import { SPEC, SpecRef } from '@/lib/spec-refs';
import { PurposeDocument } from './PurposeDocument';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardFooter } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

interface Props {
  phase: DemoPhase;
  browserStatus: 'idle' | 'running' | 'done' | 'error';
  streamCounts: Partial<Record<string, number>>;
  onFrame: (cb: (data: string) => void) => void;
  onViewportReady: (width: number, height: number) => void;
  onApproveResearch: () => void;
  onApproveAi: () => void;
  onDeny: () => void;
  onDenyAi: () => void;
  sendInput: (msg: unknown) => void;
  inputRequest: InputRequest | null;
  onInputResponse: (requestId: string, values: Record<string, string>) => void;
  onInputCancel: (requestId: string) => void;
}

const STREAMS = ['following_accounts', 'posts', 'ad_targeting'];

export function ServerPanel({
  phase, browserStatus, streamCounts,
  onFrame, onViewportReady, onApproveResearch, onApproveAi, onDeny, onDenyAi, sendInput,
  inputRequest, onInputResponse, onInputCancel,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 1280, height: 800 });
  const viewportRef = useRef(viewport);

  useEffect(() => {
    onFrame((data: string) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const img = new Image();
      img.onload = () => {
        const ctx = canvas.getContext('2d');
        if (ctx) ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      };
      img.src = `data:image/jpeg;base64,${data}`;
    });
  }, [onFrame]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ASPECT = 1280 / 800;
    const report = () => {
      const w = Math.round(el.clientWidth);
      const h = Math.round(w / ASPECT);
      if (w > 0) {
        const vp = { width: w, height: h };
        viewportRef.current = vp;
        setViewport(vp);
        onViewportReady(w, h);
      }
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isConsentingResearch = phase === 'consenting_research';
  const isConsentingAi       = phase === 'consenting_ai';
  const isShowingResults     = phase === 'showing_results';
  const isAuthenticating     = phase === 'authenticating';
  const showBrowser          = phase === 'scraping' || phase === 'done';

  const handleMouse = (e: React.MouseEvent<HTMLCanvasElement>, action: string) => {
    if (!showBrowser || browserStatus !== 'running') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const { width, height } = viewportRef.current;
    const sx = width / rect.width;
    const sy = height / rect.height;
    sendInput({ type: 'mouse', action, x: Math.round((e.clientX - rect.left) * sx), y: Math.round((e.clientY - rect.top) * sy), button: 'left' });
  };

  const totalRecords = Object.values(streamCounts).reduce((a, b) => (a || 0) + (b || 0), 0);

  return (
    <div ref={containerRef} className="flex flex-col h-full overflow-hidden bg-background">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0">
        <span className="text-xs font-medium text-muted-foreground">Personal Server</span>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
          <span className="text-xs text-muted-foreground">Online</span>
        </div>
      </div>

      <div className="flex-1 overflow-auto flex flex-col">

        {phase === 'idle' && (
          <div data-surface="stage" className="flex-1 flex flex-col items-center justify-center gap-6 px-6 py-8">
            <div className="text-center">
              <p className="text-sm text-muted-foreground">Waiting for a client app to connect</p>
            </div>
            <Card className="w-full max-w-sm">
              <CardContent className="p-4">
                <div className="text-xs font-medium text-muted-foreground mb-3">Already in this server</div>
                <table className="w-full">
                  <tbody>
                    {[
                      { label: 'following_accounts', count: '106' },
                      { label: 'posts',              count: '22'  },
                      { label: 'ad_targeting',       count: '1'   },
                    ].map(({ label, count }) => (
                      <tr key={label}>
                        <td className="font-mono text-xs font-medium pr-3 tabular-nums w-8 py-0.5">{count}</td>
                        <td className="text-xs text-muted-foreground font-mono">{label}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </div>
        )}

        {phase === 'requesting' && (
          <div className="flex-1 flex flex-col items-center justify-center gap-3">
            <Spinner />
            <p className="text-sm text-muted-foreground">Initializing personal server…</p>
          </div>
        )}

        {isConsentingResearch && (
          <div className="flex-1 overflow-auto p-6">
            <ConsentCard variant="research" step={1} totalSteps={2} onApprove={onApproveResearch} onDeny={onDeny} />
          </div>
        )}

        {isShowingResults && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6">
            <div className="text-center">
              <div className="text-sm font-medium text-foreground mb-1">Grant Active</div>
              <p className="text-xs text-muted-foreground max-w-[240px]">Research grant enforced. Your data was already here — no scraping needed.</p>
            </div>
            <div className="flex flex-col gap-1.5 w-full max-w-sm">
              {[
                { label: 'following_accounts', note: 'social_graph view — fields projected' },
                { label: 'posts', note: 'since consent — 0 records (pre-consent gated)' },
              ].map(({ label, note }) => (
                <Card key={label} size="sm">
                  <CardContent className="flex items-start gap-2 p-2.5">
                    <span className="text-xs text-primary shrink-0">✓</span>
                    <div>
                      <div className="font-mono text-xs font-medium text-foreground">{label}</div>
                      <div className="text-xs text-muted-foreground">{note}</div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">Awaiting AI training consent request…</p>
          </div>
        )}

        {isConsentingAi && (
          <div className="flex-1 overflow-auto p-6">
            <ConsentCard variant="ai_training" step={2} totalSteps={2} onApprove={onApproveAi} onDeny={onDenyAi} />
          </div>
        )}

        {isAuthenticating && inputRequest && (
          <div className="flex-1 flex flex-col p-6">
            <CredentialForm
              inputRequest={inputRequest}
              onSubmit={(values) => onInputResponse(inputRequest.requestId, values)}
              onCancel={() => onInputCancel(inputRequest.requestId)}
            />
          </div>
        )}

        {isAuthenticating && !inputRequest && (
          <div className="flex-1 flex flex-col items-center justify-center gap-3">
            <Spinner />
            <p className="text-sm text-muted-foreground">Waiting for browser to launch…</p>
          </div>
        )}

        {showBrowser && (
          <div className="flex flex-col flex-1 overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 bg-background border-b border-border shrink-0">
              <div className="flex gap-1.5">
                {['#ff5f57', '#febc2e', '#28c840'].map(c => (
                  <div key={c} className="w-2 h-2 rounded-full" style={{ background: c }} />
                ))}
              </div>
              <div className="flex-1 rounded px-2.5 py-1 text-xs text-muted-foreground font-mono bg-muted">
                instagram.com
              </div>
              {browserStatus === 'running' && (
                <div className="flex items-center gap-1.5">
                  <Spinner />
                  <span className="text-xs text-primary">Collecting…</span>
                </div>
              )}
              {browserStatus === 'done' && <span className="text-xs text-muted-foreground">Done</span>}
            </div>

            <div className="flex-1 overflow-hidden relative" style={{ background: '#1a1a1a', aspectRatio: `${viewport.width}/${viewport.height}` }}>
              <canvas
                ref={canvasRef}
                width={viewport.width}
                height={viewport.height}
                className="w-full h-full block"
                onMouseDown={e => handleMouse(e, 'mousePressed')}
                onMouseUp={e => handleMouse(e, 'mouseReleased')}
                onMouseMove={e => handleMouse(e, 'mouseMoved')}
              />
            </div>

            <div className="flex gap-3 px-4 py-3 border-t border-border bg-background shrink-0">
              {STREAMS.map(s => {
                const count = streamCounts[s];
                const done = count !== undefined;
                return (
                  <div key={s} className="flex-1 flex flex-col gap-1">
                    <div className="text-xs font-mono text-muted-foreground">{s}</div>
                    <div className="h-px rounded-full" style={{ background: done ? 'var(--success)' : browserStatus === 'running' ? 'var(--primary)' : 'var(--border)' }} />
                    <div className="text-xs text-muted-foreground">{done ? `${count}` : '—'}</div>
                  </div>
                );
              })}
              <div className="flex flex-col justify-center items-end gap-0.5">
                <div className="text-sm font-medium tabular-nums text-foreground">{totalRecords || '—'}</div>
                <div className="text-xs text-muted-foreground">records</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SpecLink({ spec }: { spec: SpecRef }) {
  return (
    <a href={spec.url} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-muted-foreground hover:text-foreground">
      {spec.label}
    </a>
  );
}

function ConsentCard({ variant, step, totalSteps, onApprove, onDeny }: {
  variant: 'research' | 'ai_training';
  step: number;
  totalSteps: number;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const [aiChecked, setAiChecked] = useState(false);
  const isAi = variant === 'ai_training';
  const canApprove = !isAi || aiChecked;
  const purposeKey = isAi ? 'pdpp.org/purpose/ai_training' : 'pdpp.org/purpose/research';

  return (
    <Card className="max-w-lg mx-auto w-full">
      <CardHeader className="p-5 pb-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-foreground">Audience Lens</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {isAi ? 'Additional request — AI training access' : 'Requesting access to your Instagram data'}
            </div>
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <div className="flex gap-1">
              {Array.from({ length: totalSteps }, (_, i) => (
                <div key={i} className="w-1.5 h-1.5 rounded-full" style={{
                  background: i < step - 1 ? 'var(--success)' : i === step - 1 ? 'var(--primary)' : 'var(--border)'
                }} />
              ))}
            </div>
            <div className="text-xs text-muted-foreground">{step} of {totalSteps}</div>
          </div>
        </div>
        <Badge variant="outline" className="w-fit text-xs mt-2">
          {isAi ? 'Ongoing access' : 'One-time access'}
        </Badge>
      </CardHeader>

      <Separator />

      <CardContent className="p-5 flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <div className="text-xs font-medium text-muted-foreground">Purpose</div>
          <div className="text-sm text-foreground">
            {isAi ? 'Use your social connections to improve recommendation models' : 'Analyze your social graph for an influencer network study'}
          </div>
          <PurposeDocument purposeUri={purposeKey} />
        </div>

        <div className="flex flex-col gap-1">
          <div className="text-xs font-medium text-muted-foreground mb-1">What they can access</div>
          <PermissionRow label="Who you follow" detail="Username & ID only — no bios, follower counts, or profile photos" allowed />
          {!isAi && <PermissionRow label="Your posts" detail="New posts only — nothing before you consent" allowed />}
          {!isAi && <PermissionRow label="Ad targeting data" detail="Not requested by this app" allowed={false} />}
        </div>

        {isAi && (
          <label className="flex items-start gap-2.5 cursor-pointer p-3 rounded-lg border border-border">
            <input
              type="checkbox"
              checked={aiChecked}
              onChange={e => setAiChecked(e.target.checked)}
              className="mt-0.5 shrink-0 w-4 h-4 cursor-pointer"
            />
            <div>
              <div className="text-sm font-medium text-foreground">I consent to AI model training</div>
              <div className="text-xs text-muted-foreground mt-0.5">My following data may be used to train recommendation models. I can revoke this anytime.</div>
            </div>
          </label>
        )}
      </CardContent>

      <Separator />

      <CardFooter className="p-5 flex flex-col gap-2 bg-transparent border-0">
        <Button onClick={onApprove} disabled={!canApprove} className="w-full">
          {isAi ? 'Allow AI Training Access' : 'Allow Research Access'}
        </Button>
        <Button variant="ghost" onClick={onDeny} className="w-full text-muted-foreground text-xs">
          Deny and cancel
        </Button>
      </CardFooter>

      <div className="px-5 pb-4 text-xs text-muted-foreground text-center">
        Audience Lens never touches your Instagram directly — your personal server collects and enforces all boundaries.
      </div>
    </Card>
  );
}

function PermissionRow({ label, detail, allowed }: { label: string; detail: string; allowed: boolean }) {
  return (
    <div className={`flex items-start gap-2 p-2 rounded-md ${allowed ? 'bg-muted/50' : 'opacity-40'}`}>
      <span className="text-xs shrink-0 mt-0.5 w-3">{allowed ? '✓' : '✗'}</span>
      <div>
        <div className="text-xs font-medium text-foreground">{label}</div>
        <div className="text-xs text-muted-foreground">{detail}</div>
      </div>
    </div>
  );
}

function CredentialForm({ inputRequest, onSubmit, onCancel }: {
  inputRequest: InputRequest;
  onSubmit: (values: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const kind = inputRequest.input.kind;
  const isOtp = kind === 'otp' || 'code' in (inputRequest.input.schema?.properties || {});
  const isManualAction = kind === 'manual_action';
  const [values, setValues] = useState<Record<string, string>>({});
  const [showPassword, setShowPassword] = useState(false);

  if (isManualAction) {
    return (
      <div className="max-w-md mx-auto w-full flex flex-col gap-4">
        <div>
          <div className="text-sm font-semibold text-foreground">{inputRequest.input.title}</div>
        </div>
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            {inputRequest.input.message || inputRequest.input.description}
          </CardContent>
        </Card>
        <div className="text-xs text-muted-foreground"><SpecLink spec={SPEC.collectionProfile} /> — INTERACTION kind: manual_action</div>
        <Button onClick={() => onSubmit({})} className="w-full">{inputRequest.input.submitLabel || 'Continue'}</Button>
        <Button variant="outline" onClick={onCancel} className="w-full">Cancel</Button>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto w-full flex flex-col gap-4">
      <div>
        <div className="text-sm font-semibold text-foreground">{inputRequest.input.title}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{inputRequest.input.description}</div>
      </div>
      <div className="text-xs text-muted-foreground"><SpecLink spec={SPEC.collectionProfile} /> — INTERACTION kind: {kind || 'credentials'}</div>

      <form onSubmit={e => { e.preventDefault(); onSubmit(values); }} className="flex flex-col gap-3">
        {Object.entries(inputRequest.input.schema?.properties || {}).map(([key, prop]) => {
          const uiSchema = (inputRequest.input.uiSchema?.[key] as Record<string, unknown>) || {};
          const isPassword = uiSchema['ui:widget'] === 'password';
          return (
            <div key={key} className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">{prop.title || key}</label>
              <div className="relative">
                <input
                  type={isPassword && !showPassword ? 'password' : 'text'}
                  placeholder={uiSchema['ui:placeholder'] as string || ''}
                  autoFocus={uiSchema['ui:autofocus'] === true}
                  value={values[key] || ''}
                  onChange={e => setValues(v => ({ ...v, [key]: e.target.value }))}
                  required
                  className="w-full px-3 py-2 rounded-md border border-border bg-card text-sm text-foreground outline-none focus:border-ring transition-colors"
                  style={{ paddingRight: isPassword ? '2.5rem' : undefined }}
                />
                {isPassword && (
                  <button type="button" onClick={() => setShowPassword(v => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground bg-transparent border-none cursor-pointer">
                    {showPassword ? 'hide' : 'show'}
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {inputRequest.input.error && (
          <div className="text-xs px-3 py-2 rounded-md text-destructive border border-destructive/25">
            {inputRequest.input.error}
          </div>
        )}

        <Button type="submit" className="w-full">{inputRequest.input.submitLabel || 'Submit'}</Button>
        <Button type="button" variant="outline" onClick={onCancel} className="w-full">Cancel</Button>
      </form>

      {!isOtp && (
        <p className="text-xs text-muted-foreground text-center">Your credentials are used once and never stored.</p>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <span className="w-3 h-3 rounded-full inline-block shrink-0" style={{
      border: '2px solid var(--border)',
      borderTopColor: 'var(--primary)',
      animation: 'spin 0.8s linear infinite',
    }} />
  );
}
