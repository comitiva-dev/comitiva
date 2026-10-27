import type { RunGuideline } from '@comitiva/contract';

/**
 * The system prompt of a run: the agent's role, then its guidelines under a
 * `# Guidelines` heading, one `##` section each, in the order the shell sent
 * them. Guidelines with no text are left out.
 */
export function systemPrompt(role: string, guidelines: readonly RunGuideline[] = []): string {
  const sections = guidelines
    .filter((g) => g.content.trim() !== '')
    .map((g) => `## ${g.name}\n\n${g.content.trim()}`);
  if (sections.length === 0) return role;
  const block = `# Guidelines\n\n${sections.join('\n\n')}`;
  return role.trim() === '' ? block : `${role.trimEnd()}\n\n${block}`;
}
