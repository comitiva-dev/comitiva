import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './i18n';
import './index.css';
import { LocalBackend } from './backend/LocalBackend';
import { createHubApi } from './backend/hub/HubApi';
import { Root } from './Root';
import { createHubStore } from './store/hub';

const local = new LocalBackend();
const transport = local.hubTransport();
const executor = local.hubExecutor();
const api = createHubApi(transport);
const hub = createHubStore({ local, api, transport, executor });
void hub.getState().init();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root local={local} hub={hub} api={api} transport={transport} executor={executor} />
  </StrictMode>,
);
