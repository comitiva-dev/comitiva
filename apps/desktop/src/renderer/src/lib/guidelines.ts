import { guidelinesFor, type Agent, type Guideline, type GuidelineScope } from '@comitiva/contract';

/**
 * Pure logic behind the Guidelines screen and the agent form's checklist,
 * kept out of the components so it is unit-tested without a DOM.
 */

/**
 * Why a guideline reaches an agent without being picked: every agent gets it,
 * or the agent has one of its tags (the first one that matches). Null when
 * only a pick brings it in.
 */
export function automaticReach(
  guideline: Pick<Guideline, 'scope' | 'agentTags'>,
  agentTags: readonly string[],
): { kind: 'all' } | { kind: 'tag'; tag: string } | null {
  if (guideline.scope === 'all') return { kind: 'all' };
  if (guideline.scope !== 'tags') return null;
  const tags = new Set(agentTags.map((t) => t.toLowerCase()));
  const tag = guideline.agentTags.find((t) => tags.has(t.toLowerCase()));
  return tag ? { kind: 'tag', tag } : null;
}

/** The agents a guideline reaches, by scope, tag or pick. */
export function agentsReached(guideline: Guideline, agents: readonly Agent[]): Agent[] {
  return agents.filter((a) => guidelinesFor(a, [guideline]).length > 0);
}

/** Picks a guideline in the form, or drops the pick. */
export function toggleGuideline(ids: readonly string[], id: string, on: boolean): string[] {
  if (on) return ids.includes(id) ? [...ids] : [...ids, id];
  return ids.filter((x) => x !== id);
}

export interface GuidelineFormState {
  name: string;
  content: string;
  scope: GuidelineScope;
  agentTags: string[];
}

export const newGuidelineForm = (): GuidelineFormState => ({
  name: '',
  content: '',
  scope: 'agents',
  agentTags: [],
});

export const guidelineFormFor = (g: Guideline): GuidelineFormState => ({
  name: g.name,
  content: g.content,
  scope: g.scope,
  agentTags: [...g.agentTags],
});

export type GuidelineFormProblem = 'name' | 'tags';

export function guidelineProblems(form: GuidelineFormState): GuidelineFormProblem[] {
  const out: GuidelineFormProblem[] = [];
  if (form.name.trim() === '') out.push('name');
  if (form.scope === 'tags' && form.agentTags.length === 0) out.push('tags');
  return out;
}

/** The first non-empty line, for the list. */
export function preview(content: string): string {
  return (
    content
      .split('\n')
      .map((l) =>
        l
          .replace(/^#+\s*|^[-*]\s+/, '')
          .replace(/\*\*|__|`/g, '')
          .trim(),
      )
      .find((l) => l !== '') ?? ''
  );
}
