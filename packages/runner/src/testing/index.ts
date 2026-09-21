export { createFakeMcp, type FakeMcp } from './fakeMcpServer.js';
export { startFakeProviders } from './fakeProviders.js';
export type {
  FakeProviderId,
  FakeProviders,
  FakeProvidersOptions,
  FakeRequest,
} from './fakeProviders.js';
export {
  anthropicConnection,
  claudeCodeConnection,
  codexConnection,
  fakeConnections,
  fakeHarnessBinaries,
  googleConnection,
  ollamaConnection,
  openaiConnection,
  testAgent,
  userText,
} from './fixtures.js';

import { startFakeProviders, type FakeProviders } from './fakeProviders.js';
/** @deprecated Phase 0 name; the Anthropic routes live at the root of `startFakeProviders`. */
export const startFakeAnthropic = startFakeProviders;
/** @deprecated use FakeProviders */
export type FakeAnthropic = FakeProviders;
