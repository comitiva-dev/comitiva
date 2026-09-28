import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const compose = ['compose', '-p', 'comitiva-e2e-hub', '-f', join(__dirname, 'docker-compose.yml')];
export const HUB_URL = 'http://localhost:8830';

/** Starts the hub (HUB_IMAGE, default comitiva-hub:local) and waits until it answers. */
export default async function setup(): Promise<() => void> {
  execFileSync('docker', [...compose, 'up', '-d', '--wait', 'postgres'], { stdio: 'inherit' });
  execFileSync('docker', [...compose, 'up', '-d'], { stdio: 'inherit' });
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const res = await fetch(`${HUB_URL}/api/v1/meta`);
      if (res.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('The hub did not start (docker compose logs web)');
    await new Promise((r) => setTimeout(r, 1000));
  }
  return () => {
    if (process.env.KEEP_HUB !== '1') {
      execFileSync('docker', [...compose, 'down', '-v'], { stdio: 'inherit' });
    }
  };
}
