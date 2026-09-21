import type { AgentAvatar as Avatar, AvatarColor } from '@comitiva/contract';
import { initials } from '../lib/agentForm';

/** Light and dark shades per palette color (literal strings, so Tailwind keeps them). */
export const avatarColorClasses: Record<AvatarColor, string> = {
  indigo: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200',
  violet: 'bg-violet-100 text-violet-800 dark:bg-violet-900 dark:text-violet-200',
  pink: 'bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-200',
  rose: 'bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-200',
  orange: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  amber: 'bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-200',
  emerald: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200',
  teal: 'bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200',
  sky: 'bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-200',
  slate: 'bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-100',
};

/** Solid swatches for the color picker. */
export const avatarSwatchClasses: Record<AvatarColor, string> = {
  indigo: 'bg-indigo-500',
  violet: 'bg-violet-500',
  pink: 'bg-pink-500',
  rose: 'bg-rose-500',
  orange: 'bg-orange-500',
  amber: 'bg-amber-500',
  emerald: 'bg-emerald-500',
  teal: 'bg-teal-500',
  sky: 'bg-sky-500',
  slate: 'bg-slate-500',
};

const sizes = {
  sm: 'h-6 w-6 text-[10px] [&>[data-emoji]]:text-sm',
  md: 'h-9 w-9 text-xs [&>[data-emoji]]:text-lg',
  lg: 'h-14 w-14 text-base [&>[data-emoji]]:text-3xl',
};

/** An agent's avatar: its emoji on its color, or the name's initials. */
export function AgentAvatar({
  avatar,
  name,
  size = 'md',
}: {
  avatar: Avatar;
  name: string;
  size?: keyof typeof sizes;
}) {
  return (
    <span
      aria-hidden
      data-testid="agent-avatar"
      data-color={avatar.color}
      data-emoji={avatar.emoji ?? ''}
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${sizes[size]} ${avatarColorClasses[avatar.color]}`}
    >
      {avatar.emoji ? <span data-emoji>{avatar.emoji}</span> : initials(name)}
    </span>
  );
}
