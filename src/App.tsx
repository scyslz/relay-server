import React, { useState, useEffect } from 'react';
import { AppConfig, Route, ExecutionLog, ValidationResult, ThemeMode } from './types';
import { THEME_STYLES } from './theme';
import { Navbar } from './components/Navbar';
import { AppList } from './components/AppList';
import { RouteList } from './components/RouteList';
import { RouteEditorModal } from './components/RouteEditorModal';
import { AppModal } from './components/AppModal';
import { TestSimulatorModal } from './components/TestSimulatorModal';
import { ExecutionLogsView } from './components/ExecutionLogsView';
import { ConfirmModal } from './components/ConfirmModal';
import { AlertCircle } from 'lucide-react';

export default function App() {
  const [apps, setApps] = useState<AppConfig[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [logs, setLogs] = useState<ExecutionLog[]>([]);
  const [totalLogsCount, setTotalLogsCount] = useState(0);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'routes' | 'logs' | 'apps'>('routes');

  // Theme State (Dark / Light / Midnight)
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem('relay_theme');
    return (saved === 'light' || saved === 'midnight' || saved === 'dark') ? saved : 'dark';
  });

  useEffect(() => {
    localStorage.setItem('relay_theme', theme);
  }, [theme]);

  // Modals
  const [isAppModalOpen, setIsAppModalOpen] = useState(false);
  const [editingApp, setEditingApp] = useState<AppConfig | null>(null);

  const [isRouteModalOpen, setIsRouteModalOpen] = useState(false);
  const [editingRoute, setEditingRoute] = useState<Partial<Route> | null>(null);

  const [isSimulatorOpen, setIsSimulatorOpen] = useState(false);
  const [testRouteTarget, setTestRouteTarget] = useState<Route | null>(null);

  const [confirmState, setConfirmState] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    confirmText?: string;
    type?: 'danger' | 'warning' | 'info';
    onConfirm: () => void;
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {}
  });

  const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' | 'warning' } | null>(null);

  const showNotification = (message: string, type: 'success' | 'error' | 'warning' = 'success') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 4000);
  };

  // Fetch all data
  const fetchData = async () => {
    try {
      const [appsRes, routesRes, logsRes] = await Promise.all([
        fetch('/internal/apps'),
        fetch('/internal/routes'),
        fetch('/internal/logs?limit=200')
      ]);

      if (appsRes.ok) {
        const appsData = await appsRes.json();
        const loadedApps: AppConfig[] = appsData.apps || [];
        setApps(loadedApps);

        setSelectedAppId(prev => {
          if (prev && loadedApps.some(a => a.id === prev)) {
            return prev;
          }
          return loadedApps[0]?.id || null;
        });
      }

      if (routesRes.ok) {
        const routesData = await routesRes.json();
        const loadedRoutes: Route[] = routesData.routes || [];
        setRoutes(loadedRoutes);
      }

      if (logsRes.ok) {
        const logsData = await logsRes.json();
        setLogs(logsData.logs || []);
        setTotalLogsCount(logsData.total ?? (logsData.logs || []).length);
      }
    } catch (err) {
      console.error('Failed to load initial data:', err);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 3000); // Polling logs & status updates
    return () => clearInterval(interval);
  }, []);

  // When selectedAppId changes or routes load, auto-select its first route if needed
  useEffect(() => {
    if (selectedAppId && routes.length > 0) {
      const appRoutes = routes.filter(r => r.appId === selectedAppId);
      if (appRoutes.length > 0) {
        setSelectedRouteId(prev => {
          if (prev && appRoutes.some(r => r.id === prev)) {
            return prev;
          }
          return appRoutes[0].id;
        });
      } else {
        setSelectedRouteId(null);
      }
    }
  }, [selectedAppId, routes]);

  // Handle Server / App Selection -> Automatically switches to first route
  const handleSelectApp = (appId: string) => {
    setSelectedAppId(appId);
    setActiveTab('routes');

    const appRoutes = routes.filter(r => r.appId === appId);
    if (appRoutes.length > 0) {
      setSelectedRouteId(appRoutes[0].id);
    } else {
      setSelectedRouteId(null);
    }
  };

  // App Handlers
  const handleSaveApp = async (appData: Partial<AppConfig>): Promise<{ success: boolean; validation?: ValidationResult; error?: string }> => {
    try {
      const isEdit = Boolean(appData.id);
      const endpoint = isEdit ? `/internal/apps/${appData.id}` : '/internal/apps';
      const method = isEdit ? 'PUT' : 'POST';

      const res = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(appData)
      });

      const data = await res.json();
      if (!res.ok) {
        return { success: false, validation: data.validation, error: data.error };
      }

      showNotification(`App "${data.app.name}" saved successfully!`);
      await fetchData();
      if (!selectedAppId) handleSelectApp(data.app.id);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'Network error saving App.' };
    }
  };

  const handleDeleteApp = (appId: string) => {
    const targetApp = apps.find(a => a.id === appId);
    if (targetApp?.isDefault) {
      showNotification('Cannot delete Built-in App. It is protected by the server.', 'error');
      return;
    }

    setConfirmState({
      isOpen: true,
      title: 'Delete App',
      message: `Are you sure you want to delete App "${targetApp?.name}" and all of its routes?`,
      confirmText: 'Delete App',
      type: 'danger',
      onConfirm: async () => {
        try {
          const res = await fetch(`/internal/apps/${appId}`, { method: 'DELETE' });
          if (!res.ok) {
            const data = await res.json();
            showNotification(data.error || 'Failed to delete App', 'error');
            return;
          }

          showNotification(`App "${targetApp?.name}" deleted.`);
          if (selectedAppId === appId) {
            const nextApp = apps.find(a => a.id !== appId);
            if (nextApp) handleSelectApp(nextApp.id);
            else setSelectedAppId(null);
          }
          fetchData();
        } catch (err: any) {
          showNotification('Error deleting App', 'error');
        }
      }
    });
  };

  const handleToggleAppStatus = async (app: AppConfig) => {
    if (app.isDefault) {
      showNotification('Built-in App cannot be disabled.', 'warning');
      return;
    }

    try {
      await fetch(`/internal/apps/${app.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...app, enabled: !app.enabled })
      });
      fetchData();
    } catch (err) {
      showNotification('Failed to toggle App status', 'error');
    }
  };

  // Route Handlers
  const handleSaveRoute = async (routeData: Partial<Route>): Promise<{ success: boolean; validation?: ValidationResult; error?: string }> => {
    if (routeData.isDefault) {
      showNotification('Built-in routes cannot be modified or saved.', 'error');
      return { success: false, error: 'Built-in routes cannot be modified or saved.' };
    }

    try {
      const isEdit = Boolean(routeData.id);
      const endpoint = isEdit ? `/internal/routes/${routeData.id}` : '/internal/routes';
      const method = isEdit ? 'PUT' : 'POST';

      const res = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(routeData)
      });

      const data = await res.json();
      if (!res.ok) {
        return { success: false, validation: data.validation, error: data.error };
      }

      showNotification(`Route "${data.route.name}" saved with verified syntax!`);
      await fetchData();
      if (data.route) setSelectedRouteId(data.route.id);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'Network error saving Route.' };
    }
  };

  const handleDeleteRoute = (routeId: string) => {
    const targetRoute = routes.find(r => r.id === routeId);
    if (targetRoute?.isDefault) {
      showNotification('The Built-in Route cannot be deleted.', 'error');
      return;
    }

    setConfirmState({
      isOpen: true,
      title: 'Delete Route',
      message: `Are you sure you want to delete route "${targetRoute?.name}"?`,
      confirmText: 'Delete Route',
      type: 'danger',
      onConfirm: async () => {
        try {
          const res = await fetch(`/internal/routes/${routeId}`, { method: 'DELETE' });
          if (!res.ok) {
            const data = await res.json();
            showNotification(data.error || 'Failed to delete route', 'error');
            return;
          }

          showNotification(`Route "${targetRoute?.name}" deleted.`);
          fetchData();
        } catch (err) {
          showNotification('Error deleting route', 'error');
        }
      }
    });
  };

  const handleToggleRouteStatus = async (route: Route) => {
    if (route.isDefault) {
      showNotification('Built-in Route cannot be disabled.', 'warning');
      return;
    }

    try {
      await fetch(`/internal/routes/${route.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...route, enabled: !route.enabled })
      });
      fetchData();
    } catch (err) {
      showNotification('Failed to toggle route status', 'error');
    }
  };

  const handleClearLogs = async () => {
    try {
      await fetch('/internal/logs/clear', { method: 'POST' });
      setLogs([]);
      setTotalLogsCount(0);
      showNotification('Execution log history cleared.');
    } catch (err) {
      showNotification('Failed to clear logs.', 'error');
    }
  };

  const selectedAppObj = apps.find(a => a.id === selectedAppId) || null;
  const displayRoutes = selectedAppId ? routes.filter(r => r.appId === selectedAppId) : routes;
  const currentStyles = THEME_STYLES[theme];

  return (
    <div className={`min-h-screen ${currentStyles.appBg} font-sans flex flex-col transition-colors duration-200 selection:bg-indigo-600 selection:text-white`}>
      {/* Toast Notification */}
      {notification && (
        <div className={`fixed bottom-5 right-5 z-50 px-4 py-3 rounded-xl shadow-2xl border text-xs font-medium flex items-center gap-2 animate-bounce ${
          notification.type === 'error' ? 'bg-rose-950 text-rose-200 border-rose-800' :
          notification.type === 'warning' ? 'bg-amber-950 text-amber-200 border-amber-800' :
          'bg-emerald-950 text-emerald-200 border-emerald-800'
        }`}>
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{notification.message}</span>
        </div>
      )}

      {/* Header Navbar */}
      <Navbar
        apps={apps}
        routes={routes}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        theme={theme}
        setTheme={setTheme}
        totalLogsCount={totalLogsCount}
      />

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-3 sm:px-6 lg:px-8 py-4 sm:py-6">
        {activeTab === 'routes' ? (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 sm:gap-6">
            {/* Left Sidebar: Registered Apps */}
            <div className="lg:col-span-4">
              <AppList
                apps={apps}
                routes={routes}
                selectedAppId={selectedAppId}
                theme={theme}
                onSelectApp={handleSelectApp}
                onEditApp={(app) => {
                  setEditingApp(app);
                  setIsAppModalOpen(true);
                }}
                onDeleteApp={handleDeleteApp}
                onToggleAppStatus={handleToggleAppStatus}
                onAddNewApp={() => {
                  setEditingApp(null);
                  setIsAppModalOpen(true);
                }}
              />
            </div>

            {/* Right Panel: Routes List */}
            <div className="lg:col-span-8">
              <RouteList
                routes={displayRoutes}
                selectedApp={selectedAppObj}
                selectedRouteId={selectedRouteId}
                theme={theme}
                onSelectRoute={(routeId) => setSelectedRouteId(routeId)}
                onEditRoute={(route) => {
                  setEditingRoute(route);
                  setIsRouteModalOpen(true);
                }}
                onDeleteRoute={handleDeleteRoute}
                onToggleRouteStatus={handleToggleRouteStatus}
                onTestRoute={(route) => {
                  setTestRouteTarget(route);
                  setIsSimulatorOpen(true);
                }}
                onAddNewRoute={() => {
                  setEditingRoute({ appId: selectedAppId || apps[0]?.id });
                  setIsRouteModalOpen(true);
                }}
              />
            </div>
          </div>
        ) : (
          <ExecutionLogsView logs={logs} totalLogs={totalLogsCount} theme={theme} onClearLogs={handleClearLogs} />
        )}
      </main>

      {/* Modals */}
      <RouteEditorModal
        isOpen={isRouteModalOpen}
        onClose={() => setIsRouteModalOpen(false)}
        route={editingRoute}
        apps={apps}
        selectedAppId={selectedAppId}
        onSaveRoute={handleSaveRoute}
        theme={theme}
      />

      <AppModal
        isOpen={isAppModalOpen}
        onClose={() => setIsAppModalOpen(false)}
        app={editingApp}
        onSaveApp={handleSaveApp}
        theme={theme}
      />

      <TestSimulatorModal
        isOpen={isSimulatorOpen}
        onClose={() => setIsSimulatorOpen(false)}
        apps={apps}
        routes={routes}
        initialRoute={testRouteTarget}
        theme={theme}
      />

      <ConfirmModal
        isOpen={confirmState.isOpen}
        title={confirmState.title}
        message={confirmState.message}
        confirmText={confirmState.confirmText}
        type={confirmState.type}
        onClose={() => setConfirmState(prev => ({ ...prev, isOpen: false }))}
        onConfirm={confirmState.onConfirm}
        theme={theme}
      />
    </div>
  );
}

