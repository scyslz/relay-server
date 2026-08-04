import React from 'react';
import { Shield, Server, Edit3, Trash2, Globe, Plus, Network, Layers } from 'lucide-react';
import { AppConfig, Route, ThemeMode } from '../types';
import { THEME_STYLES } from '../theme';

interface AppListProps {
  apps: AppConfig[];
  routes: Route[];
  selectedAppId: string | null;
  theme?: ThemeMode;
  onSelectApp: (appId: string) => void;
  onEditApp: (app: AppConfig) => void;
  onDeleteApp: (appId: string) => void;
  onToggleAppStatus: (app: AppConfig) => void;
  onAddNewApp: () => void;
}

export const AppList: React.FC<AppListProps> = ({
  apps,
  routes,
  selectedAppId,
  theme = 'dark',
  onSelectApp,
  onEditApp,
  onDeleteApp,
  onToggleAppStatus,
  onAddNewApp
}) => {
  const styles = THEME_STYLES[theme];

  return (
    <div className={`${styles.cardBg} border ${styles.cardBorder} rounded-xl p-4 shadow-sm transition-colors`}>
      <div className={`flex items-center justify-between mb-4 pb-3 border-b ${styles.borderSubtle}`}>
        <div className="flex items-center space-x-2">
          <Server className="w-5 h-5 text-indigo-400" />
          <h2 className={`font-semibold ${styles.textPrimary}`}>Registered Apps</h2>
          <span className={`text-xs ${styles.badgeBg} ${styles.badgeText} px-2 py-0.5 rounded-full font-mono border ${styles.borderSubtle}`}>
            {apps.length}
          </span>
        </div>
        <button
          onClick={onAddNewApp}
          className="text-xs font-medium text-indigo-500 hover:text-indigo-400 flex items-center gap-1 hover:bg-indigo-500/10 px-2 py-1 rounded transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>New App</span>
        </button>
      </div>

      <div className="space-y-3">
        {apps.map((app) => {
          const appRoutesCount = routes.filter(r => r.appId === app.id).length;
          const isSelected = selectedAppId === app.id;

          return (
            <div
              key={app.id}
              onClick={() => onSelectApp(app.id)}
              className={`group relative p-3.5 rounded-lg border transition-all cursor-pointer ${
                isSelected
                  ? styles.cardSelected
                  : `${styles.cardBg} ${styles.cardBorder} ${styles.cardHover}`
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <div className="flex items-center space-x-2">
                    <span className={`font-semibold text-sm group-hover:text-indigo-400 transition-colors ${styles.textPrimary}`}>
                      {app.name}
                    </span>

                    {/* Default App Badge */}
                    {app.isDefault && (
                      <span className="px-2 py-0.5 text-[10px] font-medium bg-amber-500/20 text-amber-500 border border-amber-500/30 rounded flex items-center gap-1" title="Built-in App - Cannot be deleted">
                        <Shield className="w-3 h-3 text-amber-500" />
                        Built-in
                      </span>
                    )}

                    {/* Status Bubble */}
                    <span
                      onClick={(e) => e.stopPropagation()}
                      className="inline-block"
                      title={(() => {
                        const st = app.listenStatus;
                        if (!app.enabled) return 'Disabled';
                        if (st?.state === 'failed') return st.error || 'Enabled but dedicated port failed to bind';
                        if (st?.state === 'same-as-system') return st.error || 'Shares the system address (no dedicated listener)';
                        if (st?.state === 'bound' || st?.state === 'system' || app.isDefault) return st?.address ? `Listening on ${st.address}` : 'Listening';
                        return 'Binding in progress…';
                      })()}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full inline-block ${
                        !app.enabled ? 'bg-slate-500' :
                        app.listenStatus?.state === 'failed' || app.listenStatus?.state === 'same-as-system' ? 'bg-rose-500' :
                        app.listenStatus?.state === 'bound' || app.listenStatus?.state === 'system' || app.isDefault ? 'bg-emerald-500' : 'bg-slate-400'
                      }`} />
                    </span>
                  </div>

                  {app.description && (
                    <p className={`text-xs ${styles.textMuted} line-clamp-1`}>{app.description}</p>
                  )}
                </div>

                {/* Toggle + Edit / Delete */}
                <div className="flex items-center space-x-1 opacity-80 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!app.isDefault) onToggleAppStatus(app);
                    }}
                    disabled={app.isDefault}
                    title={app.isDefault
                      ? 'Built-in App cannot be toggled'
                      : (app.enabled ? 'Disable (stops the listener)' : 'Enable (starts the listener)')}
                    className={`relative w-6 h-3.5 rounded-full transition-colors ${
                      app.enabled ? 'bg-emerald-500' : 'bg-slate-600'
                    } ${app.isDefault ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
                  >
                    <span
                      className={`absolute top-[2px] left-[2px] w-2.5 h-2.5 rounded-full bg-white transition-transform ${
                        app.enabled ? 'translate-x-2.5' : ''
                      }`}
                    />
                  </button>

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onEditApp(app);
                    }}
                    className={`p-1 ${styles.textMuted} hover:text-indigo-400 ${styles.cardHover} rounded transition-colors`}
                    title="Edit App Settings"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>

                  {!app.isDefault && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteApp(app.id);
                      }}
                      className={`p-1 ${styles.textMuted} hover:text-rose-500 ${styles.cardHover} rounded transition-colors`}
                      title="Delete App"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {/* Server Metadata Chips */}
              <div className={`mt-3 pt-2 border-t ${styles.borderSubtle} flex flex-wrap items-center gap-x-4 gap-y-1 text-xs ${styles.textMuted} font-mono`}>
                <div
                  className={`flex items-center gap-1 ${
                    app.enabled && (app.listenStatus?.state === 'failed' || app.listenStatus?.state === 'same-as-system') ? 'text-rose-400' :
                    app.enabled && (app.listenStatus?.state === 'bound' || app.listenStatus?.state === 'system' || app.isDefault) ? 'text-emerald-400' : ''
                  }`}
                >
                  <Network className="w-3 h-3 opacity-60" />
                  <span>
                    {(() => {
                      const protocols = (app.protocols && app.protocols.length) ? app.protocols : ['http'];
                      const scheme = protocols.includes('http') && protocols.includes('https')
                        ? 'http(s)://'
                        : `${protocols[0]}://`;
                      return `${scheme}${app.listenHost}:${app.listenPort}`;
                    })()}
                  </span>
                </div>

                <div className="flex items-center gap-1">
                  <Globe className="w-3 h-3 opacity-60" />
                  <span className="text-indigo-400">{app.basePath}</span>
                </div>

                <div className="flex items-center gap-1 ml-auto">
                  <Layers className="w-3 h-3 opacity-60" />
                  <span className={styles.textSecondary}>{appRoutesCount} routes</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

