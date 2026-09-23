import { useEffect } from 'react';
import { QuickSwitcher } from './components/QuickSwitcher';
import { Sidebar } from './components/Sidebar/Sidebar';
import { TransferFeedback } from './components/TransferFeedback';
import { AgentsScreen } from './screens/AgentsScreen';
import { ConnectionsScreen } from './screens/ConnectionsScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { ToolsScreen } from './screens/ToolsScreen';
import { UsageScreen } from './screens/UsageScreen';
import { useApp, useStoreApis } from './store/context';

export function App() {
  const section = useApp((s) => s.section);
  const stores = useStoreApis();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        const ui = stores.ui.getState();
        if (ui.quickSwitcherOpen) ui.closeQuickSwitcher();
        else ui.openQuickSwitcher();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stores]);
  return (
    <div className="flex h-screen bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      <Sidebar />
      <main className="flex min-w-0 flex-1 overflow-y-auto">
        {section === 'connections' ? (
          <ConnectionsScreen />
        ) : section === 'agents' ? (
          <AgentsScreen />
        ) : section === 'tools' ? (
          <ToolsScreen />
        ) : section === 'usage' ? (
          <UsageScreen />
        ) : (
          <SettingsScreen />
        )}
      </main>
      <QuickSwitcher />
      <TransferFeedback />
    </div>
  );
}
