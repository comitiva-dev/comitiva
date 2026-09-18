import type { ApiProviderId, OpenAICompatiblePreset } from '@comitiva/contract';

/**
 * A monogram badge per provider (and OpenAI-compatible preset). Deliberately
 * not brand logos: no trademark assets in the repo.
 */
const badges: Record<string, { text: string; className: string }> = {
  anthropic: {
    text: 'A',
    className: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300',
  },
  google: { text: 'G', className: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300' },
  ollama: {
    text: 'Ol',
    className: 'bg-stone-200 text-stone-800 dark:bg-stone-800 dark:text-stone-200',
  },
  openai: {
    text: 'O',
    className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  },
  openrouter: {
    text: 'OR',
    className: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300',
  },
  groq: { text: 'Gq', className: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300' },
  lmstudio: {
    text: 'LM',
    className: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300',
  },
  custom: {
    text: '{}',
    className: 'bg-neutral-200 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200',
  },
};

export function ProviderIcon({
  provider,
  preset,
  size = 'md',
}: {
  provider: ApiProviderId;
  preset?: OpenAICompatiblePreset | undefined;
  size?: 'sm' | 'md';
}) {
  const badge = badges[provider === 'openai-compatible' ? (preset ?? 'custom') : provider]!;
  const dims = size === 'sm' ? 'h-6 w-6 text-[10px]' : 'h-9 w-9 text-xs';
  return (
    <span
      aria-hidden
      data-testid="provider-icon"
      data-provider={provider}
      className={`inline-flex shrink-0 items-center justify-center rounded-md font-bold ${dims} ${badge.className}`}
    >
      {badge.text}
    </span>
  );
}
