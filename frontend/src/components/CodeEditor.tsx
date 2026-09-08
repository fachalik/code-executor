import { useEffect, useRef, useState } from 'react';
import MonacoEditor, { OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import type { Language, Platform } from '@/types';
import { LANGUAGE_CONFIG } from '@/types';

interface Props {
  code:       string;
  language:   Language;
  platform:   Platform;
  onChange:   (value: string) => void;
  onRun:      () => void;
  disabled?:  boolean;
}

/**
 * Both sandbox engines hand input to the guest on a global `env` and take the
 * module's default export as the result. Without a declaration Monaco flags
 * every use of `env` as an undefined name, which reads as a bug in the starter
 * code. Piston has no such global, so the lib is registered per engine.
 */
const SANDBOX_GLOBALS = `
/** Input passed to this execution by the caller. */
declare const env: Record<string, any>;
`;

const SANDBOX_LIB = 'ts:sandbox-globals.d.ts';

/** The engines that expose `env`. Piston runs a plain script and does not. */
const SANDBOX_PLATFORMS: Platform[] = ['quickjs', 'isolated-vm'];

export function CodeEditor({ code, language, platform, onChange, onRun, disabled }: Props) {
  const monacoRef = useRef<typeof Monaco | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const [ready, setReady] = useState(false);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    // Ctrl/Cmd+Enter → run
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
      () => { if (!disabled) onRun(); }
    );

    editor.focus();
    setReady(true);
  };

  // Register the sandbox globals for the engines that have them, and take them
  // back down when the engine changes — `env` does not exist on Piston.
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;

    if (!SANDBOX_PLATFORMS.includes(platform)) return;

    const { javascriptDefaults, typescriptDefaults } = monaco.languages.typescript;
    const libs = [
      javascriptDefaults.addExtraLib(SANDBOX_GLOBALS, SANDBOX_LIB),
      typescriptDefaults.addExtraLib(SANDBOX_GLOBALS, SANDBOX_LIB),
    ];

    return () => libs.forEach(lib => lib.dispose());
  }, [platform, ready]);

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
