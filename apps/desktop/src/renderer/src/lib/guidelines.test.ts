import { describe, expect, it } from 'vitest';
import { agent, guideline } from '../store/testBackend';
import {
  agentsReached,
  automaticReach,
  guidelineProblems,
  newGuidelineForm,
  preview,
  toggleGuideline,
} from './guidelines';

describe('guidelines', () => {
  it('says why a guideline reaches an agent without a pick', () => {
    expect(automaticReach({ scope: 'all', agentTags: [] }, [])).toEqual({ kind: 'all' });
    expect(
      automaticReach({ scope: 'tags', agentTags: ['Legal', 'research'] }, ['RESEARCH']),
    ).toEqual({ kind: 'tag', tag: 'research' });
    expect(automaticReach({ scope: 'tags', agentTags: ['legal'] }, ['research'])).toBeNull();
    expect(automaticReach({ scope: 'agents', agentTags: ['research'] }, ['research'])).toBeNull();
  });

  it('counts the agents a guideline reaches', () => {
    const agents = [
      agent('a', { tags: ['research'] }),
      agent('b', { guidelineIds: ['g'] }),
      agent('c'),
    ];
    expect(agentsReached(guideline('g'), agents).map((a) => a.id)).toEqual(['b']);
    const tagged = guideline('g', { scope: 'tags', agentTags: ['research'] });
    expect(agentsReached(tagged, agents).map((a) => a.id)).toEqual(['a', 'b']);
    expect(agentsReached(guideline('g', { scope: 'all' }), agents)).toHaveLength(3);
  });

  it('toggles picks and validates the form', () => {
    expect(toggleGuideline(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(toggleGuideline(['a', 'b'], 'b', true)).toEqual(['a', 'b']);
    expect(toggleGuideline(['a', 'b'], 'a', false)).toEqual(['b']);
    expect(guidelineProblems(newGuidelineForm())).toEqual(['name']);
    expect(guidelineProblems({ ...newGuidelineForm(), name: 'x', scope: 'tags' })).toEqual([
      'tags',
    ]);
  });

  it('previews the first line of text, without Markdown markers', () => {
    expect(preview('\n## Tone\nPlain.')).toBe('Tone');
    expect(preview('- Cite sources\n- Be brief')).toBe('Cite sources');
    expect(preview('**Trial**: the first `14` days.')).toBe('Trial: the first 14 days.');
    expect(preview('  ')).toBe('');
  });
});
