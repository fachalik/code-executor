import { useState, useCallback } from 'react';
import { Play, RotateCcw, Terminal, Cpu } from 'lucide-react';
import { CodeEditor } from '@/components/CodeEditor';
import { OutputPanel } from '@/components/OutputPanel';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { useExecutor } from '@/hooks/useExecutor';
import { LANGUAGE_CONFIG, PLATFORM_CONFIG, getDefaultCode } from '@/types';
import type { Language, Platform } from '@/types';

const PLATFORMS = Object.entries(PLATFORM_CONFIG) as [Platform, typeof PLATFORM_CONFIG[Platform]][];

const INITIAL_PLATFORM: Platform = 'quickjs';
const INITIAL_LANGUAGE: Language = 'javascript';

export default function App() {
  const [platform, setPlatform] = useState<Platform>(INITIAL_PLATFORM);
  const [language, setLanguage] = useState<Language>(INITIAL_LANGUAGE);
  const [code,     setCode]     = useState(getDefaultCode(INITIAL_PLATFORM, INITIAL_LANGUAGE));

  const { result, loading, error, run, clear } = useExecutor();

  const platformConfig = PLATFORM_CONFIG[platform];

  /**
   * The two engines do not run the same languages, so switching platform may
   * strand the current one — Python on QuickJS, TypeScript on Piston. Fall back
   * to the platform's first language instead of sending a request the backend
   * will reject.
   */
  const handlePlatformChange = useCallback((next: Platform) => {
    const cfg = PLATFORM_CONFIG[next];
    const nextLanguage = cfg.languages.includes(language) ? language : cfg.languages[0];
    setPlatform(next);
    setLanguage(nextLanguage);
    setCode(getDefaultCode(next, nextLanguage));
    clear();
  }, [language, clear]);

  const handleLanguageChange = useCallback((lang: Language) => {
    setLanguage(lang);
    setCode(getDefaultCode(platform, lang));
    clear();
  }, [platform, clear]);

  const handleRun = useCallback(() => {
    run(code, language, platform);
  }, [run, code, language, platform]);

  const handleReset = useCallback(() => {
    setCode(getDefaultCode(platform, language));
    clear();
  }, [platform, language, clear]);

  return (
    <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">

      {/* ── Topbar ───────────────────────────────────────────────────────── */}
      <header className="flex items-center gap-3 px-4 h-12 border-b border-border flex-shrink-0">
        <Terminal className="w-4 h-4 text-primary" />
        <span className="font-mono text-sm font-semibold tracking-tight">
          code<span className="text-primary">executor</span>
        </span>

        <Separator orientation="vertical" className="mx-1 h-5" />

        {/* Engine selector */}
        <div className="flex items-center gap-1.5">
          <Cpu className="w-3.5 h-3.5 text-muted-foreground" />
          <Select value={platform} onValueChange={(v) => handlePlatformChange(v as Platform)}>
            <SelectTrigger className="w-[150px] h-7 text-xs font-mono" title={platformConfig.description}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PLATFORMS.map(([id, cfg]) => (
                <SelectItem key={id} value={id} className="text-xs font-mono">
                  <span className="flex flex-col items-start">
                    <span>{cfg.label}</span>
                    <span className="text-[10px] text-muted-foreground">{cfg.description}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Language selector — options follow the selected engine */}
        <Select value={language} onValueChange={(v) => handleLanguageChange(v as Language)}>
          <SelectTrigger className="w-[140px] h-7 text-xs font-mono">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {platformConfig.languages.map((lang) => (
              <SelectItem key={lang} value={lang} className="text-xs font-mono">
                {LANGUAGE_CONFIG[lang].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="ml-auto flex items-center gap-2">
          <Badge variant="outline" className="text-[10px] font-mono hidden sm:flex">
            {platformConfig.note}
          </Badge>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleReset}
            title="Reset to default code"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </Button>
          <Button
            size="sm"
            className="h-7 gap-1.5 font-mono text-xs"
            onClick={handleRun}
            disabled={loading}
          >
            <Play className="w-3.5 h-3.5" />
            {loading ? 'Running…' : 'Run'}
          </Button>
        </div>
      </header>

      {/* ── Main pane ────────────────────────────────────────────────────── */}
      <div className="flex-1 flex min-h-0 overflow-hidden">

        {/* Editor — left / top */}
        <div className="flex flex-col flex-1 min-h-0 min-w-0 border-r border-border">
          {/* Editor header */}
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/50 flex-shrink-0 bg-card">
            <span className="font-mono text-xs text-muted-foreground">
              {LANGUAGE_CONFIG[language].label.toLowerCase()} · {platform} · editor
            </span>
            <span className="ml-auto font-mono text-[10px] text-muted-foreground hidden sm:block">
              Ctrl+Enter to run
            </span>
          </div>
          <CodeEditor
            code={code}
            language={language}
            platform={platform}
            onChange={setCode}
            onRun={handleRun}
            disabled={loading}
          />
        </div>

        {/* Output — right / bottom */}
        <div className="flex flex-col w-[42%] min-w-[280px] max-w-[560px] min-h-0 flex-shrink-0">
          {/* Output header */}
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/50 flex-shrink-0 bg-card">
            <Terminal className="w-3 h-3 text-muted-foreground" />
            <span className="font-mono text-xs text-muted-foreground">output</span>
          </div>
          <OutputPanel result={result} loading={loading} error={error} />
        </div>
      </div>
    </div>
  );
}
