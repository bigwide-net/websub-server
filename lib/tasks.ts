// Background work: timers, a limit for parallel outgoing requests, and tracking of running tasks.
import { log } from './log';

// Replaced by tests to skip waiting.
export const timing = {
    sleep: (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms)),
};

let active = 0;
let idleWaiters: (() => void)[] = [];

/** Runs fn in the background. Errors are logged. */
export function background(fn: () => Promise<void>): void {
    active++;
    Promise.resolve().then(fn).catch(err => log.exception(err)).finally(() => {
        if (--active == 0) {
            const waiters = idleWaiters;
            idleWaiters = [];
            waiters.forEach(w => w());
        }
    });
}

/** Resolves when no background task is running (for tests). */
export function whenIdle(): Promise<void> {
    if (!active) return Promise.resolve();
    return new Promise(resolve => idleWaiters.push(resolve));
}

/** A limiter that runs at most max() functions at a time; the others wait in order. */
export function createPool(max: () => number) {
    let running = 0;
    const waiting: (() => void)[] = [];
    return async function run<T>(fn: () => Promise<T>): Promise<T> {
        if (running >= max())
            await new Promise<void>(resolve => waiting.push(resolve)); // the finishing task hands over its slot
        else
            running++;
        try {
            return await fn();
        } finally {
            const next = waiting.shift();
            if (next) next();
            else running--;
        }
    };
}
