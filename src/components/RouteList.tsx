import React from 'react';
import { Route, AppConfig, ThemeMode } from '../types';
import { Waypoints, Code, Play, Shield, Trash2, CheckCircle2, AlertCircle, Plus, Search, HelpCircle } from 'lucide-react';
import { THEME_STYLES } from '../theme';
import { highlightJS } from '../utils/syntaxHighlight';

interface RouteListProps {
  routes: Route[];
  selectedApp: AppConfig | null;
  selectedRouteId?: string | null;
  theme?: ThemeMode;
  onSelectRoute?: (routeId: string) => void;
  onEditRoute: (route: Route) => void;
  onDeleteRoute: (routeId: string) => void;
  onToggleRouteStatus: (route: Route) => void;
  onTestRoute: (route: Route) => void;
  onAddNewRoute: () => void;
}

export const RouteList: React.FC<RouteListProps> = ({
  routes,
  selectedApp,
  selectedRouteId,
  theme = 'dark',
  onSelectRoute,
  onEditRoute,
  onDeleteRoute,
  onToggleRouteStatus,
  onTestRoute,
  onAddNewRoute
}) => {
  const [searchTerm, setSearchTerm] = React.useState('');
  const styles = THEME_STYLES[theme];

  const filteredRoutes = routes.filter(r => 
    r.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    r.pathPattern.toLowerCase().includes(searchTerm.toLowerCase()) ||
    r.description?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const getStrategyBadgeClass = (strategy: string) => {
    switch (strategy) {
      case 'equal':
        return 'bg-blue-500/10 text-blue-500 border-blue-500/30';
      case 'prefix':
        return 'bg-purple-500/10 text-purple-500 border-purple-500/30';
      case 'contains':
        return 'bg-amber-500/10 text-amber-500 border-amber-500/30';
      case 'regex':
        return 'bg-rose-500/10 text-rose-500 border-rose-500/30';
      default:
        return `${styles.badgeBg} ${styles.textMuted} border ${styles.borderSubtle}`;
    }
  };

  const getMethodBadgeClass = (method: string) => {
    switch (method) {
      case 'GET': return 'bg-emerald-500/20 text-emerald-500 border-emerald-500/30';
      case 'POST': return 'bg-sky-500/20 text-sky-500 border-sky-500/30';
      case 'PUT': return 'bg-amber-500/20 text-amber-500 border-amber-500/30';
      case 'DELETE': return 'bg-rose-500/20 text-rose-500 border-rose-500/30';
      case 'ALL': return 'bg-indigo-500/20 text-indigo-500 border-indigo-500/30';
      default: return `${styles.badgeBg} ${styles.textMuted} border ${styles.borderSubtle}`;
    }
  };

  return (
    <div className={`${styles.cardBg} border ${styles.cardBorder} rounded-xl p-4 sm:p-5 shadow-sm transition-colors`}>
      {/* Header */}
      <div className={`flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-5 pb-4 border-b ${styles.borderSubtle}`}>
        <div className="flex items-center space-x-2 min-w-0">
          <Waypoints className="w-5 h-5 text-indigo-400 shrink-0" />
          <h2 className={`font-semibold text-base sm:text-lg ${styles.textPrimary} truncate`}>
            {selectedApp ? selectedApp.name : 'Routes'}
          </h2>
        </div>

        <div className="flex items-center space-x-2 sm:space-x-3">
          {/* Search Filter */}
          <div className="relative flex-1 sm:flex-none">
            <Search className={`w-3.5 h-3.5 ${styles.textMuted} absolute left-2.5 top-2.5`} />
            <input
              type="text"
              placeholder="Filter routes..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className={`${styles.inputBg} border ${styles.inputBorder} ${styles.inputText} ${styles.inputPlaceholder} text-xs rounded-lg pl-8 pr-3 py-1.5 focus:outline-none w-full sm:w-48 transition-colors`}
            />
          </div>

          <button
            onClick={onAddNewRoute}
            className="px-3 py-1.5 text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg flex items-center gap-1.5 shadow-sm transition-all shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Route</span>
          </button>
        </div>
      </div>

      {/* Routes List */}
      {filteredRoutes.length === 0 ? (
        <div className={`py-12 text-center ${styles.textMuted} border border-dashed ${styles.borderSubtle} rounded-lg`}>
          <HelpCircle className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm font-medium">No matching routes found</p>
          <p className="text-xs mt-1">Click "Add Route" to register a new scriptable endpoint.</p>
        </div>
      ) : (
        <div className="space-y-3.5">
          {filteredRoutes.map((route, idx) => {
            const isSelected = selectedRouteId === route.id || (!selectedRouteId && idx === 0);

            return (
              <div
                key={route.id}
                onClick={() => onSelectRoute && onSelectRoute(route.id)}
                className={`p-4 rounded-xl border transition-all cursor-pointer ${
                  isSelected
                    ? `${styles.cardSelected} shadow-md`
                    : route.enabled
                      ? `${styles.cardBg} ${styles.cardBorder} ${styles.cardHover}`
                      : `${styles.cardBg} ${styles.cardBorder} opacity-60`
                }`}
              >
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                  {/* Route Title & Matching Specs */}
                  <div className="space-y-1.5 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`font-semibold text-base ${styles.textHeading}`}>
                        {route.name}
                      </span>

                      {/* Method Badges */}
                      {route.httpMethods.map(m => (
                        <span key={m} className={`px-2 py-0.5 text-[10px] font-mono font-bold border rounded ${getMethodBadgeClass(m)}`}>
                          {m}
                        </span>
                      ))}

                      {/* Default Route Protection */}
                      {route.isDefault && (
                        <span className="px-2 py-0.5 text-[10px] font-medium bg-amber-500/20 text-amber-500 border border-amber-500/30 rounded flex items-center gap-1">
                          <Shield className="w-3 h-3 text-amber-500" />
                          Built-in
                        </span>
                      )}
                    </div>

                    {/* Route Pattern & Match Strategy */}
                    <div className={`flex flex-wrap items-center gap-2 text-xs font-mono ${styles.textMuted}`}>
                      <span className={`px-2 py-0.5 text-[10px] font-mono border rounded ${getStrategyBadgeClass(route.matchStrategy)}`}>
                        {route.matchTarget.charAt(0).toUpperCase() + route.matchTarget.slice(1)}:{route.matchStrategy}
                      </span>
                      <code className="text-emerald-500 font-bold px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20">
                        {route.pathPattern}
                      </code>
                      {route.hostPattern && route.hostPattern !== '*' && (
                        <span>Host: <code className="text-sky-400">{route.hostPattern}</code></span>
                      )}
                    </div>
                  </div>

                  {/* Status Toggle & Action Tools */}
                  <div className={`flex items-center space-x-1.5 pt-2 md:pt-0 border-t md:border-0 ${styles.borderSubtle}`}>
                    {/* Status Toggle */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!route.isDefault) onToggleRouteStatus(route);
                      }}
                      className={`px-2.5 py-1 text-xs font-mono rounded-lg border transition-colors flex items-center gap-1.5 ${
                        route.enabled
                          ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30 hover:bg-emerald-500/20'
                          : `${styles.badgeBg} ${styles.textMuted} border ${styles.borderSubtle}`
                      }`}
                    >
                      {route.enabled ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" /> : <AlertCircle className="w-3.5 h-3.5" />}
                      <span>{route.enabled ? 'ACTIVE' : 'OFF'}</span>
                    </button>

                    {/* Test Route */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onTestRoute(route);
                      }}
                      className="px-2.5 py-1 text-xs font-medium bg-emerald-600/20 text-emerald-500 hover:bg-emerald-600/30 border border-emerald-500/30 rounded-lg flex items-center gap-1.5 transition-colors"
                      title="Test Route in Simulator"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>Test</span>
                    </button>

                    {/* Edit Route & JS Code */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onEditRoute(route);
                      }}
                      className={`px-2.5 py-1 text-xs font-medium ${styles.buttonSecondary} border rounded-lg flex items-center gap-1.5 transition-colors`}
                      title="Edit Route Code & Logic"
                    >
                      <Code className="w-3.5 h-3.5 text-indigo-400" />
                      <span>Script</span>
                    </button>

                    {/* Delete Route */}
                    {!route.isDefault && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteRoute(route.id);
                        }}
                        className={`p-1.5 ${styles.textMuted} hover:text-rose-500 ${styles.cardHover} rounded-lg transition-colors`}
                        title="Delete Route"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {/* JS Code Block Preview snippet */}
                <div className={`mt-3 ${styles.codeBg} rounded-lg border ${styles.codeBorder} p-2.5 overflow-x-auto relative`}>
                  <div className={`flex items-center justify-between text-[10px] ${styles.textMuted} mb-1 border-b ${styles.borderSubtle} pb-1 font-mono`}>
                    <span>JS Handler Script</span>
                    <span>request, response</span>
                  </div>
                  <div className="overflow-x-auto max-h-32 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-700">
                    {highlightJS(route.code)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

