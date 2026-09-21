import { useTranslation } from 'react-i18next';
import { ui } from '../components/ui';
import type { Section } from '../store/app';

/** Sections that arrive in later phases. */
export function PlaceholderScreen({
  section,
}: {
  section: Exclude<Section, 'connections' | 'agents'>;
}) {
  const { t } = useTranslation();
  return (
    <section data-testid={`placeholder-${section}`} className="mx-auto w-full max-w-3xl p-6">
      <h1 className="text-xl font-semibold">{t(`nav.${section}`)}</h1>
      <p className={`mt-2 text-sm ${ui.muted}`}>{t(`placeholder.${section}`)}</p>
    </section>
  );
}
