import { describe, expect, it } from 'vitest';
import { systemPrompt } from '../../src/runs/systemPrompt.js';

describe('systemPrompt', () => {
  it('is the role alone without guidelines', () => {
    expect(systemPrompt('You research.')).toBe('You research.');
    expect(systemPrompt('', [])).toBe('');
  });

  it('appends the guidelines in order, one section each', () => {
    expect(
      systemPrompt('You research.\n', [
        { name: 'Tone', content: 'Plain words.' },
        { name: 'Sources', content: '\nCite every claim.\n' },
      ]),
    ).toBe(
      'You research.\n\n# Guidelines\n\n## Tone\n\nPlain words.\n\n## Sources\n\nCite every claim.',
    );
  });

  it('is only the guidelines when the role is empty, and skips empty ones', () => {
    expect(
      systemPrompt('  ', [
        { name: 'Blank', content: ' ' },
        { name: 'Tone', content: 'Plain words.' },
      ]),
    ).toBe('# Guidelines\n\n## Tone\n\nPlain words.');
  });
});
