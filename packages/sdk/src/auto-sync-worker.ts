import { parentPort, workerData } from 'node:worker_threads';
import { openContinuity } from './index.js';
import { AutoSync, AUTO_SYNC } from './auto-sync.js';

// Source traversal is synchronous today. Keep it off the dashboard/control event loop.
const port = parentPort;
if (!port || typeof workerData !== 'string') throw new Error('Auto-sync requires its runtime worker.');
const host = openContinuity(workerData);
const sync = new AutoSync(host, (event, id) => port.postMessage({ event, id }), AUTO_SYNC, () => port.postMessage({ status: sync.status() }));
port.on('message', async command => {
  if (command !== 'stop') return;
  await sync.stop(); host.close(); port.close();
});
sync.start();
