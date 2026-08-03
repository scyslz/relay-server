import React from 'react';
import { ThemeMode } from '../types';

/**
 * Syntax color palette per theme.
 */
const SYNTAX_COLORS: Record<ThemeMode, {
  comment: string;
  string: string;
  number: string;
  keyword: string;
  builtin: string;
  funcName: string;
  methodName: string;
  propertyName: string;
  ident: string;
  symbol: string;
}> = {
  dark: {
    comment: 'text-slate-500',
    string: 'text-amber-300',
    number: 'text-orange-400',
    keyword: 'text-purple-400',
    builtin: 'text-sky-300',
    funcName: 'text-yellow-300',
    methodName: 'text-yellow-300',
    propertyName: 'text-emerald-300',
    ident: 'text-slate-200',
    symbol: 'text-slate-400',
  },
  light: {
    comment: 'text-slate-400',
    string: 'text-amber-600',
    number: 'text-orange-600',
    keyword: 'text-purple-600',
    builtin: 'text-sky-600',
    funcName: 'text-yellow-600',
    methodName: 'text-yellow-600',
    propertyName: 'text-emerald-600',
    ident: 'text-slate-700',
    symbol: 'text-slate-500',
  },
  midnight: {
    comment: 'text-zinc-500',
    string: 'text-amber-300',
    number: 'text-orange-400',
    keyword: 'text-purple-400',
    builtin: 'text-cyan-300',
    funcName: 'text-yellow-300',
    methodName: 'text-yellow-300',
    propertyName: 'text-emerald-300',
    ident: 'text-zinc-200',
    symbol: 'text-zinc-400',
  },
};

/**
 * Highlights JavaScript code string with theme-aware syntax colors.
 */
export function highlightJS(code: string, theme: ThemeMode = 'dark'): React.ReactNode {
  if (!code) return null;

  const c = SYNTAX_COLORS[theme];
  const lines = code.split('\n');

  return (
    <div className="font-mono text-xs leading-5">
      {lines.map((line, lineIndex) => {
        const trimmed = line.trim();

        // Whole line comment
        if (trimmed.startsWith('//')) {
          return (
            <div key={lineIndex} className={`${c.comment} italic whitespace-pre`}>
              {line}
            </div>
          );
        }

        const tokens: React.ReactNode[] = [];
        // Match regex for comments, strings, numbers, keywords, builtins, function names, identifiers, symbols, spaces
        const tokenRegex = /(\/\/[^\n]*)|("[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|`[^`\\]*(?:\\.[^`\\]*)*`)|(\b\d+(?:\.\d+)?\b)|(\b(?:async|await|const|let|var|function|return|if|else|try|catch|new|throw|for|while|do|of|in|switch|case|break|continue|default|typeof|instanceof)\b)|(\b(?:response|request|res|req|console|Math|JSON|Date|Array|Object|String|Number|Boolean|Error)\b)|(\b[a-zA-Z_$][a-zA-Z0-9_$]*(?=\s*\())|([a-zA-Z_$][a-zA-Z0-9_$]*)|([{}()[\];,.:=><+*\-/!&|^~]+)|(\s+)/g;

        let match;

        while ((match = tokenRegex.exec(line)) !== null) {
          const [
            comment,
            stringVal,
            numVal,
            keywordVal,
            builtinVal,
            funcNameVal,
            identVal,
            symbolVal,
            spaceVal
          ] = match;

          const key = `${lineIndex}-${match.index}`;

          if (comment) {
            tokens.push(<span key={key} className={`${c.comment} italic`}>{comment}</span>);
          } else if (stringVal) {
            tokens.push(<span key={key} className={c.string}>{stringVal}</span>);
          } else if (numVal) {
            tokens.push(<span key={key} className={`${c.number} font-semibold`}>{numVal}</span>);
          } else if (keywordVal) {
            tokens.push(<span key={key} className={`${c.keyword} font-semibold`}>{keywordVal}</span>);
          } else if (builtinVal) {
            tokens.push(<span key={key} className={`${c.builtin} font-medium`}>{builtinVal}</span>);
          } else if (funcNameVal) {
            tokens.push(<span key={key} className={c.funcName}>{funcNameVal}</span>);
          } else if (identVal) {
            if (['status', 'json', 'send', 'setHeader', 'redirect', 'log'].includes(identVal)) {
              tokens.push(<span key={key} className={`${c.methodName} font-medium`}>{identVal}</span>);
            } else if (['ok', 'success', 'message', 'data', 'timestamp'].includes(identVal)) {
              tokens.push(<span key={key} className={c.propertyName}>{identVal}</span>);
            } else {
              tokens.push(<span key={key} className={c.ident}>{identVal}</span>);
            }
          } else if (symbolVal) {
            tokens.push(<span key={key} className={c.symbol}>{symbolVal}</span>);
          } else if (spaceVal) {
            tokens.push(<span key={key}>{spaceVal}</span>);
          }
        }

        return (
          <div key={lineIndex} className="whitespace-pre">
            {tokens.length > 0 ? tokens : ' '}
          </div>
        );
      })}
    </div>
  );
}
