import React, { useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript, localCompletionSource, snippets } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import { autocompletion, Completion, CompletionContext } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import { Code, Copy, Check, Sparkles } from 'lucide-react';
import { ThemeMode } from '../types';

interface CodeEditorProps {
  value: string;
  onChange: (val: string) => void;
  height?: string;
  theme?: ThemeMode;
}

const EDITOR_COLORS: Record<ThemeMode, { bg: string; toolbarBg: string; border: string; text: string }> = {
  dark: { bg: '#1e1e1e', toolbarBg: '#252526', border: 'border-slate-800', text: 'text-slate-300' },
  light: { bg: '#ffffff', toolbarBg: '#f8fafc', border: 'border-slate-200', text: 'text-slate-600' },
  midnight: { bg: '#000000', toolbarBg: '#09090b', border: 'border-zinc-800', text: 'text-zinc-300' },
};

// Route sandbox globals surfaced to auto-completion when typing request./response.
const REQUEST_PROPS: Completion[] = [
  { label: 'method', type: 'property', detail: 'HTTP method' },
  { label: 'url', type: 'property', detail: 'Full request URL' },
  { label: 'path', type: 'property', detail: 'Request path' },
  { label: 'headers', type: 'property', detail: 'Request headers object' },
  { label: 'query', type: 'property', detail: 'URL query parameters' },
  { label: 'body', type: 'property', detail: 'Parsed request body' },
  { label: 'params', type: 'property', detail: 'Route URL params' },
  { label: 'host', type: 'property', detail: 'Request host' },
  { label: 'ip', type: 'property', detail: 'Client IP' },
];

const RESPONSE_METHODS: Completion[] = [
  { label: 'status', type: 'function', detail: 'Set HTTP status code' },
  { label: 'json', type: 'function', detail: 'Send JSON response body' },
  { label: 'send', type: 'function', detail: 'Send text response body' },
  { label: 'setHeader', type: 'function', detail: 'Set a response header' },
  { label: 'redirect', type: 'function', detail: 'Redirect to a URL' },
];

const JS_COMPLETIONS: Completion[] = [
  { label: 'request', type: 'variable', detail: 'HTTP request object' },
  { label: 'response', type: 'variable', detail: 'HTTP response object' },
];

// Combined completion source layered on top of the editor. When the cursor is
// inside a sandbox member (`request.` / `response.`) it surfaces the sandbox
// API first, then always merges in the language's own context-aware JS
// completions (`localCompletionSource`) plus the JS snippets, so the popup is
// never poorer than a plain CodeMirror JS editor.
const completionSource = (context: CompletionContext) => {
  const before = context.matchBefore(/[a-zA-Z_$][\w$]*\.?/);
  const local = localCompletionSource(context);
  if (!before) return local;
  const text = before.text;
  let extra: Completion[] = [];
  if (text.startsWith('request.')) {
    extra = REQUEST_PROPS;
  } else if (text.startsWith('response.')) {
    extra = RESPONSE_METHODS;
  } else if (!text.includes('.')) {
    extra = [...JS_COMPLETIONS, ...snippets];
  }
  if (!extra.length) return local;
  const options = [...extra];
  if (local && Array.isArray(local.options)) {
    for (const o of local.options) {
      if (!options.some(e => e.label === o.label)) options.push(o);
    }
  }
  return { from: before.from, options };
};

