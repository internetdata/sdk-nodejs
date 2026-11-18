// p-retry waits 1 s, then 2 s, between attempts, on real timers. A test about what
// is retried, not how long it waits, runs its call under a mocked setTimeout, which
// keeps every attempt and its count while each turn of the event loop moves the
// clock a second on.

import { mock } from 'node:test';

export async function withoutBackoff(fn) {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        let done = false;
        const settled = fn();
        settled.then(() => { done = true; }, () => { done = true; });
        while (!done) {
            await new Promise((resolve) => setImmediate(resolve));
            mock.timers.tick(1000);
        }
        return await settled;
    } finally {
        mock.timers.reset();
    }
}
