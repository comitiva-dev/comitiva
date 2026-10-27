import { useTranslation } from 'react-i18next';
import type { Guideline } from '@comitiva/contract';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { GuidelineForm } from '../components/Forms/GuidelineForm';
import { ui } from '../components/ui';
import { agentsReached, preview } from '../lib/guidelines';
import { useAgents, useGuidelines } from '../store/context';

/**
 * Guidelines: blocks of instructions, rules or reference data that go into
 * the system prompt of the agents they reach, after each agent's role, in
 * this order. One section of an AGENTS.md each.
 */
export function GuidelinesScreen() {
  const { t } = useTranslation();
  const items = useGuidelines((s) => s.items);
  const loaded = useGuidelines((s) => s.loaded);
  const editor = useGuidelines((s) => s.editor);
  const notice = useGuidelines((s) => s.notice);
  const feedback = useGuidelines((s) => s.feedback);
  const confirmDelete = useGuidelines((s) => s.confirmDelete);
  const openCreate = useGuidelines((s) => s.openCreate);
  const importFile = useGuidelines((s) => s.importFile);
  const exportFile = useGuidelines((s) => s.exportFile);
  const dismissNotice = useGuidelines((s) => s.dismissNotice);
  const cancelDelete = useGuidelines((s) => s.cancelDelete);
  const confirmDeletion = useGuidelines((s) => s.confirmDeletion);
  const agents = useAgents((s) => s.items);

  const editing = editor.mode === 'edit' ? (items.find((i) => i.id === editor.id) ?? null) : null;
  const deleting = items.find((i) => i.id === confirmDelete);
  const pickedBy = deleting ? agents.filter((a) => a.guidelineIds.includes(deleting.id)) : [];

  return (
    <section
      className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6"
      data-testid="guidelines-screen"
    >
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">{t('guidelines.title')}</h1>
          <div className="flex shrink-0 flex-wrap gap-2">
            <button
              data-testid="import-guidelines"
              className={ui.button}
              onClick={() => void importFile()}
            >
              {t('guidelines.import')}
            </button>
            <button
              data-testid="export-guidelines"
              className={ui.button}
              disabled={items.length === 0}
              onClick={() => void exportFile()}
            >
              {t('guidelines.export')}
            </button>
            <button data-testid="add-guideline" className={ui.primary} onClick={openCreate}>
              {t('guidelines.add')}
            </button>
          </div>
        </div>
        <p className={`text-sm ${ui.muted}`}>{t('guidelines.subtitle')}</p>
      </header>

      {(notice || feedback) && (
        <div
          role={notice ? 'alert' : 'status'}
          data-testid="notice"
          data-code={notice ?? feedback?.kind}
          className={`flex items-center justify-between rounded-md border p-3 text-sm ${
            notice
              ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200'
              : 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'
          }`}
        >
          <span className="min-w-0 break-words">
            {notice
              ? t(`errors.${notice}`)
              : feedback?.kind === 'imported'
                ? t('guidelines.imported', { count: feedback.count })
                : t('guidelines.exported', { path: feedback?.path ?? '' })}
          </span>
          <button className={ui.ghost} onClick={dismissNotice} aria-label={t('common.dismiss')}>
            ✕
          </button>
        </div>
      )}

      {loaded && items.length === 0 ? (
        <div
          data-testid="guidelines-empty"
          className={`${ui.card} flex flex-col gap-2 p-5 text-sm`}
        >
          <p className="font-medium">{t('guidelines.empty.title')}</p>
          <p className={ui.muted}>{t('guidelines.empty.body')}</p>
        </div>
      ) : (
        <ol className={`${ui.card} divide-y divide-neutral-200 dark:divide-neutral-800`}>
          {items.map((g, i) => (
            <GuidelineRow
              key={g.id}
              guideline={g}
              first={i === 0}
              last={i === items.length - 1}
              reached={agentsReached(g, agents).length}
            />
          ))}
        </ol>
      )}

      <p className={`text-xs ${ui.muted}`}>{t('guidelines.orderNote')}</p>

      {editor.mode !== 'closed' && (
        <GuidelineForm key={editor.mode === 'edit' ? editor.id : 'new'} editing={editing} />
      )}

      {deleting && (
        <ConfirmDialog
          title={t('guidelines.deleteTitle', { name: deleting.name })}
          body={
            pickedBy.length > 0
              ? t('guidelines.deleteBodyUsed', { count: pickedBy.length })
              : t('guidelines.deleteBody')
          }
          confirmLabel={t('guidelines.delete')}
          onConfirm={() => void confirmDeletion()}
          onCancel={cancelDelete}
        />
      )}
    </section>
  );
}

function GuidelineRow({
  guideline,
  first,
  last,
  reached,
}: {
  guideline: Guideline;
  first: boolean;
  last: boolean;
  reached: number;
}) {
  const { t } = useTranslation();
  const openEdit = useGuidelines((s) => s.openEdit);
  const askDelete = useGuidelines((s) => s.askDelete);
  const move = useGuidelines((s) => s.move);
  const scope =
    guideline.scope === 'tags'
      ? t('guidelines.scopeBadge.tags', { tags: guideline.agentTags.join(', ') })
      : t(`guidelines.scopeBadge.${guideline.scope}`);

  return (
    <li
      data-testid="guideline-row"
      data-id={guideline.id}
      data-name={guideline.name}
      className="flex items-center gap-3 px-4 py-3"
    >
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          <span className="truncate">{guideline.name}</span>
          <span
            data-testid="guideline-scope-badge"
            className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs font-normal text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
          >
            {scope}
          </span>
          <span data-testid="guideline-reach" className={`text-xs font-normal ${ui.muted}`}>
            {t('guidelines.reach', { count: reached })}
          </span>
        </p>
        <p className={`truncate text-xs ${ui.muted}`}>{preview(guideline.content)}</p>
      </div>
      <div className="flex shrink-0 gap-1">
        <button
          data-testid="move-up"
          className={ui.ghost}
          disabled={first}
          aria-label={t('agents.form.moveUp')}
          title={t('agents.form.moveUp')}
          onClick={() => void move(guideline.id, -1)}
        >
          ↑
        </button>
        <button
          data-testid="move-down"
          className={ui.ghost}
          disabled={last}
          aria-label={t('agents.form.moveDown')}
          title={t('agents.form.moveDown')}
          onClick={() => void move(guideline.id, 1)}
        >
          ↓
        </button>
        <button data-testid="edit" className={ui.ghost} onClick={() => openEdit(guideline.id)}>
          {t('guidelines.edit')}
        </button>
        <button data-testid="delete" className={ui.ghost} onClick={() => askDelete(guideline.id)}>
          {t('guidelines.delete')}
        </button>
      </div>
    </li>
  );
}