// Small global overrides: 13px monospace, match the host editor chrome.
const editorTheme = EditorView.theme({
  '&': { fontSize: '13px', height: '100%' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
  '&.cm-focused': { outline: 'none' },
});

// JS Completion hints for the fallback toolbar suggestion panel
const JS_SUGGESTIONS = [
  { label: 'response.status(200)', detail: 'Set HTTP status code', insert: 'response.status(200)' },
  { label: 'response.json({ ... })', detail: 'Send JSON response', insert: 'response.json({\n  success: true,\n  data: {}\n});' },
  { label: 'response.send("...")', detail: 'Send raw response', insert: 'response.send("OK");' },
  { label: 'request.body', detail: 'Access parsed request body', insert: 'request.body' },
  { label: 'request.query', detail: 'Access URL query parameters', insert: 'request.query' },
  { label: 'request.headers', detail: 'Access request headers', insert: 'request.headers' },
  { label: 'request.params', detail: 'Access route URL params', insert: 'request.params' },
  { label: 'request.method', detail: 'Get HTTP method string', insert: 'request.method' },
  { label: 'fetch(url, options)', detail: 'Outbound HTTP request', insert: 'const res = await fetch(url, {\n  method: \'GET\',\n  headers: { \'Accept\': \'application/json\' }\n});\nconst data = await res.json();' },
  { label: 'console.log(...)', detail: 'Write to server log', insert: 'console.log(...)' },
  { label: 'async arrow handler', detail: 'async (request, response) => { ... }', insert: 'async (request, response) => {\n  \n}' },
];

export const CodeEditor: React.FC<CodeEditorProps> = ({ value, onChange, height = '100%', theme = 'dark' }) => {
  const [copied, setCopied] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const colors = EDITOR_COLORS[theme];

  const extensions = [
    javascript(),
    autocompletion({ override: [completionSource] }),
    editorTheme,
  ];

  const copyCode = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const insertSnippet = (snippet: string) => {
    onChange(value + '\n' + snippet);
    setShowSuggestions(false);
  };

  return (
    <div className={`flex flex-col h-full border ${colors.border} rounded-xl overflow-hidden font-mono text-xs shadow-inner transition-colors`} style={{ backgroundColor: colors.bg }}>
      {/* Editor Sub-toolbar */}
      <div className={`px-3 py-1.5 border-b ${colors.border} flex items-center justify-between text-[11px] ${colors.text} font-mono shrink-0 transition-colors`} style={{ backgroundColor: colors.toolbarBg }}>
        <span className="flex items-center gap-1.5">
          <Code className="w-3.5 h-3.5 text-indigo-400" />
          <span>Script Handler: <code className="text-emerald-400">async (request, response)</code></span>
        </span>

        <div className="flex items-center gap-2">
          {/* Quick JS Hints Toggle */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowSuggestions(!showSuggestions)}
              className="flex items-center gap-1 px-2 py-0.5 rounded text-amber-300 hover:text-amber-200 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 transition-colors"
            >
              <Sparkles className="w-3 h-3" />
              <span>JS Hints</span>
            </button>

            {/* Suggestions Popup */}
            {showSuggestions && (
              <div className={`absolute right-0 top-full mt-1.5 z-50 w-64 border ${colors.border} rounded-xl shadow-2xl p-1.5 space-y-1 text-xs transition-colors`} style={{ backgroundColor: colors.toolbarBg }}>
                <div className={`text-[10px] ${colors.text} opacity-70 px-2 py-1 uppercase tracking-wider font-semibold border-b ${colors.border}`}>
                  JavaScript Code Hints
                </div>
                {JS_SUGGESTIONS.map((s, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => insertSnippet(s.insert)}
                    className="w-full text-left px-2 py-1.5 rounded hover:bg-indigo-600/30 hover:text-white transition-colors flex flex-col group"
                  >
                    <span className="font-mono text-indigo-300 group-hover:text-indigo-200 font-semibold">{s.label}</span>
                    <span className={`text-[10px] ${colors.text} opacity-70`}>{s.detail}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={copyCode}
            className={`flex items-center gap-1 px-2 py-0.5 rounded ${colors.text} hover:opacity-80 border ${colors.border} transition-colors`}
            style={{ backgroundColor: colors.toolbarBg }}
          >
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
      </div>

      {/* CodeMirror editor */}
      <div className="relative flex-1 min-h-[200px] overflow-hidden" style={{ backgroundColor: colors.bg }}>
        <CodeMirror
          value={value}
          height={height}
          theme={theme === 'light' ? undefined : oneDark}
          extensions={extensions}
          basicSetup={{
            lineNumbers: true,
            highlightActiveLineGutter: true,
            highlightActiveLine: true,
            foldGutter: false,
            autocompletion: false,
            bracketMatching: true,
            closeBrackets: true,
            indentOnInput: true,
            highlightSelectionMatches: true,
            searchKeymap: false,
          }}
          onChange={(val) => onChange(val)}
          style={{ height: '100%' }}
        />
      </div>
    </div>
  );
};