import React, { useState } from 'react';
import { Terminal, Trash2, Search, Filter, ShieldAlert, ChevronDown, ChevronRight } from 'lucide-react';
import { ExecutionLog, ThemeMode } from '../../shared/types';
import { THEME_STYLES } from '../theme';

interface ExecutionLogsViewProps {
  logs: ExecutionLog[];
  totalLogs?: number;
  theme?: ThemeMode;
  onClearLogs: () => void;
}

export const ExecutionLogsView: React.FC<ExecutionLogsViewProps> = ({ logs, totalLogs, theme = 'dark', onClearLogs }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'success' | 'error' | 'no_route'>('all');
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const styles = THEME_STYLES[theme];

  const filteredLogs = logs.filter(log => {
    const matchesSearch =
      log.appName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (log.routeName && log.routeName.toLowerCase().includes(searchTerm.toLowerCase())) ||
      log.url.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (log.errorMessage && log.errorMessage.toLowerCase().includes(searchTerm.toLowerCase()));

    const matchesStatus = statusFilter === 'all' || log.status === statusFilter;

    return matchesSearch && matchesStatus;
  });

  const toggleExpand = (id: string) => {
    setExpandedLogId(expandedLogId === id ? null : id);
  };

  return (
    <div className={`${styles.cardBg} border ${styles.cardBorder} rounded-xl p-4 sm:p-5 shadow-sm space-y-4 transition-colors`}>
      {/* Header & Controls */}
      <div className={`flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b ${styles.borderSubtle}`}>
        <div className="flex items-center space-x-3">
          <div className="p-2 bg-indigo-600/20 text-indigo-400 rounded-lg border border-indigo-500/30">
            <Terminal className="w-5 h-5" />
          </div>
          <div>
            <h2 className={`font-semibold text-base sm:text-lg ${styles.textPrimary}`}>Execution Logs</h2>
            <p className={`text-xs ${styles.textMuted}`}>Traces, stack outputs, and latency metrics · newest first</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          {/* Status Filter */}
          <div className={`flex items-center space-x-1 ${styles.inputBg} border ${styles.inputBorder} rounded-lg p-1 text-xs`}>
            <Filter className={`w-3.5 h-3.5 ${styles.textMuted} ml-1`} />
            <button
              onClick={() => setStatusFilter('all')}
              className={`px-2 py-0.5 rounded transition-colors ${
                statusFilter === 'all' ? 'bg-indigo-600 text-white font-medium' : `${styles.textMuted} hover:${styles.textPrimary}`
              }`}
            >
              All ({totalLogs ?? logs.length})
            </button>
            <button
              onClick={() => setStatusFilter('success')}
              className={`px-2 py-0.5 rounded transition-colors ${
                statusFilter === 'success' ? 'bg-emerald-600 text-white font-medium' : `${styles.textMuted} hover:${styles.textPrimary}`
              }`}
            >
              Success
            </button>
            <button
              onClick={() => setStatusFilter('error')}
              className={`px-2 py-0.5 rounded transition-colors ${
                statusFilter === 'error' ? 'bg-rose-600 text-white font-medium' : `${styles.textMuted} hover:${styles.textPrimary}`
              }`}
            >
              Errors
            </button>
          </div>

          {/* Search Bar */}
          <div className="relative flex-1 sm:flex-none">
            <Search className={`w-3.5 h-3.5 ${styles.textMuted} absolute left-2.5 top-2.5`} />
            <input
              type="text"
              placeholder="Search logs..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className={`${styles.inputBg} border ${styles.inputBorder} ${styles.inputText} ${styles.inputPlaceholder} text-xs rounded-lg pl-8 pr-3 py-1.5 focus:outline-none w-full sm:w-44 transition-colors`}
            />
          </div>

          {/* Clear Logs Button */}
          <button
            onClick={onClearLogs}
            className={`p-1.5 ${styles.textMuted} hover:text-rose-500 ${styles.cardHover} rounded-lg transition-colors`}
            title="Clear Log History"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Logs Table */}
      {filteredLogs.length === 0 ? (
        <div className={`py-12 text-center ${styles.textMuted} border border-dashed ${styles.borderSubtle} rounded-lg`}>
          <Terminal className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p className="text-sm font-medium">No execution logs captured yet</p>
          <p className="text-xs mt-1">Use the "Test Simulator" or send HTTP requests to <code className="text-indigo-400">/internal/*</code> to generate logs.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filteredLogs.map((log) => {
            const isExpanded = expandedLogId === log.id;
            const isError = log.status === 'error';

            return (
              <div
                key={log.id}
                className={`border rounded-lg transition-all overflow-hidden font-mono text-xs ${
                  isError
                    ? 'bg-rose-950/20 border-rose-800/40 hover:border-rose-700'
                    : `${styles.cardBg} ${styles.cardBorder} ${styles.cardHover}`
                }`}
              >
                {/* Collapsed Row */}
                <div
                  onClick={() => toggleExpand(log.id)}
                  className="p-3 flex items-center justify-between cursor-pointer select-none"
                >
                  <div className="flex items-center space-x-3 overflow-hidden">
                    {isExpanded ? <ChevronDown className={`w-4 h-4 ${styles.textMuted} shrink-0`} /> : <ChevronRight className={`w-4 h-4 ${styles.textMuted} shrink-0`} />}

                    {/* Method & Status */}
                    <span className={`px-2 py-0.5 text-[10px] font-bold rounded ${
                      log.statusCode >= 200 && log.statusCode < 400
                        ? 'bg-emerald-500/20 text-emerald-500 border border-emerald-500/30'
                        : 'bg-rose-500/20 text-rose-500 border border-rose-500/30'
                    }`}>
                      {log.method} {log.statusCode}
                    </span>

                    {/* App & Route Info */}
                    <div className="truncate">
                      <span className={`${styles.textPrimary} font-semibold`}>{log.appName}</span>
                      {log.routeName && (
                        <span className="text-indigo-400 ml-2">[{log.routeName}]</span>
                      )}
                      <span className={`${styles.textMuted} ml-2 truncate`}>{log.url}</span>
                    </div>
                  </div>

                  <div className={`flex items-center space-x-3 shrink-0 text-[11px] ${styles.textMuted}`}>
                    <span className="font-bold text-indigo-400">{log.durationMs}ms</span>
                    <span className="hidden md:inline">{new Date(log.timestamp).toLocaleTimeString()}</span>
                  </div>
                </div>

                {/* Expanded Traces & Logs */}
                {isExpanded && (
                  <div className={`p-4 ${styles.codeBg} border-t ${styles.borderSubtle} space-y-3 text-[11px]`}>
                    {/* Log Timestamps & Request Context */}
                    <div className={`grid grid-cols-2 md:grid-cols-4 gap-2 ${styles.textMuted} border-b ${styles.borderSubtle} pb-2`}>
                      <div><span>Timestamp:</span> {new Date(log.timestamp).toLocaleString()}</div>
                      <div><span>App ID:</span> {log.appId}</div>
                      <div><span>Route ID:</span> {log.routeId || 'N/A'}</div>
                      <div><span>Status Code:</span> {log.statusCode}</div>
                    </div>

                    {/* Error Stack Trace if Isolated Exception */}
                    {log.errorMessage && (
                      <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-lg text-rose-300 space-y-1">
                        <div className="flex items-center gap-1.5 font-bold text-rose-400">
                          <ShieldAlert className="w-4 h-4" />
                          <span>Isolated Script Exception Caught (Try-Catch Handled):</span>
                        </div>
                        <p className="font-semibold">{log.errorMessage}</p>
                        {log.errorStack && (
                          <pre className="text-[10px] text-rose-400/80 overflow-x-auto whitespace-pre-wrap mt-1">
                            {log.errorStack}
                          </pre>
                        )}
                      </div>
                    )}

                    {/* Console Logs */}
                    <div className="space-y-1">
                      <span className={`${styles.textSecondary} font-bold block`}>Console Messages ({log.logs?.length || 0}):</span>
                      {(!log.logs || log.logs.length === 0) ? (
                        <p className={`${styles.textMuted} italic`}>No console statements recorded during execution.</p>
                      ) : (
                        <div className={`space-y-1 ${styles.cardBg} p-2.5 rounded border ${styles.borderSubtle}`}>
                          {log.logs.map((m, i) => (
                            <div
                              key={i}
                              className={
                                m.includes('[ERROR]') ? 'text-rose-400 font-semibold' :
                                m.includes('[WARN]') ? 'text-amber-400' : styles.textSecondary
                              }
                            >
                              {m}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

