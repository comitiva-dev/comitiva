import { useTranslation } from 'react-i18next';
import { useSpike } from '../store/context';
import type { PaneId } from '../store/spike';

const fmt = (ms: number) => ms.toFixed(1);

export function Pane({ id }: { id: PaneId }) {
  const { t } = useTranslation();
  const pane = useSpike((s) => s.panes[id]);
  const setInput = useSpike((s) => s.setInput);
  const send = useSpike((s) => s.send);
  const cancel = useSpike((s) => s.cancel);
  const reset = useSpike((s) => s.reset);
  const streaming = pane.status === 'streaming';

  return (
    <section
      data-testid={`pane-${id}`}
      className="flex min-h-0 flex-col gap-2 border border-gray-400 p-3"
    >
      <h2 className="font-bold">{t('pane.title', { id: id.toUpperCase() })}</h2>
      <textarea
        data-testid="input"
        className="h-24 border border-gray-500 p-1 font-mono text-sm"
        placeholder={t('pane.placeholder')}
        value={pane.input}
        onChange={(e) => setInput(id, e.target.value)}
      />
      <div className="flex gap-2">
        <button
          data-testid="send"
          className="border border-gray-500 px-2 disabled:opacity-40"
          disabled={streaming}
          onClick={() => void send(id)}
        >
          {t('pane.send')}
        </button>
        <button
          data-testid="cancel"
          className="border border-gray-500 px-2 disabled:opacity-40"
          disabled={!streaming}
          onClick={() => void cancel(id)}
        >
          {t('pane.cancel')}
        </button>
        <button
          data-testid="reset"
          className="border border-gray-500 px-2 disabled:opacity-40"
          disabled={streaming}
          onClick={() => void reset(id)}
        >
          {t('pane.reset')}
        </button>
        <span data-testid="status" data-status={pane.status} className="text-sm">
          {t(`pane.status.${pane.status}`)}
          {pane.errorCode && ` — ${t(`errors.${pane.errorCode}`)}`}
        </span>
      </div>
      <pre
        data-testid="output"
        className="min-h-0 flex-1 overflow-auto border border-gray-300 bg-gray-50 p-2 text-sm whitespace-pre-wrap"
      >
        {pane.output}
      </pre>
      <p data-testid="usage" className="text-sm">
        {pane.usage
          ? t('pane.usage', {
              input: pane.usage.inputTokens,
              output: pane.usage.outputTokens,
              cacheRead: pane.usage.cacheReadTokens ?? 0,
              cacheWrite: pane.usage.cacheWriteTokens ?? 0,
            })
          : t('pane.noUsage')}
      </p>
      {pane.latency && (
        <p
          data-testid="latency"
          data-p50={pane.latency.p50}
          data-p95={pane.latency.p95}
          data-max={pane.latency.max}
          data-n={pane.latency.n}
          className="text-sm"
        >
          {t('pane.latency', {
            p50: fmt(pane.latency.p50),
            p95: fmt(pane.latency.p95),
            max: fmt(pane.latency.max),
            n: pane.latency.n,
          })}
        </p>
      )}
    </section>
  );
}
