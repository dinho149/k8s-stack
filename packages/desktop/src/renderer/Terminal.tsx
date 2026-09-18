import React, { useEffect, useRef } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
export function Terminal({
  taskId,
  onError,
}: {
  taskId: string;
  onError: (message: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let key = '',
      disposed = false;
    const term = new Xterm({
      fontFamily: 'IBM Plex Mono',
      fontSize: 12,
      theme: { background: '#18243b', foreground: '#e6ecf7' },
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    fit.fit();
    const off = window.dogfood.onEvent((event) => {
      if (event.type === 'terminal' && event.terminalId === key) term.write(event.text ?? '');
    });
    void window.dogfood
      .call<string>('terminal.open', { id: taskId })
      .then((id) => {
        key = id;
        if (disposed) {
          void window.dogfood.call('terminal.close', { terminalId: id }).catch(() => {});
          return;
        }
        term.focus();
      })
      .catch((error) => onError(String(error)));
    const input = term.onData((text) => {
      if (key)
        void window.dogfood
          .call('terminal.write', { terminalId: key, text })
          .catch((error) => onError(String(error)));
    });
    const observer = new ResizeObserver(() => {
      fit.fit();
      if (key)
        void window.dogfood
          .call('terminal.resize', { terminalId: key, cols: term.cols, rows: term.rows })
          .catch(() => {});
    });
    observer.observe(host.current!);
    return () => {
      disposed = true;
      off();
      input.dispose();
      observer.disconnect();
      term.dispose();
      if (key) void window.dogfood.call('terminal.close', { terminalId: key }).catch(() => {});
    };
  }, [taskId]);
  return <div className="terminal-host" ref={host} />;
}
