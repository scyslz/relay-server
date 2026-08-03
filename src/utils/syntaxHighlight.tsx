import React from 'react';

/**
 * Highlights JavaScript code string with VS Code Dark syntax colors.
 */
export function highlightJS(code: string): React.ReactNode {
  if (!code) return null;

  const lines = code.split('\n');

  return (
    <div className="font-mono text-xs leading-5">
      {lines.map((line, lineIndex) => {
        const trimmed = line.trim();

        // Whole line comment
        if (trimmed.startsWith('//')) {
          return (
            <div key={lineIndex} className="text-slate-500 italic whitespace-pre">
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
            tokens.push(<span key={key} className="text-slate-500 italic">{comment}</span>);
          } else if (stringVal) {
            tokens.push(<span key={key} className="text-amber-300">{stringVal}</span>);
          } else if (numVal) {
            tokens.push(<span key={key} className="text-orange-400 font-semibold">{numVal}</span>);
          } else if (keywordVal) {
            tokens.push(<span key={key} className="text-purple-400 font-semibold">{keywordVal}</span>);
          } else if (builtinVal) {
            tokens.push(<span key={key} className="text-sky-300 font-medium">{builtinVal}</span>);
          } else if (funcNameVal) {
            tokens.push(<span key={key} className="text-yellow-300">{funcNameVal}</span>);
          } else if (identVal) {
            if (['status', 'json', 'send', 'setHeader', 'redirect', 'log'].includes(identVal)) {
              tokens.push(<span key={key} className="text-yellow-300 font-medium">{identVal}</span>);
            } else if (['ok', 'success', 'message', 'data', 'timestamp'].includes(identVal)) {
              tokens.push(<span key={key} className="text-emerald-300">{identVal}</span>);
            } else {
              tokens.push(<span key={key} className="text-slate-200">{identVal}</span>);
            }
          } else if (symbolVal) {
            tokens.push(<span key={key} className="text-slate-400">{symbolVal}</span>);
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
