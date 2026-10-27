import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcInput, IpcInvokeChannel, IpcOutput } from '@comitiva/contract';
import { startFakeProviders, type FakeProviders, type FakeScript } from '@comitiva/runner/testing';

/**
 * Screenshots and a short recording for the README, the releases and the site.
 * Not a test: it stages a team of agents against the fake providers, with
 * scripted replies, and saves light and dark frames to docs/images, plus a
 * recording of the light run under test-results/screenshots-video. Run it with
 * `pnpm --filter desktop screenshots`, then turn the recording into the
 * README's GIF and the site's MP4 (the first second is the window resizing):
 *
 *   ffmpeg -ss 1 -i <recording>.webm -c:v libx264 -pix_fmt yuv420p -crf 23 \
 *     -movflags +faststart -an docs/images/demo.mp4
 *   ffmpeg -ss 1 -i <recording>.webm -vf "fps=12,scale=960:-1:flags=lanczos,split[a][b];\
 *     [a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer" \
 *     docs/images/demo.gif
 */

const appDir = join(__dirname, '..');
const outDir = join(appDir, '..', '..', 'docs', 'images');
const videoDir = join(appDir, 'test-results', 'screenshots-video');

const ASK = {
  researcher: 'What did customers say about onboarding in the Q3 interviews?',
  writer: 'Draft a one-page summary of the onboarding feedback and save it in the folder.',
  reviewer: 'Review the pricing page copy for tone and clarity.',
};

const REPLY = {
  researcher: `Across the 14 Q3 interviews, onboarding came up in 11. Three themes stand out:

### 1. The first hour decides it
- **9 of 11** said they judged the product in the first session.
- Teams that connected a data source on day one were still active a month later.

### 2. Setup asks too much up front
- Inviting teammates *before* seeing value was the most cited friction point.
- Two customers abandoned the trial at the permissions step.

### 3. Templates help, examples help more
- Customers asked for a worked example in their own domain rather than blank templates.

**Suggested next step:** move team invitations after the first successful run, and ship two domain examples (sales and research).`,
  writer: `Saved **onboarding-summary.md** in your folder: a one-page summary with the three themes, a quote for each, and the two suggested changes. Want me to turn it into slides next?`,
  reviewer: `The page reads well overall. Three suggestions:

1. **Lead with the outcome.** "Ship answers, not prompts" says more than the current feature list.
2. **Cut the jargon.** Replace "orchestration layer" with "one place for all your agents".
3. **Make the free tier obvious.** It is the third paragraph today; move it next to the main button.
4. **Answer the first objection.** Add one line on where data is stored, right under the plans.
5. **Shorten the FAQ.** Seven questions repeat the plans table; keep the three about billing and cancelling.

Want me to rewrite the hero section with these changes so you can compare both versions?`,
};

/** Guidelines for the team: one for everyone, two by tag, one the Writer picks. */
const GUIDELINES = [
  {
    name: 'House style',
    scope: 'all' as const,
    agentTags: [],
    content: `Write for customers, not for engineers.

- Short sentences, active voice.
- Lead with the answer, then the detail.
- No jargon: "one place for all your agents", not "orchestration layer".`,
  },
  {
    name: 'Customer research rules',
    scope: 'tags' as const,
    agentTags: ['research'],
    content: `- Quote customers word for word, with the interview number.
- Keep what customers said apart from what we conclude.
- Say how many interviews back each theme.`,
  },
  {
    name: 'Review checklist',
    scope: 'tags' as const,
    agentTags: ['review'],
    content: `1. Is the main point in the first sentence?
2. Is every claim backed by a source or a number?
3. Would a new customer understand every word?`,
  },
  {
    name: 'Glossary',
    scope: 'agents' as const,
    agentTags: [],
    content: `**Activation**: a team's first successful run.
**Trial**: the first 14 days, before a plan is chosen.`,
  },
];

const FILE = `# Onboarding feedback, Q3

Three themes from 14 customer interviews...
`;

