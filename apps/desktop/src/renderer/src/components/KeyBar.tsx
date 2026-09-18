import { useTranslation } from 'react-i18next';
import { useSpike } from '../store/context';

export function KeyBar() {
  const { t } = useTranslation();
  const s = useSpike((s) => s);

  const keyMessage = (() => {
    switch (s.keyStatus) {
      case 'saving':
        return t('key.saving');
      case 'testing':
        return t('key.testing');
      case 'ok':
        return t('key.ok');
      case 'failed':
        return t('key.failed', { error: t(`errors.${s.keyError ?? 'internal'}`) });
      default:
        return s.hasApiKey ? t('key.saved') : t('key.missing');
    }
  })();

  return (
    <section className="flex flex-col gap-2 border-b border-gray-400 p-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-sm">
          {t('key.label')}
          <input
            data-testid="api-key"
            type="password"
            autoComplete="off"
            className="w-80 border border-gray-500 px-1"
            placeholder={t('key.placeholder')}
            value={s.apiKeyDraft}
            onChange={(e) => s.setApiKeyDraft(e.target.value)}
          />
        </label>
        <button
          data-testid="save-key"
          className="border border-gray-500 px-2"
          onClick={() => void s.saveApiKey()}
        >
          {t('key.save')}
        </button>
        <button
          data-testid="test-key"
          className="border border-gray-500 px-2 disabled:opacity-40"
          disabled={!s.hasApiKey}
          onClick={() => void s.testApiKey()}
        >
          {t('key.test')}
        </button>
        <label className="flex flex-col text-sm">
          {t('model.label')}
          <input
            data-testid="model"
            className="w-56 border border-gray-500 px-1"
            value={s.model}
            onChange={(e) => s.setModel(e.target.value)}
          />
        </label>
      </div>
      <p data-testid="key-status" className="text-sm">
        {keyMessage}
      </p>
      {s.weakSecretStorage && <p className="text-sm text-orange-700">{t('key.weak')}</p>}
    </section>
  );
}
