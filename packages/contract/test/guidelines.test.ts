import { describe, expect, it } from 'vitest';
import {
  Guideline,
  GuidelineDraft,
  guidelinesFor,
  guidelinesToMarkdown,
  parseGuidelinesMarkdown,
  type Guideline as GuidelineT,
} from '../src/index.js';
import { agent, now } from './fixtures.js';

function guideline(over: Partial<GuidelineT> & { id: string }): GuidelineT {
  return Guideline.parse({
    name: over.id,
    content: `About ${over.id}.`,
    scope: 'agents',
    agentTags: [],
    position: 0,
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

describe('Guideline', () => {
  it('fills a draft with defaults', () => {
    expect(GuidelineDraft.parse({ name: ' Tone ' })).toEqual({
      name: 'Tone',
      content: '',
      scope: 'agents',
      agentTags: [],
    });
    expect(GuidelineDraft.safeParse({ name: '' }).success).toBe(false);
    expect(GuidelineDraft.safeParse({ name: 'x', scope: 'team' }).success).toBe(false);
  });
});

describe('guidelinesFor', () => {
  const all = [
    guideline({ id: '01J0000000000000000000000G', scope: 'agents', position: 3 }),
    guideline({ id: '01J0000000000000000000000A', scope: 'all', position: 2 }),
    guideline({
      id: '01J0000000000000000000000T',
      scope: 'tags',
      agentTags: ['Research'],
      position: 1,
    }),
    guideline({
      id: '01J0000000000000000000000U',
      scope: 'tags',
      agentTags: ['legal'],
      position: 0,
    }),
    guideline({ id: '01J0000000000000000000000P', scope: 'agents', position: 4 }),
  ];

  it('takes global ones, matching tags (any case) and picked ones, in position order', () => {
    const got = guidelinesFor(
      { tags: ['research'], guidelineIds: ['01J0000000000000000000000P'] },
      all,
    );
    expect(got.map((g) => g.id)).toEqual([
      '01J0000000000000000000000T',
      '01J0000000000000000000000A',
      '01J0000000000000000000000P',
    ]);
  });

  it('gives an agent without tags or picks only the global ones', () => {
    expect(guidelinesFor(agent, all).map((g) => g.id)).toEqual(['01J0000000000000000000000A']);
  });
});

describe('parseGuidelinesMarkdown', () => {
  it('makes one guideline per ## section, with the preamble under the # title', () => {
    const md = [
      '# Team rules',
      '',
      'We write for customers.',
      '',
      '## Tone',
      '',
      'Plain words.',
      '',
      '### Examples',
      'Say "use", not "utilize".',
      '',
      '## Sources',
      'Cite every claim.',
    ].join('\n');
    expect(parseGuidelinesMarkdown(md, 'AGENTS')).toEqual([
      { name: 'Team rules', content: 'We write for customers.', scope: 'agents', agentTags: [] },
      {
        name: 'Tone',
        content: 'Plain words.\n\n### Examples\nSay "use", not "utilize".',
        scope: 'agents',
        agentTags: [],
      },
      { name: 'Sources', content: 'Cite every claim.', scope: 'agents', agentTags: [] },
    ]);
  });

  it('splits on # when the file has no ##, and ignores headings in code fences', () => {
    const md = '# One\n\n```md\n## not a heading\n```\n\n# Two\n\nBody\r\n';
    expect(parseGuidelinesMarkdown(md, 'f').map((g) => [g.name, g.content])).toEqual([
      ['One', '```md\n## not a heading\n```'],
      ['Two', 'Body'],
    ]);
  });

  it('names a file without headings after the file, and skips empty sections', () => {
    expect(parseGuidelinesMarkdown('Be brief.\n', 'CLAUDE')).toEqual([
      { name: 'CLAUDE', content: 'Be brief.', scope: 'agents', agentTags: [] },
    ]);
    expect(parseGuidelinesMarkdown('## Empty\n\n## Full\nx', 'f').map((g) => g.name)).toEqual([
      'Full',
    ]);
  });

  it('reads back what guidelinesToMarkdown writes, scopes included', () => {
    const list = [
      { name: 'Everyone', content: 'Answer in English.', scope: 'all' as const, agentTags: [] },
      {
        name: 'Research',
        content: 'Quote sources.',
        scope: 'tags' as const,
        agentTags: ['research', 'legal'],
      },
      {
        name: 'Picked',
        content: 'Only when asked.\n\n### Detail\nMore.',
        scope: 'agents' as const,
        agentTags: [],
      },
    ];
    const md = guidelinesToMarkdown(list);
    expect(md.startsWith('# Guidelines\n')).toBe(true);
    expect(md).toContain('<!-- comitiva scope="tags" tags="research, legal" -->');
    expect(parseGuidelinesMarkdown(md, 'x')).toEqual(list);
  });
});
