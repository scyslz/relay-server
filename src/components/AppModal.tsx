import React, { useState, useEffect } from 'react';
import { X, Server, AlertTriangle, Save, Network, Globe } from 'lucide-react';
import { AppConfig, ValidationResult } from '../types';

interface AppModalProps {
  isOpen: boolean;
  onClose: () => void;
  app: AppConfig | null;
  onSaveApp: (appData: Partial<AppConfig>) => Promise<{ success: boolean; validation?: ValidationResult; error?: string }>;
}

type FieldName = 'name' | 'listenHost' | 'listenPort' | 'basePath';
type FieldErrors = Partial<Record<FieldName, string>>;

// listenPort may be '' while the user is clearing the input; validated before submit.
type AppFormData = Omit<Partial<AppConfig>, 'listenPort'> & { listenPort: number | '' };

// Validate a listen host string: must be a valid IPv4 address or a plain hostname.
function validateHost(host: string): string | null {
  if (!host) {
    return 'Listen host is required';
  }
  const dottedIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  if (dottedIpv4) {
    if (host.split('.').some(part => Number(part) > 255)) {
      return `Invalid IPv4 address: ${host}`;
    }
    return null;
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host)) {
    return `Invalid listen host: ${host}`;
  }
  return null;
}

function validateForm(data: AppFormData): FieldErrors {
  const errs: FieldErrors = {};

  if (!(data.name || '').trim()) {
    errs.name = 'App name is required';
  }

  const hostError = validateHost((data.listenHost || '').trim());
  if (hostError) {
    errs.listenHost = hostError;
  }

  if (data.listenPort === '') {
    errs.listenPort = 'Listen port is required';
  } else {
    const port = Number(data.listenPort);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      errs.listenPort = 'Invalid listen port (1-65535)';
    }
  }

  const basePath = (data.basePath || '').trim();
  if (!basePath) {
    errs.basePath = 'Base path is required';
  } else if (!basePath.startsWith('/')) {
    errs.basePath = 'Base path must start with "/"';
  }

  return errs;
}

