import { useEffect } from 'react';
import { commandFor } from '../../shared/shortcuts';
import { isMac, runCommand } from './commands';
import { ShortcutsDialog } from './components/ShortcutsDialog';
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

  // Every shortcut (shared/shortcuts.ts); the native menu sends the same commands.
  useEffect(() => {
    const mac = isMac();
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented) return;
      const command = commandFor(e, mac);
      if (!command) return;
      e.preventDefault();
      runCommand(stores, command);
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
      <ShortcutsDialog />
      <TransferFeedback />
    </div>
  );
}
