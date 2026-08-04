import React, { useState, useEffect } from 'react';
import { X, CheckCircle2, AlertTriangle, Sparkles, Shield, Code, Save } from 'lucide-react';
import { Route, AppConfig, MatchStrategy, HttpMethod, ValidationResult, ThemeMode } from '../types';
import { THEME_STYLES } from '../theme';
import { CODE_SNIPPETS } from '../data/defaultData';
import { CustomSelect } from './CustomSelect';
import { CodeEditor } from './CodeEditor';

interface RouteEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  route: Partial<Route> | null;
  apps: AppConfig[];
  selectedAppId: string | null;
  onSaveRoute: (routeData: Partial<Route>) => Promise<{ success: boolean; validation?: ValidationResult; error?: string }>;
  theme?: ThemeMode;
}

export const RouteEditorModal: React.FC<RouteEditorModalProps> = ({
  isOpen,
  onClose,
  route,
  apps,
  selectedAppId,
  onSaveRoute,
  theme = 'dark'
}) => {
  const styles = THEME_STYLES[theme];
  const [formData, setFormData] = useState<Partial<Route>>({
    name: '',
    appId: selectedAppId || apps[0]?.id || '',
    matchTarget: 'path',
    matchStrategy: 'prefix',
    pathPattern: '/',
    hostPattern: '*',
    httpMethods: ['GET', 'ALL'],
    code: `// Route Handler Script
// Params: request, response
response.status(200).json({
  message: "Hello from route script",
  timestamp: new Date().toISOString()
});`,
    enabled: true,
    ignoreTls: false,
    priority: 10
  });

  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const routeId = route?.id;

  useEffect(() => {
    if (!isOpen) return;

    if (route) {
      setFormData({
        ...route,
        appId: route.appId || selectedAppId || apps[0]?.id || '',
        matchTarget: route.matchTarget || 'path',
        matchStrategy: route.matchStrategy || 'prefix',
        pathPattern: route.pathPattern || '/',
        hostPattern: route.hostPattern || '*',
        httpMethods: route.httpMethods || ['ALL'],
        code: route.code || `response.status(200).json({ ok: true });`,
        priority: route.priority ?? 10
      });
    } else {
      setFormData({
        name: 'New Route',
        appId: selectedAppId || apps[0]?.id || '',
        matchTarget: 'path',
        matchStrategy: 'prefix',
        pathPattern: '/api/endpoint',
        hostPattern: '*',
        httpMethods: ['ALL'],
        code: `// Route Handler Script
// Params: request, response
response.status(200).json({
  success: true,
  time: new Date().toISOString()
});`,
        enabled: true,
        ignoreTls: false,
        priority: 10
      });
    }
    setValidationResult(null);
    setSaveError(null);
  }, [isOpen, routeId]);

  if (!isOpen) return null;

  const isBuiltIn = Boolean(route?.isDefault || formData.isDefault);

  const handleValidate = async () => {
    try {
      const res = await fetch('/internal/validate-route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ route: formData, currentId: formData.id })
      });
      const data: ValidationResult = await res.json();
      setValidationResult(data);
    } catch (err: any) {
      console.error('Validation request failed:', err);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isBuiltIn) {
      setSaveError('Built-in routes cannot be saved or modified.');
      return;
    }
    if (!formData.name?.trim()) {
      setSaveError('Route name is required');
      return;
    }
    if (!formData.pathPattern?.trim()) {
      setSaveError('Path pattern is required');
      return;
    }

    setIsSaving(true);
    setSaveError(null);

    try {
      const result = await onSaveRoute(formData);
      if (result.success) {
        onClose();
      } else {
        if (result.validation) {
          setValidationResult(result.validation);
        }
        setSaveError(result.error || 'Failed to save route. Check validation errors.');
      }
    } catch (err: any) {
      setSaveError(err.message || 'Error saving route.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleMethodToggle = (method: HttpMethod) => {
    const current = formData.httpMethods || [];
    if (method === 'ALL') {
      setFormData({ ...formData, httpMethods: ['ALL'] });
      return;
    }

    let updated = current.filter(m => m !== 'ALL');
    if (updated.includes(method)) {
      updated = updated.filter(m => m !== method);
    } else {
      updated.push(method);
    }

    if (updated.length === 0) updated = ['ALL'];
    setFormData({ ...formData, httpMethods: updated });
  };

  const applyCodeSnippet = (snippetCode: string) => {
    setFormData({ ...formData, code: snippetCode });
  };

  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center ${styles.overlayBg} backdrop-blur-sm p-2 sm:p-4 overflow-y-auto`}>
      <div className={`${styles.modalBg} border ${styles.modalBorder} rounded-xl sm:rounded-2xl w-full max-w-5xl lg:max-w-6xl shadow-2xl overflow-hidden flex flex-col h-[92vh] max-h-[850px]`}>
        
        {/* Header with Direct Route Name Editing */}
        <div className={`px-3 py-2.5 sm:px-5 sm:py-3 border-b ${styles.borderSubtle} flex items-center justify-between ${styles.modalBg} gap-2 shrink-0`}>
          <div className="flex items-center space-x-2.5 flex-1 min-w-0">
            <div className="p-1.5 sm:p-2 bg-indigo-600/20 text-indigo-400 rounded-lg border border-indigo-500/30 shrink-0">
              <Code className="w-4 h-4 sm:w-5 sm:h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <label className={`text-[10px] ${styles.textMuted} font-medium block uppercase tracking-wider`}>
                Route Name
              </label>
              <input
                type="text"
                required
                value={formData.name || ''}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="Route Name"
                className={`w-full ${styles.inputBg} border ${styles.inputBorder} rounded-md px-2.5 py-1 text-xs sm:text-sm font-semibold ${styles.inputText} focus:outline-none focus:border-indigo-500`}
              />
            </div>

            {isBuiltIn && (
              <span className="px-2 py-0.5 text-xs font-semibold bg-amber-500/20 text-amber-400 border border-amber-500/40 rounded flex items-center gap-1 shrink-0">
                <Shield className="w-3.5 h-3.5 text-amber-400" />
                Built-in Route (Read-Only)
              </span>
            )}
          </div>

          <button
            onClick={onClose}
            className={`p-1.5 ${styles.textMuted} hover:text-indigo-400 hover:bg-indigo-500/10 rounded-lg transition-colors shrink-0`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Content */}
        <form onSubmit={handleSubmit} className="flex-1 flex flex-col min-h-0 overflow-hidden">
          
          {/* Streamlined Config Controls */}
          <div className={`p-3 ${styles.panelBg} border-b ${styles.borderSubtle} space-y-2.5 shrink-0 text-xs`}>
            {/* Row 1: Strategy, Path & App */}
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
              <div className="sm:col-span-7 space-y-1">
                <label className={`${styles.textSecondary} font-medium text-[11px] block`}>
                  <span>Match Path *</span>
                </label>
                <div className="flex items-center space-x-1.5">
                  {/* Custom Strategy Dropdown */}
                  <CustomSelect
                    value={formData.matchStrategy || 'prefix'}
                    onChange={(val) => setFormData({ ...formData, matchStrategy: val as MatchStrategy })}
                    options={[
                      { value: 'prefix', label: 'Prefix' },
                      { value: 'equal', label: 'Exact' },
                      { value: 'contains', label: 'Contains' },
                      { value: 'regex', label: 'RegExp' }
                    ]}
                    buttonClassName="min-w-[90px]"
                    theme={theme}
                  />

                  <input
                    type="text"
                    required
                    value={formData.pathPattern || ''}
                    onChange={(e) => setFormData({ ...formData, pathPattern: e.target.value })}
                    placeholder="/path"
                    className={`flex-1 ${styles.inputBg} border ${styles.inputBorder} rounded-lg px-2.5 py-1.5 ${styles.inputText} font-mono text-xs focus:outline-none focus:border-indigo-500`}
                  />
                </div>
              </div>

              {/* Custom Target App Dropdown */}
              <div className="sm:col-span-5 space-y-1">
                <label className={`${styles.textSecondary} font-medium text-[11px]`}>Target App *</label>
                <CustomSelect
                  value={formData.appId || ''}
                  onChange={(val) => setFormData({ ...formData, appId: val })}
                  options={apps.map(a => ({
                    value: a.id,
                    label: a.name,
                    subtitle: a.basePath
                  }))}
                  className="w-full"
                  theme={theme}
                />
              </div>
            </div>

            {/* Row 2: HTTP Methods & Code Snippets */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
              <div className="flex items-center space-x-1.5">
                <span className={`${styles.textMuted} text-[11px] font-medium mr-1`}>Methods:</span>
                {(['ALL', 'GET', 'POST', 'PUT', 'DELETE'] as HttpMethod[]).map(m => {
                  const isSelected = (formData.httpMethods || []).includes(m);
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => handleMethodToggle(m)}
                      className={`px-2 py-0.5 rounded text-[11px] font-mono font-bold transition-all border ${
                        isSelected
                          ? 'bg-indigo-600 text-white border-indigo-500 shadow-sm'
                          : `${styles.inputBg} ${styles.textMuted} border ${styles.inputBorder} hover:text-indigo-400`
                      }`}
                    >
                      {m}
                    </button>
                  );
                })}
              </div>

              {/* Per-route TLS verification bypass (opt-in, not global) */}
              <div className="flex items-center space-x-1.5">
                <button
                  type="button"
                  onClick={() => setFormData({ ...formData, ignoreTls: !formData.ignoreTls })}
                  className={`px-2 py-0.5 rounded text-[11px] font-mono font-bold transition-all border flex items-center gap-1 ${
                    formData.ignoreTls
                      ? 'bg-amber-600 text-white border-amber-500 shadow-sm'
                      : `${styles.inputBg} ${styles.textMuted} border ${styles.inputBorder} hover:text-amber-400`
                  }`}
                  title="Skip TLS/SSL certificate verification for this route's outgoing fetch() HTTPS requests"
                >
                  <Shield className="w-3 h-3" />
                  {formData.ignoreTls ? 'Ignore TLS: ON' : 'Ignore TLS: OFF'}
                </button>
              </div>

              {/* Custom Preset Dropdown */}
              <div className="flex items-center space-x-1.5 ml-auto">
                <Sparkles className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <CustomSelect
                  value=""
                  placeholder="Presets..."
                  dropdownAlign="right"
                  onChange={(val) => {
                    if (val) applyCodeSnippet(val);
                  }}
                  options={CODE_SNIPPETS.map(snip => ({
                    value: snip.code,
                    label: snip.title
                  }))}
                  buttonClassName="text-amber-300 border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/20 min-w-[110px]"
                  theme={theme}
                />
              </div>
            </div>
          </div>

          {/* Validation Banner */}
          {validationResult && (
            <div className={`px-3 py-1.5 ${styles.panelBg} border-b ${styles.borderSubtle} text-xs space-y-1 shrink-0`}>
              {validationResult.errors.map((err, idx) => (
                <div key={idx} className="flex items-center gap-2 text-rose-400 bg-rose-500/10 p-1.5 rounded border border-rose-500/20">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span>{err.message} {err.line ? `(Line ${err.line})` : ''}</span>
                </div>
              ))}
              {validationResult.warnings.map((warn, idx) => (
                <div key={idx} className="flex items-center gap-2 text-amber-300 bg-amber-500/10 p-1.5 rounded border border-amber-500/20">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span>{warn.message}</span>
                </div>
              ))}
              {validationResult.valid && validationResult.warnings.length === 0 && (
                <div className="flex items-center gap-2 text-emerald-400 bg-emerald-500/10 p-1.5 rounded border border-emerald-500/20">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  <span>Syntax OK.</span>
                </div>
              )}
            </div>
          )}

          {saveError && (
            <div className="px-3 py-1.5 bg-rose-950/50 text-rose-300 border-b border-rose-800/80 text-xs flex items-center gap-2 shrink-0">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>{saveError}</span>
            </div>
          )}

          {/* Code Editor */}
          <div className="p-3 flex-1 flex flex-col min-h-0 overflow-hidden">
            <CodeEditor
              value={formData.code || ''}
              onChange={(val) => setFormData({ ...formData, code: val })}
              theme={theme}
            />
          </div>

          {/* Footer Actions */}
          <div className={`px-3 py-2.5 sm:px-5 sm:py-3 ${styles.modalBg} border-t ${styles.borderSubtle} flex items-center justify-between shrink-0`}>
            <button
              type="button"
              onClick={handleValidate}
              className={`px-3 py-1.5 text-xs font-medium ${styles.buttonSecondary} text-indigo-300 rounded-lg border flex items-center gap-1.5 transition-colors`}
            >
              <Shield className="w-3.5 h-3.5 text-indigo-400" />
              <span>Validate</span>
            </button>

            <div className="flex items-center space-x-2.5">
              {isBuiltIn && (
                <span className="text-[11px] text-amber-400 font-medium flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-400" />
                  Built-in route cannot be saved
                </span>
              )}

              <button
                type="button"
                onClick={onClose}
                className={`px-3.5 py-1.5 text-xs font-medium ${styles.textMuted} hover:text-indigo-400 transition-colors`}
              >
                Cancel
              </button>

              <button
                type="submit"
                disabled={isSaving || isBuiltIn}
                title={isBuiltIn ? 'Built-in routes cannot be saved' : 'Save Route'}
                className={`px-4 py-1.5 text-xs font-medium rounded-lg shadow-sm flex items-center gap-1.5 transition-all ${
                  isBuiltIn
                    ? `${styles.inputBg} ${styles.textMuted} border ${styles.inputBorder} cursor-not-allowed`
                    : 'bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800 text-white'
                }`}
              >
                <Save className="w-3.5 h-3.5" />
                <span>{isSaving ? 'Saving...' : isBuiltIn ? 'Save Disabled' : 'Save'}</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