function script(prompt: string): FakeScript | undefined {
  for (const [who, ask] of Object.entries(ASK) as Array<[keyof typeof ASK, string]>) {
    if (prompt === ask) {
      return who === 'writer'
        ? {
            text: REPLY.writer,
            tools: [
              { name: 'fs__list_dir', input: { path: '.' } },
              { name: 'fs__read_file', input: { path: 'interviews-q3.md' } },
              { name: 'fs__write_file', input: { path: 'onboarding-summary.md', content: FILE } },
            ],
          }
        : { text: REPLY[who] };
    }
    // The title request quotes the first exchange.
    if (prompt.includes(ask)) {
      const titles = {
        researcher: 'Onboarding in Q3 interviews',
        writer: 'Onboarding summary draft',
        reviewer: 'Pricing page review',
      };
      return { text: titles[who] };
    }
  }
  return undefined;
}

let fake: FakeProviders;
let app: ElectronApplication;
let page: Page;

async function invoke<C extends IpcInvokeChannel>(
  channel: C,
  input?: IpcInput<C>,
): Promise<IpcOutput<C>> {
  const result = await page.evaluate(
    ([c, i]) =>
      (
        globalThis as unknown as { api: { invoke(c: string, i: unknown): Promise<unknown> } }
      ).api.invoke(c, i),
    [channel, input] as const,
  );
  const r = result as { ok: true; value: IpcOutput<C> } | { ok: false; error: { code: string } };
  if (!r.ok) throw new Error(`${channel}: ${r.error.code}`);
  return r.value;
}

const agentItem = (name: string) => page.locator(`[data-testid="agent-item"][data-name="${name}"]`);
const chat = () => page.getByTestId('chat');

async function open(agent: string) {
  await agentItem(agent).click();
  await expect(page.getByTestId('agent-title')).toHaveText(agent);
}

async function send(text: string) {
  const composer = page.getByTestId('composer');
  await composer.click();
  await page.keyboard.type(text, { delay: 12 });
  await composer.press('Enter');
}

test.setTimeout(180_000);

for (const scheme of ['light', 'dark'] as const) {
  test(`screenshots (${scheme})`, () => scene(scheme));
}

