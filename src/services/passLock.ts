// Lot M (item 13) — "never run more than one pipeline or process at a time
// ... we must wait until the end of a pipeline before starting another."
//
// The ONE registry that owns the app-wide single-pass lock (M1/M4). A leaf
// module: it imports nothing from React components, `menuActions`, or any
// other service, so every start path — a menu command, a hosted dialog's own
// module-lock callback, a panel button — can import it with no cycle.
//
// M-a (decisions.md / lot-m-brief.md): the lock is taken at the START SEAM
// (a menu command's `run()`, or App.tsx's `handleToolModuleLock`), never
// inside a service. `runEffectOnChannels`, `runEffectOnSelection`,
// `separateStems`, `diarizeChannels` and `mixdownSession` never call
// `acquirePass`/`runExclusivePass` themselves — `coverJourney.ts` calls
// `separateStems` from INSIDE a Cover Chain pass, and the three chains call
// `runEffectOnChannels` once per stage, so a lock taken in any of those
// deadlocks a chain against its own first separation / second stage. A
// re-entrant/counting lock was rejected for the same reason M3 gives: it
// would report "a pass is running" to the pass asking, naming the caller to
// itself. A per-service lock was rejected too — five parallel flags is this
// repo's dominant defect class, and none of them can answer "is ANYTHING
// running".
import { useSyncExternalStore } from 'react';

/** The app-wide kinds of a long-running pass M1 names: an effect's Apply, a
 * pipeline tool, a host job (stems/voice/diarize/transcribe/align), a
 * mixdown or an export. `'save'` is M-e's addition: Save is not named in M1
 * but holds the lock for the same reason a mixdown does — it is the other
 * multi-second whole-project encode, and today's Ctrl+S is silently dead
 * during a pass, so gating it beats leaving it live against a session a
 * landing is about to rewrite. */
export type PassKind = 'effect' | 'pipeline' | 'host-job' | 'mixdown' | 'export' | 'save';

export interface PassDescriptor {
  /** The command id where one exists ('effects.coverChain', 'file.export'),
   * the effect id otherwise ('noise-reduction'). */
  id: string;
  /** The human-readable pass name shown in the refusal sentence and every
   * disabled-control tooltip — a real name ('Cover Chain', 'Noise
   * Reduction'), never the kind and never a generic fallback. */
  label: string;
  kind: PassKind;
}

/** Sentinel `runExclusivePass` returns when the lock was already held. A
 * unique symbol rather than `null`/`undefined` — `fn` may legitimately
 * resolve to either of those, and a refusal must never be mistaken for a
 * successful run that happened to return one. */
export const PASS_REFUSED: unique symbol = Symbol('passLock.PASS_REFUSED');

/** M3 — the ONE refusal sentence, stated once so every surface renders the
 * same fact. `blockedByPassReason()` is what callers actually read; nothing
 * else composes its own wording. */
export function passBusyReason(label: string): string {
  return (
    `${label} is still running — Auditorium runs one pass at a time. ` +
    'Wait for it to finish; the editor, the transport and the keyboard stay live.'
  );
}

interface Held {
  descriptor: PassDescriptor;
  /** Per-acquire identity, never reused — what makes `release()` idempotent
   * and immune to a stale close firing after a newer pass has already
   * started (the `stemService.ts:877` `if (active === run)` shape,
   * acceptance 2b). */
  token: symbol;
}

let held: Held | null = null;

// ---------------------------------------------------------------------------
// Reactivity — version counter + subscribe/getSnapshot/usePassLock, copied in
// shape from `stemService.ts:317-345` (`useSyncExternalStore`, NOT zustand).
// ---------------------------------------------------------------------------

let version = 0;
const listeners = new Set<() => void>();

function bumpVersion(): void {
  version++;
  for (const listener of listeners) listener();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): PassDescriptor | null {
  return held?.descriptor ?? null;
}

/** Non-reactive read of the pass currently holding the lock, or `null`. */
export function getRunningPass(): PassDescriptor | null {
  return held?.descriptor ?? null;
}

export function isPassRunning(): boolean {
  return getRunningPass() !== null;
}

/** What every gated surface renders (M3) — `null` when nothing is running,
 * else `passBusyReason` of the running pass's own label. No surface may
 * compose a different sentence. */
export function blockedByPassReason(): string | null {
  const pass = getRunningPass();
  return pass ? passBusyReason(pass.label) : null;
}

