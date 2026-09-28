import { useTranslation } from 'react-i18next';
import { useWorkspace, useWorkspaceStore } from '../../store/context';
import { ui } from '../ui';

/** Who else is in the workspace right now (Reverb presence). */
export function PresenceBar() {
  const { t } = useTranslation();
  const workspace = useWorkspace();
  const online = useWorkspaceStore((s) => s.online);
  if (!workspace) return null;
  const others = online.filter((m) => m.userId !== workspace.userId);
  return (
    <div
      data-testid="presence"
      data-online={others.map((m) => m.name).join(',')}
      className={`flex items-center gap-1.5 px-4 pb-2 text-xs ${ui.muted}`}
    >
      <span
        aria-hidden
        className={`h-2 w-2 shrink-0 rounded-full ${others.length > 0 ? 'bg-emerald-500' : 'bg-neutral-400'}`}
      />
      <span className="truncate">
        {others.length === 0
          ? t('hub.presence.alone')
          : t('hub.presence.online', { names: others.map((m) => m.name).join(', ') })}
      </span>
    </div>
  );
}
