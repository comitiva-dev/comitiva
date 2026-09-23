#!/usr/bin/env node
// Release notes from conventional commits, with no dependencies.
//
//   node scripts/changelog.mjs [--from <ref>] [--to <ref>] [--version <x.y.z>]
//                              [--date <yyyy-mm-dd>] [--prepend CHANGELOG.md]
//
// --from defaults to the tag before --to (every commit when there is none);
// --to defaults to HEAD. Prints the notes, or prepends them to a file.
// Features, fixes, performance and docs are listed by scope; breaking changes
// (`feat!:` or a `BREAKING CHANGE:` footer) come first; chores, CI, tests,
// builds and style changes are left out.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REPO_URL = 'https://github.com/comitiva-dev/comitiva';

const SECTIONS = [
  ['feat', 'Features'],
  ['fix', 'Fixes'],
  ['perf', 'Performance'],
  ['docs', 'Documentation'],
];

const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<bang>!)?:\s+(?<subject>.+)$/;

/** One commit's conventional header, or null when it does not follow the convention. */
export function parseCommit({ hash, subject, body = '' }) {
  const m = HEADER.exec(subject.trim());
  if (!m?.groups) return null;
  const note = /^BREAKING[ -]CHANGE:\s*(.+)$/m.exec(body);
  return {
    hash,
    type: m.groups.type,
    scope: m.groups.scope ?? null,
    subject: m.groups.subject.trim(),
    breaking: Boolean(m.groups.bang) || note !== null,
    breakingNote: note ? note[1].trim() : null,
  };
}

function line(c, repoUrl) {
  const scope = c.scope ? `**${c.scope}:** ` : '';
  return `- ${scope}${c.subject} ([${c.hash.slice(0, 7)}](${repoUrl}/commit/${c.hash}))`;
}

/** Markdown notes for a version from parsed commits (newest first, as git log gives them). */
export function renderNotes({ version, date, commits, repoUrl = REPO_URL }) {
  const parsed = commits.filter(Boolean);
  const out = [`## ${version} (${date})`];
  const breaking = parsed.filter((c) => c.breaking);
  if (breaking.length > 0) {
    out.push('', '### Breaking changes', '');
    for (const c of breaking)
      out.push(line({ ...c, subject: c.breakingNote ?? c.subject }, repoUrl));
  }
  for (const [type, title] of SECTIONS) {
    const list = parsed.filter((c) => c.type === type);
    if (list.length === 0) continue;
    // By scope (unscoped last), oldest first inside each, which reads as a story.
    list.sort((a, b) => (a.scope ?? '~').localeCompare(b.scope ?? '~'));
    out.push('', `### ${title}`, '');
    const byScope = new Map();
    for (const c of list) byScope.set(c.scope, [...(byScope.get(c.scope) ?? []), c]);
    for (const group of byScope.values())
      for (const c of group.reverse()) out.push(line(c, repoUrl));
  }
  if (out.length === 1) out.push('', '_No user-facing changes._');
  return `${out.join('\n')}\n`;
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Commits in `from..to` (all of `to` when from is null). */
export function readCommits(from, to) {
  const range = from ? `${from}..${to}` : to;
  const raw = git('log', '--format=%H%x1f%s%x1f%b%x1e', range);
  return raw
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [hash, subject, body] = r.split('\x1f');
      return { hash, subject, body };
    });
}

function previousTag(to) {
  try {
    return git('describe', '--tags', '--abbrev=0', `${to}^`);
  } catch {
    return null;
  }
}

function main(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i += 2) opt[argv[i].replace(/^--/, '')] = argv[i + 1];
  const to = opt.to ?? 'HEAD';
  const from = opt.from ?? previousTag(to);
  const version =
    opt.version ??
    JSON.parse(readFileSync(new URL('../apps/desktop/package.json', import.meta.url), 'utf8'))
      .version;
  const date = opt.date ?? new Date().toISOString().slice(0, 10);
  const notes = renderNotes({ version, date, commits: readCommits(from, to).map(parseCommit) });
  if (!opt.prepend) return void process.stdout.write(notes);
  const file = opt.prepend;
  const title =
    '# Changelog\n\nAll notable changes, from conventional commits (`pnpm changelog`).\n';
  const rest = existsSync(file)
    ? readFileSync(file, 'utf8').replace(/^# Changelog\n[\s\S]*?(?=^## )/m, '')
    : '';
  writeFileSync(file, `${title}\n${notes}${rest ? `\n${rest}` : ''}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
