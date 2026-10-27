import type { Agent } from './entities/agent.js';
import { GuidelineScope, type Guideline } from './entities/guideline.js';

/**
 * The guidelines that reach an agent, in prompt order: those with scope `all`,
 * those with scope `tags` sharing a tag with the agent, and those it picked.
 */
export function guidelinesFor(
  agent: Pick<Agent, 'tags' | 'guidelineIds'>,
  guidelines: readonly Guideline[],
): Guideline[] {
  const picked = new Set(agent.guidelineIds);
  const tags = new Set(agent.tags.map((t) => t.toLowerCase()));
  return guidelines
    .filter(
      (g) =>
        picked.has(g.id) ||
        g.scope === 'all' ||
        (g.scope === 'tags' && g.agentTags.some((t) => tags.has(t.toLowerCase()))),
    )
    .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
}

/** A guideline read from a Markdown file, before it is saved. */
export interface ParsedGuideline {
  name: string;
  content: string;
  scope: GuidelineScope;
  agentTags: string[];
}

const NAME_MAX = 100;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const MARKER = /^<!--\s*comitiva\s+(.*?)\s*-->$/;
const ATTR = /(\w+)="([^"]*)"/g;

/**
 * Splits an AGENTS.md or CLAUDE.md into guidelines: one per `##` section (or
 * per `#` section when the file has no `##`), deeper headings kept inside.
 * Text before the first section becomes a guideline named after the file's
 * `#` title, or `fallbackName`. Headings inside code fences do not split. A
 * `<!-- comitiva scope="tags" tags="a, b" -->` line right under a heading
 * (written by `guidelinesToMarkdown`) restores the scope; without it, a
 * guideline reaches only the agents that pick it.
 */
export function parseGuidelinesMarkdown(text: string, fallbackName: string): ParsedGuideline[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const headings: Array<{ line: number; level: number; title: string }> = [];
  let fence: string | null = null;
  lines.forEach((line, i) => {
    const f = FENCE.exec(line)?.[1];
    if (f) {
      if (fence === null) fence = f[0]!.repeat(f.length);
      else if (f.startsWith(fence)) fence = null;
      return;
    }
    if (fence !== null) return;
    const h = HEADING.exec(line);
    if (h) headings.push({ line: i, level: h[1]!.length, title: h[2]! });
  });

  const level = headings.some((h) => h.level === 2)
    ? 2
    : headings.some((h) => h.level === 1)
      ? 1
      : 0;
  const starts = headings.filter((h) => h.level === level);
  const title =
    level === 2
      ? headings.find((h) => h.level === 1 && h.line < (starts[0]?.line ?? Infinity))
      : undefined;

  const out: ParsedGuideline[] = [];
  const preambleEnd = starts[0]?.line ?? lines.length;
  const preamble = lines.slice(0, preambleEnd).filter((_, i) => i !== title?.line);
  push(out, title?.title ?? fallbackName, preamble);
  starts.forEach((h, i) => {
    push(out, h.title, lines.slice(h.line + 1, starts[i + 1]?.line ?? lines.length));
  });
  return out;
}

function push(out: ParsedGuideline[], rawName: string, body: string[]): void {
  let scope: GuidelineScope = 'agents';
  let agentTags: string[] = [];
  const first = body.findIndex((l) => l.trim() !== '');
  const marker = first >= 0 ? MARKER.exec(body[first]!.trim()) : null;
  if (marker) {
    const attrs: Record<string, string> = Object.fromEntries(
      [...marker[1]!.matchAll(ATTR)].map((m) => [m[1]!, m[2]!]),
    );
    const parsed = GuidelineScope.safeParse(attrs.scope);
    if (parsed.success) scope = parsed.data;
    agentTags = (attrs.tags ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t !== '');
    body = body.filter((_, i) => i !== first);
  }
  const content = body.join('\n').trim();
  const name = rawName.trim().slice(0, NAME_MAX);
  if (content === '' || name === '') return;
  out.push({ name, content, scope, agentTags });
}

/** The guidelines as one Markdown file that `parseGuidelinesMarkdown` reads back. */
export function guidelinesToMarkdown(
  guidelines: ReadonlyArray<Pick<Guideline, 'name' | 'content' | 'scope' | 'agentTags'>>,
  title = 'Guidelines',
): string {
  const sections = guidelines.map((g) => {
    const marker =
      g.scope === 'agents'
        ? ''
        : `<!-- comitiva scope="${g.scope}"${g.scope === 'tags' ? ` tags="${g.agentTags.join(', ')}"` : ''} -->\n\n`;
    return `## ${g.name}\n\n${marker}${g.content.trim()}\n`;
  });
  return [`# ${title}\n`, ...sections].join('\n');
}
