'use client';

import { useEffect, useRef } from 'react';
import { LogLine } from '@/lib/types';

interface Props {
  logs: LogLine[];
}

export function LogPanel({ logs }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<import('@xterm/xterm').Terminal | null>(null);
  const fitRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null);
  const lastLogCount = useRef(0);
  const roRef = useRef<ResizeObserver | null>(null);

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
    gray:    '\x1b[90m',
    white:   '\x1b[97m',
  };

  function formatLine(log: LogLine): string {
    const time = `${C.dim}${log.timestamp}${C.reset}`;

    const icon = log.level === 'error'   ? `${C.red}✗${C.reset}`     :
                 log.level === 'warn'    ? `${C.yellow}▲${C.reset}`   :
                 log.level === 'success' ? `${C.green}✓${C.reset}`    :
                 log.level === 'spec'    ? `${C.magenta}§${C.reset}`  :
                 `${C.blue}·${C.reset}`;

    const text = log.level === 'error'   ? `${C.red}${log.text}${C.reset}`     :
                 log.level === 'success' ? `${C.green}${log.text}${C.reset}`   :
                 log.level === 'warn'    ? `${C.yellow}${log.text}${C.reset}`  :
                 log.level === 'spec'    ? `${C.magenta}${log.text}${C.reset}` :
                 `${C.white}${log.text}${C.reset}`;

    const detail = log.detail ? `\r\n  ${C.dim}${C.gray}${log.detail}${C.reset}` : '';

    return `${time} ${icon} ${text}${detail}`;
  }

  useEffect(() => {
    if (termRef.current || !containerRef.current) return;

    (async () => {
      await import('@xterm/xterm/css/xterm.css');
      const { Terminal } = await import('@xterm/xterm');
      const { FitAddon } = await import('@xterm/addon-fit');

      const term = new Terminal({
        fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, monospace',
        fontSize: 11,
        lineHeight: 1.45,
        cursorBlink: false,
        disableStdin: true,
        scrollback: 5000,
        theme: {
          background:          '#0c0c12',
          foreground:          '#c8c8e8',
          cursor:              '#4338ca',
          selectionBackground: '#1a1a2e',
          black:               '#0e0e16',
          red:                 '#f87171',
          green:               '#34d399',
          yellow:              '#fbbf24',
          blue:                '#818cf8',
          magenta:             '#c084fc',
          cyan:                '#67e8f9',
          white:               '#e2e2f8',
          brightBlack:         '#3a3a58',
          brightRed:           '#f87171',
          brightGreen:         '#34d399',
          brightYellow:        '#fbbf24',
          brightBlue:          '#818cf8',
          brightMagenta:       '#c084fc',
          brightCyan:          '#67e8f9',
          brightWhite:         '#f8f8ff',
        },
      });

      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current!);
      termRef.current = term;
      fitRef.current = fit;

      const writeBanner = () => {
        term.writeln(`${C.dim}PDPP server log — § lines are spec citations${C.reset}`);
        term.writeln('');
      };

      const ro = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry && entry.contentRect.width > 0 && entry.contentRect.height > 0) {
          fit.fit();
          writeBanner();
        }
      });
      ro.observe(containerRef.current!);
      roRef.current = ro;

      const rect = containerRef.current!.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        fit.fit();
        writeBanner();
      }
    })();

    return () => {
      roRef.current?.disconnect();
      termRef.current?.dispose();
      termRef.current = null;
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (logs.length <= lastLogCount.current) {
      if (logs.length === 0) lastLogCount.current = 0;
      return;
    }
    const newLogs = logs.slice(lastLogCount.current);
    for (const log of newLogs) {
      term.writeln(formatLine(log));
    }
    lastLogCount.current = logs.length;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logs]);

  return (
    <div className="flex flex-col h-full overflow-hidden bg-surface-panel">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0">
        <div className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--text-disabled)' }}>Server Log</div>
        <div className="flex-1" />
        {logs.length > 0 && (
          <div className="text-[10px] font-mono" style={{ color: 'var(--text-disabled)' }}>{logs.length} events</div>
        )}
      </div>

      {/* Terminal — dark console pane, contained within the light panel */}
      <div className="flex-1 overflow-hidden min-h-0" style={{ background: '#0c0c12' }}>
        <div
          ref={containerRef}
          className="w-full h-full"
          style={{ padding: '6px 2px 2px' }}
        />
      </div>
    </div>
  );
}
