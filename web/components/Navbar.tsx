import React, { useState } from 'react';
import { Server, ShieldCheck, ListFilter, Terminal, Sun, Moon, Palette, ChevronDown } from 'lucide-react';
import { AppConfig, Route, ThemeMode } from '../../shared/types';
import { THEME_STYLES } from '../theme';

interface NavbarProps {
  apps: AppConfig[];
  routes: Route[];
  activeTab: 'routes' | 'logs' | 'apps';
  setActiveTab: (tab: 'routes' | 'logs' | 'apps') => void;
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  totalLogsCount: number;
}

export const Navbar: React.FC<NavbarProps> = ({
  apps,
  routes,
  activeTab,
  setActiveTab,
  theme,
  setTheme,
  totalLogsCount
}) => {
  const [isThemeMenuOpen, setIsThemeMenuOpen] = useState(false);
  const styles = THEME_STYLES[theme];

  const activeAppsCount = apps.filter(a => a.enabled).length;
  const activeRoutesCount = routes.filter(r => r.enabled).length;

  const themesList: { id: ThemeMode; name: string; icon: React.ReactNode }[] = [
    { id: 'dark', name: 'Dark Slate', icon: <Moon className="w-3.5 h-3.5 text-indigo-400" /> },
    { id: 'light', name: 'Light Crisp', icon: <Sun className="w-3.5 h-3.5 text-amber-500" /> },
    { id: 'midnight', name: 'Midnight Cyber', icon: <Palette className="w-3.5 h-3.5 text-cyan-400" /> },
  ];

  return (
    <header className={`${styles.headerBg} border-b ${styles.headerBorder} ${styles.headerText} sticky top-0 z-30 shadow-md transition-colors duration-200`}>
      <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8">
        <div className="flex flex-nowrap items-center justify-between min-h-[3.5rem] py-2 gap-2">
          {/* Logo & Brand */}
          <div className="flex items-center space-x-2.5 shrink-0">
            <div className="p-1.5 sm:p-2 bg-indigo-600/20 rounded-lg border border-indigo-500/30 text-indigo-400 shrink-0">
              <Server className="w-5 h-5 sm:w-6 sm:h-6" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h1 className={`font-bold text-base sm:text-lg tracking-tight ${styles.textPrimary}`}>
                  Relay
                </h1>
              </div>
              <p className={`text-[11px] ${styles.textMuted} hidden md:block`}>
                Multi-App Relay Router & Sandbox
              </p>
            </div>
          </div>

          {/* Quick Metrics (Desktop/Tablet) */}
          <div className="hidden lg:flex items-center space-x-3 text-xs font-mono shrink-0">
            <div className={`px-2.5 py-1 rounded-md border ${styles.cardBg} ${styles.borderSubtle} flex items-center gap-1.5`}>
              <span className={styles.textMuted}>Apps:</span>
              <span className="text-indigo-400 font-bold">{activeAppsCount}/{apps.length}</span>
            </div>
            <div className={`px-2.5 py-1 rounded-md border ${styles.cardBg} ${styles.borderSubtle} flex items-center gap-1.5`}>
              <span className={styles.textMuted}>Routes:</span>
              <span className="text-emerald-400 font-bold">{activeRoutesCount}/{routes.length}</span>
            </div>
            <div className={`px-2.5 py-1 rounded-md border ${styles.cardBg} ${styles.borderSubtle} flex items-center gap-1.5`}>
              <ShieldCheck className="w-3.5 h-3.5 text-amber-400" />
              <span className={styles.textSecondary}>System Protected</span>
            </div>
          </div>

          {/* Mobile-Friendly Action Buttons - Minimal (Theme & Refresh) */}
          <div className="flex items-center space-x-1.5 sm:space-x-2 shrink-0">
            {/* Theme Selector Dropdown */}
            <div className="relative">
              <button
                onClick={() => setIsThemeMenuOpen(!isThemeMenuOpen)}
                className={`px-2 py-1.5 sm:px-2.5 sm:py-1.5 text-xs font-medium rounded-lg border ${styles.buttonSecondary} flex items-center gap-1.5 transition-all`}
                title="Switch Theme"
              >
                {theme === 'dark' && <Moon className="w-3.5 h-3.5 text-indigo-400" />}
                {theme === 'light' && <Sun className="w-3.5 h-3.5 text-amber-500" />}
                {theme === 'midnight' && <Palette className="w-3.5 h-3.5 text-cyan-400" />}
                <span className="hidden sm:inline capitalize">{theme}</span>
                <ChevronDown className="w-3 h-3 opacity-60" />
              </button>

              {isThemeMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setIsThemeMenuOpen(false)} />
                  <div className={`absolute right-0 mt-1 w-36 rounded-xl border ${styles.modalBg} ${styles.modalBorder} shadow-xl z-50 py-1 font-sans text-xs`}>
                    <div className={`px-2.5 py-1 text-[10px] font-semibold tracking-wider uppercase ${styles.textMuted}`}>
                      Theme
                    </div>
                    {themesList.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => {
                          setTheme(t.id);
                          setIsThemeMenuOpen(false);
                        }}
                        className={`w-full text-left px-3 py-1.5 flex items-center justify-between ${
                          theme === t.id
                            ? 'bg-indigo-600/20 text-indigo-400 font-medium'
                            : `${styles.textSecondary} ${styles.cardHover}`
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          {t.icon}
                          <span>{t.name}</span>
                        </div>
                        {theme === t.id && <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Tab Sub-Navigation (Scrollable on Mobile) */}
        <div className={`flex space-x-4 sm:space-x-6 border-t ${styles.borderSubtle} pt-2 pb-1.5 text-xs sm:text-sm font-medium overflow-x-auto whitespace-nowrap no-scrollbar`}>
          <button
            onClick={() => setActiveTab('routes')}
            className={`flex items-center gap-1.5 sm:gap-2 pb-1 border-b-2 transition-colors ${
              activeTab === 'routes'
                ? 'border-indigo-500 text-indigo-400 font-semibold'
                : `${styles.textMuted} hover:${styles.textPrimary}`
            }`}
          >
            <ListFilter className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            <span>Routes</span>
          </button>

          <button
            onClick={() => setActiveTab('logs')}
            className={`flex items-center gap-1.5 sm:gap-2 pb-1 border-b-2 transition-colors ${
              activeTab === 'logs'
                ? 'border-indigo-500 text-indigo-400 font-semibold'
                : `${styles.textMuted} hover:${styles.textPrimary}`
            }`}
          >
            <Terminal className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            <span>Logs</span>
            {totalLogsCount > 0 && (
              <span className={`px-1.5 py-0.2 text-[10px] ${styles.badgeBg} ${styles.badgeText} rounded-full border ${styles.borderSubtle}`}>
                {totalLogsCount}
              </span>
            )}
          </button>
        </div>
      </div>
    </header>
  );
};

