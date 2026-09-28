import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Agent } from '@comitiva/contract';
import { useConnections, useHub, useWorkspace } from '../../store/context';
import { ui } from '../ui';

/**
 * Personal → a workspace: copies the agent there. This member runs it with
 * the same connection and folders; the others choose their own connection.
 * The Personal agent and its conversations stay here.
 */
export function ShareAgent({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const inWorkspace = useWorkspace() !== null;
  const user = useHub((s) => s.status?.user ?? null);
  const workspaces = useHub((s) => s.workspaces);
  const busy = useHub((s) => s.busy);
  const shared = useHub((s) => s.shared);
  const notice = useHub((s) => s.notice);
  const shareAgent = useHub((s) => s.shareAgent);
  const dismissShared = useHub((s) => s.dismissShared);
  const connection = useConnections((s) =>
    s.items.find((c) => c.connection.id === agent.connectionId),
  );
  const [target, setTarget] = useState<string | null>(null);

  if (inWorkspace || !user || workspaces.length === 0 || !connection) return null;
  const chosen = target ?? workspaces[0]!.id;

  return (
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex items-center gap-1">
        <select
          aria-label={t('hub.share.to')}
          data-testid="share-workspace"
          className={ui.input}
          value={chosen}
          onChange={(e) => setTarget(e.target.value)}
        >
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <button
          data-testid="agent-share"
          className={ui.button}
          disabled={busy !== null}
          title={t('hub.share.hint')}
          onClick={() => void shareAgent(agent, connection.connection.provider, chosen)}
        >
          {t('hub.share.action')}
        </button>
      </div>
      {shared && (
        <p data-testid="agent-shared" className={`text-xs ${ui.ok}`}>
          {t('hub.share.done', { agent: shared.agentName, workspace: shared.workspaceName })}{' '}
          <button className="underline" onClick={dismissShared}>
            {t('common.dismiss')}
          </button>
        </p>
      )}
      {notice && busy === null && !shared && (
        <p role="alert" className={`text-xs ${ui.bad}`}>
          {t(`errors.${notice}`)}
        </p>
      )}
    </div>
  );
}
