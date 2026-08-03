import React, { useState } from 'react';
import { X, Play, Clock, Terminal, Send, Sparkles } from 'lucide-react';
import { AppConfig, Route, TestResponsePayload, ThemeMode } from '../types';
import { THEME_STYLES } from '../theme';
import { CustomSelect } from './CustomSelect';

interface TestSimulatorModalProps {
  isOpen: boolean;
  onClose: () => void;
  apps: AppConfig[];
  routes: Route[];
  initialRoute?: Route | null;
  theme?: ThemeMode;
}

export const TestSimulatorModal: React.FC<TestSimulatorModalProps> = ({
  isOpen,
  onClose,
  apps,
  routes,
  initialRoute,
  theme = 'dark'
}) => {
  const styles = THEME_STYLES[theme];
  const defaultAppId = initialRoute ? initialRoute.appId : (apps[0]?.id || '');
  
  const [selectedAppId, setSelectedAppId] = useState<string>(defaultAppId);
  const [selectedRouteId, setSelectedRouteId] = useState<string>(initialRoute?.id || '');
  const [method, setMethod] = useState<string>('GET');
  const [urlPath, setUrlPath] = useState<string>(initialRoute?.pathPattern || '/internal/health');
  const [headersJson, setHeadersJson] = useState<string>('{\n  "Content-Type": "application/json",\n  "User-Agent": "Relay-Simulator-Agent"\n}');
  const [bodyContent, setBodyContent] = useState<string>('{\n  "username": "admin_test",\n  "query": "system_status"\n}');
  
  const [isExecuting, setIsExecuting] = useState<boolean>(false);
  const [responseResult, setResponseResult] = useState<TestResponsePayload | null>(null);
  const [activeResTab, setActiveResTab] = useState<'body' | 'headers' | 'logs'>('body');

  React.useEffect(() => {
    if (initialRoute) {
      setSelectedAppId(initialRoute.appId);
      setSelectedRouteId(initialRoute.id);
      setUrlPath(initialRoute.pathPattern);
      const m = initialRoute.httpMethods && initialRoute.httpMethods.length > 0 && initialRoute.httpMethods[0] !== 'ALL'
        ? initialRoute.httpMethods[0]
        : 'GET';
      setMethod(m);
    }
  }, [initialRoute, isOpen]);

  if (!isOpen) return null;

  const appRoutes = routes.filter(r => r.appId === selectedAppId);

  const handleAppChange = (appId: string) => {
    setSelectedAppId(appId);
    const firstRoute = routes.find(r => r.appId === appId);
    if (firstRoute) {
      setSelectedRouteId(firstRoute.id);
      setUrlPath(firstRoute.pathPattern);
    } else {
      setSelectedRouteId('');
      setUrlPath('/');
    }
  };

  const handleRouteSelect = (routeId: string) => {
    setSelectedRouteId(routeId);
    const r = routes.find(item => item.id === routeId);
    if (r) {
      setUrlPath(r.pathPattern);
      const m = r.httpMethods && r.httpMethods.length > 0 && r.httpMethods[0] !== 'ALL'
        ? r.httpMethods[0]
        : 'GET';
      setMethod(m);
    }
  };

  const handleRunSimulator = async () => {
    setIsExecuting(true);
    setResponseResult(null);

    let parsedHeaders = {};
    try {
      if (headersJson.trim()) {
        parsedHeaders = JSON.parse(headersJson);
      }
    } catch {
      parsedHeaders = { 'Content-Type': 'application/json' };
    }

    try {
      const res = await fetch('/internal/execute-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appId: selectedAppId,
          routeId: selectedRouteId || undefined,
          method,
          url: urlPath,
          headers: parsedHeaders,
          body: method !== 'GET' ? bodyContent : undefined
        })
      });

      const data: TestResponsePayload = await res.json();
      setResponseResult(data);
    } catch (err: any) {
      setResponseResult({
        status: 500,
        headers: {},
        body: JSON.stringify({ error: 'Simulator Communication Error', message: err.message }),
        logs: [`[ERROR] ${err.message}`],
        durationMs: 0,
        error: err.message
      });
    } finally {
      setIsExecuting(false);
    }
  };

  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center ${styles.overlayBg} backdrop-blur-sm p-4 overflow-y-auto`}>
      <div className={`${styles.modalBg} border ${styles.modalBorder} rounded-2xl w-full max-w-5xl lg:max-w-6xl shadow-2xl overflow-hidden flex flex-col h-[90vh] max-h-[850px]`}>
        {/* Header */}
        <div className={`px-6 py-4 border-b ${styles.borderSubtle} flex items-center justify-between`}>
          <div className="flex items-center space-x-3">
            <div className="p-2 bg-emerald-600/20 text-emerald-400 rounded-lg border border-emerald-500/30">
              <Play className="w-5 h-5 fill-current" />
            </div>
            <div>
              <h3 className={`text-lg font-semibold ${styles.textPrimary}`}>HTTP Request Simulator</h3>
              <p className={`text-xs ${styles.textMuted}`}>Dispatch test requests and inspect script console outputs live</p>
            </div>
          </div>

          <button
            onClick={onClose}
            className={`p-1.5 ${styles.textMuted} hover:text-indigo-400 hover:bg-indigo-500/10 rounded-lg transition-colors`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Area */}
        <div className={`grid grid-cols-1 md:grid-cols-12 flex-1 overflow-hidden divide-y md:divide-y-0 md:divide-x ${styles.borderSubtle} text-xs`}>
          {/* Request Config Column */}
          <div className={`md:col-span-6 p-5 space-y-4 overflow-y-auto ${styles.panelBg}`}>
            {/* App & Route Selection */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className={`block ${styles.textSecondary} font-medium`}>Target App</label>
                <CustomSelect
                  value={selectedAppId}
                  onChange={(val) => handleAppChange(val)}
                  options={apps.map(a => ({
                    value: a.id,
                    label: a.name,
                    subtitle: a.basePath
                  }))}
                  className="w-full"
                  theme={theme}
                />
              </div>

              <div className="space-y-1">
                <label className={`block ${styles.textSecondary} font-medium`}>Target Route (Optional)</label>
                <CustomSelect
                  value={selectedRouteId}
                  placeholder="Auto-Match Route Rule"
                  onChange={(val) => handleRouteSelect(val)}
                  options={[
                    { value: '', label: 'Auto-Match Route Rule' },
                    ...appRoutes.map(r => ({
                      value: r.id,
                      label: r.name,
                      subtitle: r.pathPattern
                    }))
                  ]}
                  className="w-full"
                  theme={theme}
                />
              </div>
            </div>

            {/* Request Method & URL bar */}
            <div className="space-y-1">
              <label className={`block ${styles.textSecondary} font-medium`}>HTTP Request Endpoint</label>
              <div className={`flex rounded-lg overflow-hidden border ${styles.inputBorder} ${styles.inputBg}`}>
                <CustomSelect
                  value={method}
                  onChange={(val) => setMethod(val)}
                  options={[
                    { value: 'GET', label: 'GET' },
                    { value: 'POST', label: 'POST' },
                    { value: 'PUT', label: 'PUT' },
                    { value: 'DELETE', label: 'DELETE' },
                    { value: 'PATCH', label: 'PATCH' }
                  ]}
                  buttonClassName="text-emerald-400 font-mono font-bold border-none rounded-none border-r border-slate-700 px-3 py-2"
                  theme={theme}
                />

                <input
                  type="text"
                  value={urlPath}
                  onChange={(e) => setUrlPath(e.target.value)}
                  placeholder="/path"
                  className={`flex-1 bg-transparent px-3 py-2 ${styles.inputText} font-mono focus:outline-none`}
                />
              </div>
            </div>

            {/* Headers JSON */}
            <div className="space-y-1">
              <label className={`block ${styles.textSecondary} font-medium`}>Request Headers (JSON)</label>
              <textarea
                rows={3}
                value={headersJson}
                onChange={(e) => setHeadersJson(e.target.value)}
                className={`w-full ${styles.codeBg} border ${styles.codeBorder} rounded-lg p-2.5 font-mono text-[11px] ${styles.codeText} focus:outline-none focus:border-emerald-500`}
              />
            </div>

            {/* Request Body if POST/PUT/PATCH */}
            {method !== 'GET' && (
              <div className="space-y-1">
                <label className={`block ${styles.textSecondary} font-medium`}>Request Body Payload</label>
                <textarea
                  rows={4}
                  value={bodyContent}
                  onChange={(e) => setBodyContent(e.target.value)}
                  className={`w-full ${styles.codeBg} border ${styles.codeBorder} rounded-lg p-2.5 font-mono text-[11px] ${styles.codeText} focus:outline-none focus:border-emerald-500`}
                />
              </div>
            )}

            {/* Dispatch Button */}
            <button
              onClick={handleRunSimulator}
              disabled={isExecuting}
              className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 text-white font-medium rounded-lg shadow-md flex items-center justify-center gap-2 transition-all"
            >
              <Send className="w-4 h-4" />
              <span>{isExecuting ? 'Dispatching & Running Script...' : 'Dispatch Test Request'}</span>
            </button>
          </div>

          {/* Response Output Column */}
          <div className={`md:col-span-6 p-5 flex flex-col ${styles.panelBg} overflow-hidden`}>
            <div className={`flex items-center justify-between border-b ${styles.borderSubtle} pb-2 mb-3`}>
              <div className="flex items-center space-x-3">
                <span className={`font-semibold ${styles.textPrimary}`}>Execution Output</span>
                {responseResult && (
                  <span className={`px-2 py-0.5 text-[10px] font-mono font-bold rounded ${
                    responseResult.status >= 200 && responseResult.status < 400
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                      : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                  }`}>
                    {responseResult.status} {responseResult.status === 200 ? 'OK' : ''}
                  </span>
                )}
              </div>

              {responseResult && (
                <div className={`flex items-center gap-1 ${styles.textMuted} font-mono text-[11px]`}>
                  <Clock className={`w-3.5 h-3.5 ${styles.textMuted}`} />
                  <span>{responseResult.durationMs}ms</span>
                </div>
              )}
            </div>

            {/* Response Sub Tabs */}
            {responseResult ? (
              <div className="flex-1 flex flex-col overflow-hidden">
                <div className={`flex space-x-3 border-b ${styles.borderSubtle} mb-2 pb-1 font-mono text-[11px]`}>
                  <button
                    onClick={() => setActiveResTab('body')}
                    className={`pb-1 border-b-2 transition-colors ${
                      activeResTab === 'body' ? 'border-emerald-500 text-emerald-400 font-bold' : `border-transparent ${styles.textMuted} hover:text-indigo-400`
                    }`}
                  >
                    Response Body
                  </button>
                  <button
                    onClick={() => setActiveResTab('headers')}
                    className={`pb-1 border-b-2 transition-colors ${
                      activeResTab === 'headers' ? 'border-emerald-500 text-emerald-400 font-bold' : `border-transparent ${styles.textMuted} hover:text-indigo-400`
                    }`}
                  >
                    Headers
                  </button>
                  <button
                    onClick={() => setActiveResTab('logs')}
                    className={`pb-1 border-b-2 transition-colors flex items-center gap-1 ${
                      activeResTab === 'logs' ? 'border-emerald-500 text-emerald-400 font-bold' : `border-transparent ${styles.textMuted} hover:text-indigo-400`
                    }`}
                  >
                    <Terminal className="w-3 h-3" />
                    <span>Script Console ({responseResult.logs?.length || 0})</span>
                  </button>
                </div>

                {/* Tab Output Box */}
                <div className={`flex-1 overflow-y-auto ${styles.codeBg} border ${styles.codeBorder} rounded-xl p-3 font-mono text-[11px]`}>
                  {activeResTab === 'body' && (
                    <pre className="text-emerald-300 whitespace-pre-wrap font-mono">
                      {typeof responseResult.body === 'string'
                        ? responseResult.body
                        : JSON.stringify(responseResult.body, null, 2)}
                    </pre>
                  )}

                  {activeResTab === 'headers' && (
                    <div className="space-y-1">
                      {Object.entries(responseResult.headers || {}).map(([k, v]) => (
                        <div key={k} className={`flex justify-between border-b ${styles.borderSubtle} pb-1`}>
                          <span className={styles.textMuted}>{k}:</span>
                          <span className="text-indigo-300">{String(v)}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {activeResTab === 'logs' && (
                    <div className="space-y-1">
                      {(!responseResult.logs || responseResult.logs.length === 0) ? (
                        <p className={`${styles.textMuted} italic`}>No console statements recorded during execution.</p>
                      ) : (
                        responseResult.logs.map((logMsg, i) => (
                          <div
                            key={i}
                            className={`p-1.5 rounded font-mono ${
                              logMsg.includes('[ERROR]') ? 'bg-rose-500/10 text-rose-300 border border-rose-500/20' :
                              logMsg.includes('[WARN]') ? 'bg-amber-500/10 text-amber-300 border border-amber-500/20' :
                              styles.codeText
                            }`}
                          >
                            {logMsg}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className={`flex-1 flex flex-col items-center justify-center ${styles.textMuted} text-center p-6 border border-dashed ${styles.borderSubtle} rounded-xl`}>
                <Sparkles className="w-8 h-8 mb-2 opacity-40 text-emerald-400" />
                <p className={`font-medium text-sm ${styles.textSecondary}`}>Ready for Request Dispatch</p>
                <p className="text-xs mt-1 max-w-xs">Click "Dispatch Test Request" to execute JS route handler and view output.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
