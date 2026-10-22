import { useEffect, useRef, useState } from 'react';
import { basicSetup, EditorView } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { editorLanguage } from '../editor-languages';
import type { Extension } from '@codemirror/state';
import type { ThemeMode } from '../types';

interface CodeEditorProps {
  path: string;
  value: string;
  language: string;
  theme: ThemeMode;
  onChange: (value: string) => void;
  readOnly?: boolean;
}

export function CodeEditor({ path, value, language, theme, onChange, readOnly = false }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const changeRef = useRef(onChange);
  const [loadedLanguage, setLoadedLanguage] = useState<{ id: string; extension?: Extension } | null>(null);
  changeRef.current = onChange;

  useEffect(() => {
    let current = true;
    void editorLanguage(language).then((extension) => {
      if (current) setLoadedLanguage({ id: language, extension });
    }).catch(() => {
      if (current) setLoadedLanguage({ id: language });
    });
    return () => { current = false; };
  }, [language]);

  useEffect(() => {
    if (!hostRef.current) return;
    const extensions = [
      basicSetup,
      EditorView.lineWrapping,
      EditorView.editable.of(!readOnly),
      EditorState.readOnly.of(readOnly),
      ...(theme === 'dark' ? [oneDark] : []),
      ...(loadedLanguage?.id === language && loadedLanguage.extension ? [loadedLanguage.extension] : []),
      ...(!readOnly ? [EditorView.updateListener.of((update) => {
        if (update.docChanged) changeRef.current(update.state.doc.toString());
      })] : []),
    ];
    const view = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Rebuild only when the active file or syntax/theme changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, language, theme, loadedLanguage, readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  return <div className="editor-host" ref={hostRef} aria-label={`محرر الملف ${path}`} />;
}
