import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Guideline, GuidelineScope } from '@comitiva/contract';
import { errorCode } from '../../backend/Backend';
import { addTags } from '../../lib/agentForm';
import type { Async } from '../../lib/async';
import {
  guidelineFormFor,
  guidelineProblems,
  newGuidelineForm,
  type GuidelineFormState,
} from '../../lib/guidelines';
import { useGuidelines } from '../../store/context';
import { ui } from '../ui';
import { FormShell } from './FormShell';

const scopes: GuidelineScope[] = ['all', 'tags', 'agents'];

/** Create/edit form for a guideline: name, text, and which agents it reaches. */
export function GuidelineForm({ editing }: { editing: Guideline | null }) {
  const { t } = useTranslation();
  const ids = useId();
  const save = useGuidelines((s) => s.save);
  const close = useGuidelines((s) => s.closeEditor);
  const [form, setForm] = useState<GuidelineFormState>(() =>
    editing ? guidelineFormFor(editing) : newGuidelineForm(),
  );
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState<Async<void>>({ state: 'idle' });
  const [submitted, setSubmitted] = useState(false);

  async function submit() {
    const withTags = { ...form, agentTags: addTags(form.agentTags, tagInput) };
    setForm(withTags);
    setTagInput('');
    setSubmitted(true);
    if (guidelineProblems(withTags).length > 0) return;
    const fields = {
      name: withTags.name.trim(),
      content: withTags.content,
      scope: withTags.scope,
      agentTags: withTags.agentTags,
    };
    setSaving({ state: 'busy' });
    try {
      await save(editing ? { id: editing.id, patch: fields } : { draft: fields });
    } catch (err) {
      setSaving({ state: 'failed', code: errorCode(err) });
    }
  }

  const problems = submitted ? guidelineProblems(form) : [];

  return (
    <FormShell
      icon={<span aria-hidden>📋</span>}
      title={t(editing ? 'guidelines.form.editTitle' : 'guidelines.form.createTitle')}
      testId="guideline-form"
      saving={saving}
      onClose={close}
      onSubmit={() => void submit()}
    >
      <label className={ui.label}>
        {t('guidelines.form.name')}
        <input
          data-testid="guideline-name"
          className={ui.input}
          value={form.name}
          maxLength={100}
          placeholder={t('guidelines.form.namePlaceholder')}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        {problems.includes('name') && (
          <span className={`text-xs ${ui.bad}`}>{t('guidelines.form.nameRequired')}</span>
        )}
      </label>

      <label className={ui.label}>
        {t('guidelines.form.content')}
        <textarea
          data-testid="guideline-content"
          className={`${ui.input} min-h-56 font-mono text-xs font-normal`}
          value={form.content}
          placeholder={t('guidelines.form.contentPlaceholder')}
          onChange={(e) => setForm({ ...form, content: e.target.value })}
        />
        <span className={ui.hint}>{t('guidelines.form.contentHint')}</span>
      </label>

      <fieldset className="flex flex-col gap-1.5" data-testid="guideline-scope">
        <legend className={ui.label}>{t('guidelines.form.scope')}</legend>
        {scopes.map((scope) => (
          <label key={scope} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name={`${ids}-scope`}
              data-testid={`scope-${scope}`}
              className="mt-1"
              checked={form.scope === scope}
              onChange={() => setForm({ ...form, scope })}
            />
            <span>
              {t(`guidelines.scopes.${scope}.label`)}
              <span className={`block ${ui.hint}`}>{t(`guidelines.scopes.${scope}.hint`)}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {form.scope === 'tags' && (
        <div className={ui.label}>
          <label htmlFor={`${ids}-tags`}>{t('guidelines.form.agentTags')}</label>
          <div className={`${ui.input} flex flex-wrap items-center gap-1`}>
            {form.agentTags.map((tag) => (
              <span
                key={tag}
                data-testid="guideline-tag"
                className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-xs dark:bg-neutral-800"
              >
                {tag}
                <button
                  type="button"
                  aria-label={t('agents.form.removeTag', { tag })}
                  onClick={() =>
                    setForm({ ...form, agentTags: form.agentTags.filter((x) => x !== tag) })
                  }
                >
                  ✕
                </button>
              </span>
            ))}
            <input
              id={`${ids}-tags`}
              data-testid="guideline-tags-input"
              className="min-w-24 flex-1 bg-transparent outline-none"
              value={tagInput}
              placeholder={form.agentTags.length === 0 ? t('agents.form.tagsPlaceholder') : ''}
              onChange={(e) => {
                const text = e.target.value;
                if (text.includes(',')) {
                  setForm({ ...form, agentTags: addTags(form.agentTags, text) });
                  setTagInput('');
                } else {
                  setTagInput(text);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  setForm({ ...form, agentTags: addTags(form.agentTags, tagInput) });
                  setTagInput('');
                } else if (e.key === 'Backspace' && tagInput === '' && form.agentTags.length > 0) {
                  setForm({ ...form, agentTags: form.agentTags.slice(0, -1) });
                }
              }}
            />
          </div>
          {problems.includes('tags') && (
            <span className={`text-xs ${ui.bad}`}>{t('guidelines.form.tagsRequired')}</span>
          )}
        </div>
      )}
    </FormShell>
  );
}
