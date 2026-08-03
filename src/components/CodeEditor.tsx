import React, { useState } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import { Code, Copy, Check, Sparkles } from 'lucide-react';

interface CodeEditorProps {
  value: string;
  onChange: (val: string) => void;
  height?: string;
}

// JS Completion suggestions for the fallback editor
const JS_SUGGESTIONS = [
  { label: 'response.status(200)', detail: 'Set HTTP status code', insert: 'response.status(200)' },
  { label: 'response.json({ ... })', detail: 'Send JSON response', insert: 'response.json({\n  success: true,\n  data: {}\n});' },
  { label: 'response.send("...")', detail: 'Send raw response', insert: 'response.send("OK");' },
  { label: 'request.body', detail: 'Access parsed request body', insert: 'request.body' },
  { label: 'request.query', detail: 'Access URL query parameters', insert: 'request.query' },
  { label: 'request.headers', detail: 'Access request headers', insert: 'request.headers' },
  { label: 'request.params', detail: 'Access route URL params', insert: 'request.params' },
  { label: 'request.method', detail: 'Get HTTP method string', insert: 'request.method' },
];

export const CodeEditor: React.FC<CodeEditorProps> = ({ value, onChange, height = '100%' }) => {
  const [copied, setCopied] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // Configure Monaco Editor JS Type Definitions & Completion
  const handleEditorDidMount: OnMount = (_editor, monaco) => {

    try {
      // Configure JS compiler options & IntelliSense
      monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: false,
        noSyntaxValidation: false,
      });

      monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
        target: monaco.languages.typescript.ScriptTarget.ES2020,
        allowNonTsExtensions: true,
      });

      // Add typings for request and response parameters
      const extraLib = `
        declare interface RequestObject {
          method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | string;
          url: string;
          path: string;
          headers: Record<string, string>;
          query: Record<string, string>;
          body: any;
          params: Record<string, string>;
          ip: string;
        }

        declare interface ResponseObject {
          status(code: number): ResponseObject;
          json(data: any): ResponseObject;
          send(data: string | object): ResponseObject;
          setHeader(name: string, value: string): ResponseObject;
          redirect(url: string, status?: number): ResponseObject;
        }

        declare const request: RequestObject;
        declare const response: ResponseObject;
        declare const fs: {
          readFileSync(path: string, encoding?: string): string | Buffer;
          writeFileSync(path: string, data: string | Buffer, encoding?: string): void;
          appendFileSync(path: string, data: string | Buffer, encoding?: string): void;
          existsSync(path: string): boolean;
          unlinkSync(path: string): void;
          mkdirSync(path: string, options?: any): void;
        };
      `;

      monaco.languages.typescript.javascriptDefaults.addExtraLib(
        extraLib,
        'ts:filename/globals.d.ts'
      );

      // Register completion provider for request and response
      monaco.languages.registerCompletionItemProvider('javascript', {
        provideCompletionItems: (model, position) => {
          const word = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };

          const suggestions = [
            {
              label: 'response.status',
              kind: monaco.languages.CompletionItemKind.Method,
              insertText: 'response.status(${1:200})',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Set HTTP response status code',
              range,
            },
            {
              label: 'response.json',
              kind: monaco.languages.CompletionItemKind.Method,
              insertText: 'response.json({\n\t$1\n});',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Send JSON response body',
              range,
            },
            {
              label: 'response.send',
              kind: monaco.languages.CompletionItemKind.Method,
              insertText: 'response.send("${1:OK}");',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Send text response body',
              range,
            },
            {
              label: 'request.body',
              kind: monaco.languages.CompletionItemKind.Property,
              insertText: 'request.body',
              documentation: 'Parsed HTTP request body',
              range,
            },
            {
              label: 'request.query',
              kind: monaco.languages.CompletionItemKind.Property,
              insertText: 'request.query',
              documentation: 'URL query parameters',
              range,
            },
            {
              label: 'request.headers',
              kind: monaco.languages.CompletionItemKind.Property,
              insertText: 'request.headers',
              documentation: 'HTTP request headers object',
              range,
            }
          ];

          return { suggestions };
        }
      });
    } catch (e) {
      console.warn('Monaco configuration warning:', e);
    }
  };

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
    <div className="flex flex-col h-full border border-slate-800 rounded-xl overflow-hidden bg-[#1e1e1e] font-mono text-xs shadow-inner">
      {/* Editor Sub-toolbar */}
      <div className="px-3 py-1.5 bg-[#252526] border-b border-slate-800 flex items-center justify-between text-[11px] text-slate-300 font-mono shrink-0">
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
              <div className="absolute right-0 top-full mt-1.5 z-50 w-64 bg-[#252526] border border-slate-700 rounded-xl shadow-2xl p-1.5 space-y-1 text-xs">
                <div className="text-[10px] text-slate-400 px-2 py-1 uppercase tracking-wider font-semibold border-b border-slate-700/60">
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
                    <span className="text-[10px] text-slate-400">{s.detail}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={copyCode}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-slate-400 hover:text-slate-200 bg-slate-800/80 hover:bg-slate-700 border border-slate-700 transition-colors"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
      </div>

      {/* Monaco Editor */}
      <div className="relative flex-1 min-h-[200px] overflow-hidden bg-[#1e1e1e]">
        <Editor
          height={height}
          defaultLanguage="javascript"
          language="javascript"
          theme="vs-dark"
          value={value}
          onChange={(val) => onChange(val || '')}
          onMount={handleEditorDidMount}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2,
            suggestOnTriggerCharacters: true,
            quickSuggestions: {
              other: true,
              comments: false,
              strings: true,
            },
            formatOnType: true,
            snippetSuggestions: 'top',
            wordWrap: 'on',
          }}
        />
      </div>
    </div>
  );
};
