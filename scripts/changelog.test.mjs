import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCommit, renderNotes } from './changelog.mjs';

const c = (hash, subject, body = '') => parseCommit({ hash: hash.padEnd(40, '0'), subject, body });

test('parses type, scope, subject and breaking markers', () => {
  assert.deepEqual(c('a1', 'feat(runner): attachments as blocks'), {
    hash: 'a1'.padEnd(40, '0'),
    type: 'feat',
    scope: 'runner',
    subject: 'attachments as blocks',
    breaking: false,
    breakingNote: null,
  });
  assert.equal(c('a2', 'feat!: new protocol').breaking, true);
  const footer = c(
    'a3',
    'fix(contract): rename field',
    'Body.\n\nBREAKING CHANGE: `cost` is now `costUsd`.',
  );
  assert.equal(footer.breaking, true);
  assert.equal(footer.breakingNote, '`cost` is now `costUsd`.');
  assert.equal(c('a4', 'Merge branch main'), null);
  assert.equal(c('a5', 'WIP'), null);
});

test('groups by section and scope, leaves chores out, puts breaking changes first', () => {
  const notes = renderNotes({
    version: '0.2.0',
    date: '2026-10-01',
    repoUrl: 'https://example.test/repo',
    // git log order: newest first
    commits: [
      c('f3', 'feat(desktop): quick switcher'),
      c('x1', 'chore: bump deps'),
      c('d1', 'docs: usage guide'),
      c('f2', 'feat(runner): tokenizer'),
      c('b1', 'fix(desktop): scroll to a hit'),
      c('f1', 'feat(desktop): attachments'),
      c('k1', 'feat(contract)!: v2 bundle', 'BREAKING CHANGE: bundles are version 2'),
      c('t1', 'test(runner): more cases'),
      null,
    ],
  });
  assert.equal(
    notes,
    [
      '## 0.2.0 (2026-10-01)',
      '',
      '### Breaking changes',
      '',
      '- **contract:** bundles are version 2 ([k100000](https://example.test/repo/commit/k1' +
        '0'.repeat(38) +
        '))',
      '',
      '### Features',
      '',
      '- **contract:** v2 bundle ([k100000](https://example.test/repo/commit/k1' +
        '0'.repeat(38) +
        '))',
      '- **desktop:** attachments ([f100000](https://example.test/repo/commit/f1' +
        '0'.repeat(38) +
        '))',
      '- **desktop:** quick switcher ([f300000](https://example.test/repo/commit/f3' +
        '0'.repeat(38) +
        '))',
      '- **runner:** tokenizer ([f200000](https://example.test/repo/commit/f2' +
        '0'.repeat(38) +
        '))',
      '',
      '### Fixes',
      '',
      '- **desktop:** scroll to a hit ([b100000](https://example.test/repo/commit/b1' +
        '0'.repeat(38) +
        '))',
      '',
      '### Documentation',
      '',
      '- usage guide ([d100000](https://example.test/repo/commit/d1' + '0'.repeat(38) + '))',
      '',
    ].join('\n'),
  );
});

test('says so when nothing user-facing changed', () => {
  const notes = renderNotes({
    version: '0.1.1',
    date: '2026-10-02',
    commits: [c('x', 'chore: tidy')],
  });
  assert.match(notes, /_No user-facing changes._/);
});
