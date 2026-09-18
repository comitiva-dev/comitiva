import { Sidebar } from './components/Sidebar/Sidebar';
import { ConnectionsScreen } from './screens/ConnectionsScreen';
import { PlaceholderScreen } from './screens/PlaceholderScreen';
import { useApp } from './store/context';

export function App() {
  const section = useApp((s) => s.section);
  return (
    <div className="flex h-screen bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      <Sidebar />
      <main className="flex min-w-0 flex-1 overflow-y-auto">
        {section === 'connections' ? (
          <ConnectionsScreen />
        ) : (
          <PlaceholderScreen section={section} />
        )}
      </main>
    </div>
  );
}
