import { describe, expect, it } from 'vitest';
import { BUILTIN_SERVERS } from '../src/index.js';

describe('mcp-servers', () => {
  it('reserves the built-in server names', () => {
    expect(BUILTIN_SERVERS).toEqual(['filesystem', 'google-drive']);
  });
});