export const AppModal: React.FC<AppModalProps> = ({
  isOpen,
  onClose,
  app,
  onSaveApp
}) => {
  // listenPort may be '' while the user is clearing the input; it is normalized on submit.
  const [formData, setFormData] = useState<AppFormData>({
    name: '',
    listenHost: '0.0.0.0',
    listenPort: 8080,
    basePath: '/',
    enabled: true
  });

  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    if (app) {
      setFormData({ ...app });
    } else {
      setFormData({
        name: '',
        listenHost: '0.0.0.0',
        listenPort: 8080,
        basePath: '/',
        enabled: true
      });
    }
    setValidationResult(null);
    setSaveError(null);
    setFieldErrors({});
    setAttempted(false);
  }, [app, isOpen]);

  if (!isOpen) return null;

  const handleFieldChange = <K extends keyof typeof formData>(field: K, value: typeof formData[K]) => {
    const next = { ...formData, [field]: value };
    setFormData(next);
    if (attempted) {
      setFieldErrors(validateForm(next));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAttempted(true);

    // Client-side validation: show red hints, never auto-fill or submit invalid data.
    const errs = validateForm(formData);
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) {
      setIsSaving(false);
      return;
    }

    setIsSaving(true);
    setSaveError(null);

    const payload: Partial<AppConfig> = {
      ...formData,
      name: (formData.name || '').trim(),
      listenHost: (formData.listenHost || '').trim(),
      listenPort: Number(formData.listenPort),
      basePath: (formData.basePath || '').trim()
    };

    try {
      const result = await onSaveApp(payload);
      if (result.success) {
        onClose();
      } else {
        if (result.validation) {
          setValidationResult(result.validation);
        }
        setSaveError(result.error || 'Failed to save App.');
      }
    } catch (err: any) {
      setSaveError(err.message || 'Error saving App.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-3 sm:p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-xl sm:rounded-2xl w-full max-w-lg sm:max-w-xl lg:max-w-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-4 py-3 sm:px-6 sm:py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="p-2 bg-indigo-600/20 text-indigo-400 rounded-lg border border-indigo-500/30">
              <Server className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base sm:text-lg font-semibold text-slate-100">
                {app ? `Edit App: ${app.name}` : 'New App'}
              </h3>
              <p className="text-[11px] text-slate-400">Configure host, port, and base path</p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Validation Error Banner */}
        {validationResult && (
          <div className="px-4 py-2 bg-slate-950 border-b border-slate-800 text-xs space-y-1">
            {validationResult.errors.map((err, idx) => (
              <div key={idx} className="flex items-center gap-2 text-rose-400 bg-rose-500/10 p-2 rounded border border-rose-500/20">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{err.message}</span>
              </div>
            ))}
            {validationResult.warnings.map((warn, idx) => (
              <div key={idx} className="flex items-center gap-2 text-amber-300 bg-amber-500/10 p-2 rounded border border-amber-500/20">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{warn.message}</span>
              </div>
            ))}
          </div>
        )}

        {saveError && (
          <div className="px-4 py-2 bg-rose-950/50 text-rose-300 border-b border-rose-800/80 text-xs flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{saveError}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate className="p-4 sm:p-5 space-y-3.5 text-xs">
          {/* App Name */}
          <div className="space-y-1">
            <label className="block text-slate-300 font-medium">Application Name *</label>
            <input
              type="text"
              value={formData.name || ''}
              onChange={(e) => handleFieldChange('name', e.target.value)}
              placeholder="App Name"
              className={`w-full bg-slate-800 border rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-indigo-500 ${fieldErrors.name ? 'border-rose-500' : 'border-slate-700'}`}
            />
            {fieldErrors.name && <p className="text-rose-400 text-[11px] mt-1">Invalid {fieldErrors.name.toLowerCase()}</p>}
          </div>

          {/* Network Settings Grid */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="block text-slate-300 font-medium flex items-center gap-1">
                <Network className="w-3.5 h-3.5 text-slate-400" />
                <span>Listen Host</span>
              </label>
              <input
                type="text"
                value={formData.listenHost ?? ''}
                onChange={(e) => handleFieldChange('listenHost', e.target.value)}
                placeholder="0.0.0.0"
                className={`w-full bg-slate-800 border rounded-lg px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-indigo-500 ${fieldErrors.listenHost ? 'border-rose-500' : 'border-slate-700'}`}
              />
              {fieldErrors.listenHost && <p className="text-rose-400 text-[11px] mt-1">{fieldErrors.listenHost}</p>}
            </div>

            <div className="space-y-1">
              <label className="block text-slate-300 font-medium flex items-center gap-1">
                <Network className="w-3.5 h-3.5 text-slate-400" />
                <span>Listen Port *</span>
              </label>
              <input
                type="number"
                value={formData.listenPort}
                onChange={(e) => handleFieldChange('listenPort', e.target.value === '' ? '' : Number(e.target.value))}
                placeholder="8080"
                className={`w-full bg-slate-800 border rounded-lg px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-indigo-500 ${fieldErrors.listenPort ? 'border-rose-500' : 'border-slate-700'}`}
              />
              {fieldErrors.listenPort && <p className="text-rose-400 text-[11px] mt-1">{fieldErrors.listenPort}</p>}
            </div>
          </div>

          {/* System Server Port Change Warning */}
          {app?.isDefault && formData.listenPort !== app.listenPort && (
            <div className="px-3 py-2 bg-amber-500/10 border border-amber-500/30 rounded-lg text-[11px] text-amber-300 flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>Changing the system server port will rebind the listener to the new port. This page will be served from the new address after saving — reconnect via the new port if the current page disconnects.</span>
            </div>
          )}

          {/* Base Path */}
          <div className="space-y-1">
            <label className="block text-slate-300 font-medium flex items-center gap-1">
              <Globe className="w-3.5 h-3.5 text-slate-400" />
              <span>Base Path *</span>
            </label>
            <input
              type="text"
              value={formData.basePath ?? ''}
              onChange={(e) => handleFieldChange('basePath', e.target.value)}
              placeholder="/"
              className={`w-full bg-slate-800 border rounded-lg px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-indigo-500 ${fieldErrors.basePath ? 'border-rose-500' : 'border-slate-700'}`}
            />
            {fieldErrors.basePath && <p className="text-rose-400 text-[11px] mt-1">{fieldErrors.basePath}</p>}
          </div>

          {/* Active Status */}
          {!app?.isDefault && (
            <div className="flex items-center space-x-2 pt-1">
              <input
                type="checkbox"
                id="app-enabled"
                checked={formData.enabled !== false}
                onChange={(e) => setFormData({ ...formData, enabled: e.target.checked })}
                className="rounded border-slate-700 text-indigo-600 focus:ring-indigo-500 bg-slate-800"
              />
              <label htmlFor="app-enabled" className="text-slate-300 font-medium cursor-pointer">
                Enable Application
              </label>
            </div>
          )}

          {/* Actions */}
          <div className="pt-3 border-t border-slate-800 flex items-center justify-end space-x-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-slate-400 hover:text-slate-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800 text-white font-medium rounded-lg shadow-sm flex items-center gap-2 transition-all"
            >
              <Save className="w-4 h-4" />
              <span>{isSaving ? 'Saving...' : 'Save'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