/** One run per theme; the light one is also recorded. */
async function scene(scheme: 'light' | 'dark') {
  const shot = (name: string) => page.screenshot({ path: join(outDir, `${name}-${scheme}.png`) });
  fake = await startFakeProviders({ intervalMs: 60, script });
  const root = await mkdtemp(join(tmpdir(), 'comitiva-shots-'));
  const userData = join(root, 'userData');
  // Shown in the agent panel, so a readable path rather than the temporary folder's.
  const folder = join(tmpdir(), 'Customer research');
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'interviews-q3.md'), '# Q3 interviews\n\n14 interviews, notes...\n');
  await writeFile(join(folder, 'pricing-page.md'), '# Pricing\n');
  await mkdir(outDir, { recursive: true });

  app = await electron.launch({
    args: [
      appDir,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      '--password-store=basic',
    ],
    env: {
      ...process.env,
      COMITIVA_USER_DATA: userData,
      COMITIVA_ALLOW_WEAK_SECRET_STORAGE: '1',
      COMITIVA_DISABLE_UPDATES: '1',
    },
    colorScheme: scheme,
    ...(scheme === 'light'
      ? { recordVideo: { dir: videoDir, size: { width: 1440, height: 900 } } }
      : {}),
  });
  page = await app.firstWindow();
  await expect(page.getByTestId('runner-status')).toHaveAttribute('data-status', 'ready', {
    timeout: 20_000,
  });

  const claude = await invoke('connections.create', {
    provider: 'anthropic',
    name: 'Anthropic',
    apiKey: 'sk-screenshots',
    config: { baseUrl: fake.urls.anthropic, defaultModel: 'claude-sonnet-4-5' },
  });
  const local = await invoke('connections.create', {
    provider: 'ollama',
    name: 'Ollama',
    config: { baseUrl: fake.urls.ollama, defaultModel: 'llama-fake:latest' },
  });
  const guidelines = [];
  for (const g of GUIDELINES) guidelines.push(await invoke('guidelines.create', g));
  const glossary = guidelines.find((g) => g.name === 'Glossary')!.id;
  const agents = [
    [
      'Researcher',
      'indigo',
      '🔎',
      claude,
      'Finds sources and summarizes them with citations.',
      false,
      ['research'],
      [],
    ],
    [
      'Writer',
      'emerald',
      '✍️',
      claude,
      'Drafts documents in the shared folder.',
      true,
      ['writing'],
      [glossary],
    ],
    [
      'Reviewer',
      'amber',
      '🧐',
      local,
      'Reviews copy for tone, clarity and accuracy.',
      false,
      ['review'],
      [],
    ],
    ['Organizer', 'sky', '🗂️', local, 'Keeps the research folder tidy.', true, [], []],
  ] as const;
  for (const [name, color, emoji, conn, role, files, tags, guidelineIds] of agents) {
    await invoke('agents.create', {
      name,
      avatar: { color, emoji },
      connectionId: conn.connection.id,
      role,
      tags: [...tags],
      guidelineIds: [...guidelineIds],
      ...(files
        ? { roots: [{ path: folder, mode: 'readwrite' as const }], toolServerIds: ['filesystem'] }
        : {}),
    });
  }
  await invoke('settings.update', { language: 'en' });
  await page.reload();
  await expect(page.getByTestId('agent-item')).toHaveCount(4);
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    win.unmaximize();
    win.setContentSize(1440, 900);
  });
  await expect
    .poll(() => page.evaluate(() => (globalThis as unknown as { innerWidth: number }).innerWidth))
    .toBe(1440);

  // The Writer reads the folder and stops before writing.
  await open('Writer');
  await send(ASK.writer);
  await expect(chat().getByTestId('approval-card')).toBeVisible({ timeout: 20_000 });

  // The Researcher and the Reviewer answer at the same time.
  await open('Researcher');
  await send(ASK.researcher);
  await open('Reviewer');
  await send(ASK.reviewer);
  await open('Researcher');
  await expect(
    chat().locator('[data-testid="message"][data-role="assistant"]').last(),
  ).toContainText('in their own domain', { timeout: 20_000 });
  await shot('hero');

  // The approval card, then the write goes through.
  await open('Writer');
  await expect(chat().getByTestId('approval-card')).toBeVisible();
  await shot('approval');
  await page.waitForTimeout(800);
  await chat().getByTestId('approval-card').getByTestId('approve-allow').click();
  await expect(
    chat().locator('[data-testid="message"][data-role="assistant"]').last(),
  ).toContainText('slides next', { timeout: 20_000 });
  await page.waitForTimeout(1200);
  await shot('tools');

  // Search across every conversation.
  await page.keyboard.press('Control+K');
  await page.getByTestId('switcher-input').fill('onboarding');
  await expect(page.getByTestId('switcher-item').first()).toBeVisible();
  await page.waitForTimeout(400);
  await shot('search');
  await page.keyboard.press('Escape');

  // Guidelines: the list, one being edited, and the Writer's checklist.
  await page.getByTestId('nav-guidelines').click();
  await expect(page.getByTestId('guideline-row')).toHaveCount(GUIDELINES.length);
  await shot('guidelines');
  await page
    .locator('[data-testid="guideline-row"][data-name="Customer research rules"]')
    .getByTestId('edit')
    .click();
  await expect(page.getByTestId('guideline-form')).toBeVisible();
  await page.waitForTimeout(300);
  await shot('guideline-form');
  await page.getByTestId('guideline-form').getByTestId('cancel').click();

  await open('Writer');
  await page.getByTestId('agent-edit').click();
  await page
    .getByTestId('agent-guidelines')
    .evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  await shot('agent-guidelines');
  await page.getByTestId('cancel').click();

  // What the runs above cost, by connection, agent and model.
  await page.getByTestId('nav-usage').click();
  await page.waitForTimeout(800);
  await shot('usage');

  await app.close();
  await fake.close();
}
