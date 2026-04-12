'use client';

import { useEffect, useRef } from 'react';
import { LogLine } from '@/lib/types';

interface Props {
  logs: LogLine[];
}

// ANSI colors
const C = {
  reset:   '\x1b[0m',
  dim:     '\x1b[2m',
  bold:    '\x1b[1m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  red:     '\x1b[31m',
  blue:    '\x1b[34m',
  cyan:    '\x1b[36m',
  magenta: '\x1b[35m',
  white:   '\x1b[37m',
};

function formatLine(log: LogLine): string {
  const time = `${C.dim}${log.timestamp}${C.reset}`;
  const icon = log.level === 'error' ? `${C.red}✗${C.reset}` :
               log.level === 'warn'  ? `${C.yellow}⚠${C.reset}` :
               log.level === 'success' ? `${C.green}✓${C.reset}` :
               `${C.blue}·${C.reset}`;
  const text = log.level === 'error'   ? `${C.red}${log.text}${C.reset}` :
               log.level === 'success' ? `${C.green}${log.text}${C.reset}` :
               log.level === 'warn'    ? `${C.yellow}${log.text}${C.reset}` :
               log.text;
  return `${time} ${icon} ${text}`;
}

export function TerminalPanel({ logs }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<import('@xterm/xterm').Terminal | null>(null);
  const fitRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null);
  const lastLogCount = useRef(0);

  // Initialise terminal once
  useEffect(() => {
    if (termRef.current || !containerRef.current) return;

    let term: import('@xterm/xterm').Terminal;
    let fit: import('@xterm/addon-fit').FitAddon;

    (async () => {
      const { Terminal } = await import('@xterm/xterm');
      const { FitAddon } = await import('@xterm/addon-fit');

      term = new Terminal({
        fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", ui-monospace, monospace',
        fontSize: 12,
        lineHeight: 1.4,
        cursorBlink: false,
        disableStdin: true,
        scrollback: 2000,
        theme: {
          background:          '#0d0d0f',
          foreground:          '#c8c8e0',
          cursor:              '#7c6af7',
          selectionBackground: '#2a2a3e',
          black:   '#15161e',
          red:     '#f87171',
          green:   '#4ade80',
          yellow:  '#fbbf24',
          blue:    '#818cf8',
          magenta: '#c084fc',
          cyan:    '#67e8f9',
          white:   '#e2e8f0',
          brightBlack:   '#44445a',
          brightRed:     '#f87171',
          brightGreen:   '#4ade80',
          brightYellow:  '#fbbf24',
          brightBlue:    '#818cf8',
          brightMagenta: '#c084fc',
          brightCyan:    '#67e8f9',
          brightWhite:   '#f8f8ff',
        },
      });

      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current!);
      fit.fit();
      termRef.current = term;
      fitRef.current = fit;

      // Welcome banner
      term.writeln(`${C.dim}─────────────────────────────────────────${C.reset}`);
      term.writeln(`${C.bold}${C.magenta}  PDPP Personal Server${C.reset} ${C.dim}v0.1.0${C.reset}`);
      term.writeln(`${C.dim}─────────────────────────────────────────${C.reset}`);
      term.writeln('');

      const ro = new ResizeObserver(() => fit?.fit());
      ro.observe(containerRef.current!);
    })();

    return () => {
      termRef.current?.dispose();
      termRef.current = null;
    };
  }, []);

  // Write new log lines
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (logs.length <= lastLogCount.current) return;

    const newLogs = logs.slice(lastLogCount.current);
    for (const log of newLogs) {
      term.writeln(formatLine(log));
    }
    lastLogCount.current = logs.length;
  }, [logs]);

  return (
    <div style={{
      background: 'var(--bg-panel)',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '14px 20px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexShrink: 0,
      }}>
        {/* macOS traffic lights */}
        <div style={{ display: 'flex', gap: 5, marginRight: 6 }}>
          {['#ff5f57', '#febc2e', '#28c840'].map(c => (
            <div key={c} style={{ width: 10, height: 10, borderRadius: '50%', background: c, opacity: 0.9 }} />
          ))}
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 13 }}>Server Log</div>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>personal-server · live output</div>
        </div>
        {logs.length > 0 && (
          <div style={{
            marginLeft: 'auto', fontSize: 10, fontFamily: 'ui-monospace, monospace',
            color: 'var(--fg-dim)',
          }}>
            {logs.length} lines
          </div>
        )}
      </div>

      {/* xterm.js container */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          overflow: 'hidden',
          padding: '8px 4px 4px 4px',
          // xterm needs exact dimensions
          minHeight: 0,
        }}
      />
    </div>
  );
}
