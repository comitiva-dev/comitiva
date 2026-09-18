import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './i18n';
import './index.css';
import { App } from './App';
import { LocalBackend } from './backend/LocalBackend';
import { SpikeStoreProvider } from './store/context';
import { createSpikeStore } from './store/spike';

const backend = new LocalBackend();
const store = createSpikeStore(backend);
backend.onEvent((event) => store.getState().handleEvent(event));
void store.getState().init();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SpikeStoreProvider store={store}>
      <App />
    </SpikeStoreProvider>
  </StrictMode>,
);