/**
 * Fix round 1 (item 6) — M-c / the lot-B close duty (ledger Ruling R14),
 * exported from HERE rather than reimplemented by each of its two consumers
 * (`menuActions.ts`'s `file.close`, `FilesPanel.tsx`'s row ✕ — the ✕ cannot
 * route through `file.close` itself, since that command always closes the
 * ACTIVE document and a row can close any OTHER open one).
 *
 * `passFree()`'s blanket "disabled while the lock is held" is correct for
 * file.open/file.new/session.open/transport.record, which have no protection
 * against the document a pass depends on changing identity underneath them.
 * Closing a document while a HOSTED EFFECT's Apply is in flight is a
 * DIFFERENT, already-proven-safe case: the effect card resolves its target
 * document at commit time and discards a stale result instead of writing it
 * (T6-3 / fix rounds 2 and "Final round", pinned by
 * `App.effectHost.test.tsx`'s "the mouse stays live during Apply" suite —
 * closing the document the effect is applying to there raises no failure and
 * the card shows a stale-hint instead of corrupting anything). Blanket-gating
 * the close would silently refuse a close that suite proves is safe — a real
 * regression (X1), not a theoretical one. No pipeline tool has the same proof
 * on record (the "seven" pipeline dialogs discard their result on UNMOUNT
 * only, which a document close does not trigger), so every OTHER pass kind
 * still refuses the close — which is exactly the lot-B duty: a host job's
 * utility process would otherwise be killed with no confirmation by
 * `invalidateStemRun` / `invalidateTranscript` / `invalidateLyricsAlignment`
 * inside `closeDocumentFlow`.
 */
export function closeFree(): boolean {
  return !isPassRunning() || getRunningPass()?.kind === 'effect';
}

/** The reason a close is refused, or `null` when `closeFree()`. */
export function closeBlockedReason(): string | null {
  return closeFree() ? null : blockedByPassReason();
}

/**
 * M4 — the only public imperative hold for code that is not already inside
 * `runExclusivePass`. Returns an idempotent release closure, or `null` when
 * the lock is already held (the refusal M1 asks for). The closure no-ops
 * once a *different* acquire has taken the lock (acceptance 2b: a stale
 * release from a settled pass cannot free a newer one).
 */
export function acquirePass(d: PassDescriptor): (() => void) | null {
  if (held !== null) return null;
  const token = Symbol('passLock.token');
  held = { descriptor: d, token };
  bumpVersion();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (held?.token !== token) return;
    held = null;
    bumpVersion();
  };
}

/**
 * M5 — the guaranteed release. Acquire, then
 * `try { return await fn(); } finally { release(); }`: a normal return, an
 * early return, a thrown synchronous error and a rejected promise all run
 * the `finally`, so the lock cannot outlive the pass whichever way it ends —
 * including the crashed-utility-process path, because every host-job
 * service already turns that into a settled (resolved-with-failure or
 * rejected) promise at its own boundary before it ever reaches here
 * (`stemService.ts`'s MED-3 "always resolves" contract is the pattern the
 * sibling services follow). `fn` is never called when the lock is already
 * held — the caller gets `PASS_REFUSED` instead, and the counter proving
 * nothing ran is asserted in `passLock.test.ts`.
 */
export async function runExclusivePass<T>(
  d: PassDescriptor,
  fn: () => Promise<T>
): Promise<T | typeof PASS_REFUSED> {
  const release = acquirePass(d);
  if (release === null) return PASS_REFUSED;
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Monotonic counter bumped on every acquire and every release; non-reactive
 * read (mirrors `stemService.ts`'s `getStemVersion`). */
export function getPassVersion(): number {
  return version;
}

/** Re-renders the caller whenever the lock is acquired or released. Every
 * gated surface subscribes with this rather than reading a parallel
 * boolean, so it re-renders the instant the lock moves. */
export function usePassLock(): PassDescriptor | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Test seam: drops the lock unconditionally and resets the version counter.
 * Module state outlives a render/unmount pair (the same reasoning
 * `dialogBus.ts`'s old `_resetHostedToolRunning` documented) — a test that
 * leaves a pass acquired (deliberately, or by failing an assertion before
 * its own release) hands the next test in the file an `isPassRunning()` that
 * reads true with nothing running, which surfaces as an unrelated failure
 * several tests later.
 */
export function _resetPassLock(): void {
  held = null;
  version = 0;
}
