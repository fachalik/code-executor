import { useRef } from 'react';
import MonacoEditor, { OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import type { Language } from '@/types';
import { LANGUAGE_CONFIG } from '@/types';

interface Props {
  code:       string;
  language:   Language;
  onChange:   (value: string) => void;
  onRun:      () => void;
  disabled?:  boolean;
}

export function CodeEditor({ code, language, onChange, onRun, disabled }: Props) {
  const monacoRef = useRef<typeof Monaco | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current  = editor;
    monacoRef.current  = monaco;

    // // Block fetch, XMLHttpRequest, require(package) in type-checking
    // monaco.languages.typescript.javascriptDefaults.addExtraLib(
    //   `
    //   /** @deprecated Network access is disabled in this sandbox */
    //   declare function fetch(...args: any[]): never;
    //   /** @deprecated Network access is disabled */
    //   declare class XMLHttpRequest { constructor() { throw new Error(); } }
    //   `,
    //   'ts:sandbox-restrictions.d.ts'
    // );
    // monaco.languages.typescript.typescriptDefaults.addExtraLib(
    //   `
    //   declare function fetch(...args: any[]): never;
    //   declare class XMLHttpRequest { constructor() { throw new Error(); } }
    //   `,
    //   'ts:sandbox-restrictions.d.ts'
    // );

    // Ctrl/Cmd+Enter → run
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
      () => { if (!disabled) onRun(); }
    );

    editor.focus();
  };

  const monacoLang = LANGUAGE_CONFIG[language]?.monacoId ?? 'javascript';

  return (
    <div className="flex-1 min-h-0 overflow-hidden">
      <MonacoEditor
        height="100%"
        language={monacoLang}
        value={code}
        theme="vs-dark"
        onChange={(val) => onChange(val ?? '')}
        onMount={handleMount}
        options={{
          fontSize:            14,
          fontFamily:          "'JetBrains Mono', 'Fira Code', monospace",
          fontLigatures:       true,
          lineHeight:          22,
          minimap:             { enabled: false },
          scrollBeyondLastLine: false,
          tabSize:             2,
          wordWrap:            'on',
          padding:             { top: 12, bottom: 12 },
          renderLineHighlight: 'gutter',
          smoothScrolling:     true,
          cursorBlinking:      'smooth',
          bracketPairColorization: { enabled: true },
          readOnly:            disabled,
          automaticLayout:     true,
          suggest: {
            // Disable suggestions that leak env info
            showFiles:   false,
            showFolders: false,
          },
        }}
      />
    </div>
  );
}
