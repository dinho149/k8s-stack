import React, { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker';
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker';
(globalThis as any).MonacoEnvironment = {
  getWorker: (_: string, label: string) =>
    label === 'typescript' || label === 'javascript'
      ? new TsWorker()
      : label === 'json'
        ? new JsonWorker()
        : ['css', 'scss', 'less'].includes(label)
          ? new CssWorker()
          : ['html', 'handlebars', 'razor'].includes(label)
            ? new HtmlWorker()
            : new EditorWorker(),
};
export function Editor({
  path,
  value,
  onChange,
  readOnly = false,
  dark = false,
}: {
  path: string;
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  dark?: boolean;
}) {
  const element = useRef<HTMLDivElement>(null),
    editor = useRef<monaco.editor.IStandaloneCodeEditor>();
  const change = useRef(onChange);
  change.current = onChange;
  useEffect(() => {
    const language = /\.tsx?$/.test(path)
      ? 'typescript'
      : /\.jsx?$/.test(path)
        ? 'javascript'
        : path.endsWith('.json')
          ? 'json'
          : path.endsWith('.css')
            ? 'css'
            : path.endsWith('.md')
              ? 'markdown'
              : 'plaintext';
    const instance = monaco.editor.create(element.current!, {
      value,
      language,
      theme: dark ? 'vs-dark' : 'vs',
      automaticLayout: true,
      fontFamily: 'IBM Plex Mono',
      fontSize: 12,
      minimap: { enabled: false },
      padding: { top: 16 },
      scrollBeyondLastLine: false,
      wordWrap: 'on',
      readOnly,
    });
    editor.current = instance;
    const listener = instance.onDidChangeModelContent(() => change.current(instance.getValue()));
    return () => {
      listener.dispose();
      instance.getModel()?.dispose();
      instance.dispose();
    };
  }, [path]);
  useEffect(() => {
    if (editor.current && editor.current.getValue() !== value) editor.current.setValue(value);
  }, [value]);
  useEffect(() => {
    editor.current?.updateOptions({ readOnly });
    monaco.editor.setTheme(dark ? 'vs-dark' : 'vs');
  }, [readOnly, dark]);
  return <div ref={element} className="code-editor" aria-label={`Editor for ${path}`} />;
}
