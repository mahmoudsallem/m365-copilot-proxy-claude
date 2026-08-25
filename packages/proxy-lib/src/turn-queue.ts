// FIFO turn queue — the mechanical version of AGENTS.md rule #1 ("always run
// sequentially, one thread at a time"). The TurnGate already bounds inflight
// turns and staggers NEW conversation starts, but it still allows two turns in
// flight at once (default maxConcurrent=2). The account-level throttle keys on
// conversations started per unit time (docs/hypotheses.md F13) and surfaces as
// Disengaged-looking empties, so the main request path serializes here: each
// M365 turn holds the single slot until its stream fully drains.
//
// Scope note: sub-agent Task rounds deliberately bypass this queue — they are
// already staggered by the shared TurnGate and run read-only jobs.

import { createLogger } from "@m365-copilot/core";

const log = createLogger("turn-queue");

let tail: Promise<unknown> = Promise.resolve();
let waiting = 0;

/**
 * Run `fn` in strict FIFO order: a turn starts only after every previously
 * enqueued turn has settled. A rejected/failed turn propagates its error to
 * ITS caller but never poisons the chain for later turns.
 */
export function enqueueTurn<T>(fn: () => Promise<T>): Promise<T> {
  if (process.env.M365_NO_TURN_QUEUE === "1") return fn();
  if (waiting > 0) log.info(`Turn queued behind ${waiting} prior turn(s) (strict serial mode)`);
  waiting += 1;
  const run = tail.then(fn, fn);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  void run.finally(() => {
    waiting -= 1;
  }).catch(() => {});
  return run;
}

/** Queue depth (turns waiting for their slot; excludes the active one). */
export function turnQueueStats(): { waiting: number } {
  return { waiting };
}
