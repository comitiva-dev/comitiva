import { describe, expect, it } from 'vitest';
import { message } from '../store/testBackend';
import {
  FIRST_INDEX_BASE,
  approvalTargets,
  canRetry,
  composerKey,
  firstItemIndex,
  formatInput,
  imageSrc,
  openConversation,
  renderParts,
  resultText,
  toolLabel,
  toolState,
} from './chat';

describe('openConversation', () => {
  it('falls back to the most recent one until the user picks', () => {
    expect(openConversation(undefined, ['k2', 'k1'])).toBe('k2');
    expect(openConversation(undefined, [])).toBeNull();
    expect(openConversation('k1', ['k2', 'k1'])).toBe('k1');
    expect(openConversation(null, ['k2', 'k1'])).toBeNull();
  });
});

describe('composerKey', () => {
  it('sends on Enter only', () => {
    expect(composerKey({ key: 'Enter', shiftKey: false })).toBe('send');
    expect(composerKey({ key: 'Enter', shiftKey: true })).toBeNull();
    expect(composerKey({ key: 'Enter', shiftKey: false, isComposing: true })).toBeNull();
    expect(composerKey({ key: 'a', shiftKey: false })).toBeNull();
  });
});

describe('canRetry', () => {
  it('is true only when the last message is a failed reply', () => {
    expect(canRetry([])).toBe(false);
    expect(canRetry([message('m1', { status: 'error' })])).toBe(true);
    expect(canRetry([message('m1', { status: 'error' }), message('m2')])).toBe(false);
    expect(canRetry([message('m1', { role: 'user', status: 'error' })])).toBe(false);
    expect(canRetry([message('m1', { status: 'cancelled' })])).toBe(false);
  });
});

describe('renderParts', () => {
  it('joins tool uses with their results and skips empty text', () => {
    const parts = renderParts([
      { type: 'text', text: '' },
      { type: 'text', text: 'Looking' },
      { type: 'tool_use', id: 't1', toolServerId: 'harness:claude-code', name: 'Read', input: {} },
      { type: 'tool_use', id: 't2', toolServerId: 'harness:claude-code', name: 'Grep', input: {} },
      { type: 'tool_result', toolUseId: 't1', content: [], isError: false },
      { type: 'tool_result', toolUseId: 'orphan', content: [], isError: false },
      { type: 'text', text: 'Done' },
    ]);
    expect(parts.map((p) => p.kind)).toEqual(['text', 'tool', 'tool', 'text']);
    expect(parts[1]).toMatchObject({ use: { id: 't1' }, result: { toolUseId: 't1' } });
    expect(parts[2]).toMatchObject({ use: { id: 't2' }, result: null });
  });

  it('keeps images and marks documents as other', () => {
    const parts = renderParts([
      { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'AA==' } },
      {
        type: 'document',
        name: 'a.pdf',
        mediaType: 'application/pdf',
        source: { kind: 'file', path: '/a.pdf' },
      },
    ]);
    expect(parts.map((p) => p.kind)).toEqual(['image', 'other']);
  });
});

describe('tool block helpers', () => {
  it('formats results and inputs', () => {
    expect(
      resultText({
        type: 'tool_result',
        toolUseId: 't',
        isError: false,
        content: [
          { type: 'text', text: 'line ' },
          { type: 'image', source: { kind: 'file', path: '/x.png' } },
        ],
      }),
    ).toBe('line \n[image]');
    expect(formatInput({ path: 'a' })).toBe('{\n  "path": "a"\n}');
    expect(formatInput('ls -la')).toBe('ls -la');
    expect(formatInput(undefined)).toBe('');
  });

  it('builds data URLs only for base64 images', () => {
    expect(
      imageSrc({ type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'AA==' } }),
    ).toBe('data:image/png;base64,AA==');
    expect(imageSrc({ type: 'image', source: { kind: 'file', path: '/x.png' } })).toBeNull();
  });
});

describe('firstItemIndex', () => {
  const page = [message('m3', { seq: 3 }), message('m4', { seq: 4 })];

  it('drops by the number of older messages loaded above the anchor', () => {
    expect(firstItemIndex(page, null)).toBe(FIRST_INDEX_BASE);
    expect(firstItemIndex(page, 3)).toBe(FIRST_INDEX_BASE);
    const older = [message('m1', { seq: 1 }), message('m2', { seq: 2 }), ...page];
    expect(firstItemIndex(older, 3)).toBe(FIRST_INDEX_BASE - 2);
  });

  it('does not move when replies are appended', () => {
    expect(firstItemIndex([...page, message('m5', { seq: 5 })], 3)).toBe(FIRST_INDEX_BASE);
  });
});

describe('tool blocks', () => {
  const use = (name: string, toolServerId = 'filesystem') => ({
    type: 'tool_use' as const,
    id: 't',
    toolServerId,
    name,
    input: {},
  });
  const result = (text: string, isError: boolean) => ({
    type: 'tool_result' as const,
    toolUseId: 't',
    content: [{ type: 'text' as const, text }],
    isError,
  });

  it('labels MCP tools by server and tool, harness tools by their name', () => {
    expect(toolLabel(use('fs__write_file'))).toEqual({ tool: 'write_file', server: 'fs' });
    expect(toolLabel(use('github_work__create__issue'))).toEqual({
      tool: 'create__issue',
      server: 'github_work',
    });
    expect(toolLabel(use('Read', 'harness:claude-code'))).toEqual({ tool: 'Read', server: null });
  });

  it('derives the state: awaiting, running, done, denied, failed, or stopped without a result', () => {
    expect(toolState(null, { streaming: true, awaiting: true })).toBe('awaiting');
    expect(toolState(null, { streaming: true, awaiting: false })).toBe('running');
    expect(toolState(null, { streaming: false, awaiting: false })).toBe('none');
    expect(toolState(result('ok', false), { streaming: true, awaiting: false })).toBe('done');
    expect(
      toolState(result('approval_denied: The user denied this action', true), {
        streaming: false,
        awaiting: false,
      }),
    ).toBe('denied');
    expect(
      toolState(result('outside_roots: /etc', true), { streaming: false, awaiting: false }),
    ).toBe('error');
  });

  it('lists the paths a call touches', () => {
    expect(approvalTargets({ path: '/w/a.txt', content: 'x' })).toEqual(['/w/a.txt']);
    expect(approvalTargets({ from: '/w/a', to: '/w/b' })).toEqual(['/w/a', '/w/b']);
    expect(approvalTargets('x')).toEqual([]);
  });
});
