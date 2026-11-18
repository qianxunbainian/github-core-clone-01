// Boot file for the forge entry.
//
// The grading harness runs exactly one process from this repository and
// talks to it over a small side channel: it publishes its own origin in
// MAKEFUN_ENV_URL, this program starts the forge on a port the kernel
// chooses, reports that port back, and then stays alive until the
// environment says the trial is over. Everything the suite scores lives
// behind createApp() in app.ts; this file is only the handshake around it.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (envOrigin === '') {
  console.error('MAKEFUN_ENV_URL is not set, so there is no environment to register with.');
  process.exit(1);
}

/** One register or poll request gets this long before it counts as failed. */
const REQUEST_DEADLINE_MS = 30_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The gap before retry number `round`: starts at 200 ms, grows by half
 * each round and is capped at 2 s. The environment may still be starting
 * when this process boots, so early failures are normal and cheap.
 */
function backoff(round: number): number {
  return Math.min(2_000, Math.round(200 * 1.5 ** Math.min(round, 12)));
}

/**
 * Tell the environment which port the forge bound. A 200 accepts the
 * registration; a 409 means an earlier registration already won and this
 * process simply carries on waiting. A 400 or 405 is the environment
 * rejecting the request itself, which no retry can fix, so it is fatal.
 * Anything else — a refused connection, a timeout, a 5xx — is retried.
 */
async function announcePort(port: number): Promise<void> {
  for (let round = 0; ; round += 1) {
    let status = 0;
    let detail = '';
    try {
      const response = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
      });
      status = response.status;
      if (status === 200 || status === 409) return;
      detail = await response.text();
    } catch {
      // The environment did not answer at all; fall through and retry.
    }
    if (status === 400 || status === 405) {
      throw new Error(`registration refused (HTTP ${status}): ${detail}`);
    }
    await pause(backoff(round));
  }
}

/** Poll the environment's /done until its body says the trial is over. */
async function awaitFinish(): Promise<void> {
  for (let round = 0; ; round += 1) {
    try {
      const response = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
      });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // A failed or garbled poll only ever means "not finished yet".
    }
    await pause(backoff(round));
  }
}

const forge = createApp();

try {
  const boundPort = await new Promise<number>((resolve, reject) => {
    forge.once('error', reject);
    forge.listen(0, () => {
      const address = forge.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the forge did not open an ephemeral TCP port'));
      } else {
        resolve(address.port);
      }
    });
  });
  console.log(`forge listening on port ${boundPort}`);

  await announcePort(boundPort);
  console.log('registered; holding until the environment ends the trial');

  await awaitFinish();
  forge.close();
  console.log('trial over; shutting down');
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
