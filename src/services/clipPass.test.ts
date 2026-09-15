import { createDocument, docLength, type AudioDocument } from '../audio/AudioDocument';
import { createClip, type Clip } from '../multitrack/session';
import { useSessionStore } from '../multitrack/sessionStore';
import { _resetSessionUndo, canUndoSession, undoSession } from '../multitrack/sessionUndo';
import { registerAllEffects } from '../effects/registerAll';
import { runEffectOnSelection } from './effectRunner';
import { useAppStore, makeInitialState } from '../stores/appStore';
import {
  beginClipWork,
  clipPassTarget,
  clipWorkTargetId,
  endClipWork,
  EFFECT_CARD_WORK_ID,
  _resetClipWork,
} from './clipPass';

/**
 * Lot D (item 4), acceptance 1-7 — `clipPass.ts`'s working-copy lifecycle:
 * D1's multitrack arm ("the selected clip's own source window"), D5 (never
 * writes the source document), D6 (one multitrack Ctrl+Z reverses the
 * re-point), and the release guarantee (Risk 1).
 *
 * Fixture values are the brief's own (X3 — none are identity values): source
 * document 240 000 samples at 44 100 Hz, stereo; session at 48 000 Hz; clip
 * `startSample: 96 000`, `offsetSample: 24 000`, `lengthSample: 48 000`,
 * `gainDb: -3`. `clipSourceWindow` at 44 100/48 000 gives
 * `span = Math.round(48_000 * 44_100 / 48_000) = 44_100`, so the resolved
 * source window is `[24_000, 68_100)` — well inside the 240 000-sample doc,
 * no clamping.
 */

registerAllEffects();

const SOURCE_LEN = 240_000;
const SOURCE_SR = 44_100;
const SESSION_SR = 48_000;
const CLIP_START = 96_000;
const CLIP_OFFSET = 24_000;
const CLIP_LENGTH = 48_000;
const CLIP_GAIN_DB = -3;

function makeSourceDoc(): AudioDocument {
  return createDocument({
    name: 'Source.wav',
    sampleRate: SOURCE_SR,
    channels: [new Float32Array(SOURCE_LEN), new Float32Array(SOURCE_LEN)],
  });
}

/** Installs: a source document (active), a multitrack session at 48 000 Hz
 * with one track holding one clip over that document, and that clip
 * selected. Matches acceptance 1's opening state exactly ("View multitrack,
 * that clip selected, `activeDocumentId` = the source doc"). */
function setupClipFixture(): { source: AudioDocument; clipA: Clip; trackId: string } {
  useAppStore.setState(makeInitialState());
  useSessionStore.getState().newSession(SESSION_SR);
  useSessionStore.getState().setProjectPath(null);
  _resetSessionUndo();
  _resetClipWork();

  const source = makeSourceDoc();
  useAppStore.getState().addDocument(source);
  useAppStore.getState().setView('multitrack');

  useSessionStore.getState().addTrack();
  const trackId = useSessionStore.getState().session.tracks[0].id;
  const clipA = createClip({
    documentId: source.id,
    startSample: CLIP_START,
    offsetSample: CLIP_OFFSET,
    lengthSample: CLIP_LENGTH,
    gainDb: CLIP_GAIN_DB,
  });
  useSessionStore.getState().addClip(trackId, clipA);
  useSessionStore.getState().setSelectedClips([clipA.id]);

  return { source, clipA, trackId };
}

function findWorkDoc(sourceId: string): AudioDocument {
  const work = useAppStore.getState().documents.find((d) => d.id !== sourceId);
  if (!work) throw new Error('no working document minted');
  return work;
}

afterEach(() => {
  _resetClipWork();
});

// Acceptance 1 — FAILS TODAY (proved by reverting `beginClipWork` to a no-op
// and watching this go red; restored to green — see lot-d-report.md).
it('acceptance 1: the source document is never written', async () => {
  const { source } = setupClipFixture();
  const sourceChannelsBefore = source.channels[0];

  beginClipWork(EFFECT_CARD_WORK_ID);
  // Sanity: a working copy really did open (multitrack + one valid clip).
  expect(typeof clipPassTarget()).not.toBe('string');

  const outcome = await runEffectOnSelection('amplify', { gainDb: 6 }, {});
  expect(outcome).toBe('committed');

  const sourceNow = useAppStore.getState().documents.find((d) => d.id === source.id)!;
  expect(sourceNow.channels[0]).toBe(sourceChannelsBefore); // same REFERENCE — untouched
  expect(docLength(sourceNow)).toBe(SOURCE_LEN);
});

// Acceptance 2
it('acceptance 2: the working copy holds exactly the clip window', () => {
  const { source } = setupClipFixture();
  beginClipWork(EFFECT_CARD_WORK_ID);

  const work = findWorkDoc(source.id);
  expect(docLength(work)).toBe(44_100);
  expect(work.channels.length).toBe(2);
  expect(work.sampleRate).toBe(44_100);
});

// Acceptance 3
it('acceptance 3: a length-changing commit re-points the clip', () => {
  const { source, clipA, trackId } = setupClipFixture();
  beginClipWork(EFFECT_CARD_WORK_ID);
  const work = findWorkDoc(source.id);

  useAppStore.getState().updateDocument({
    ...work,
    channels: [new Float32Array(30_000), new Float32Array(30_000)],
  });

  const clips = useSessionStore.getState().session.tracks.find((t) => t.id === trackId)!.clips;
  expect(clips.some((c) => c.id === clipA.id)).toBe(false); // old clip gone
  const next = clips.find((c) => c.documentId === work.id)!;
  expect(next).toBeDefined();
  expect(next.offsetSample).toBe(0);
  expect(next.startSample).toBe(CLIP_START); // unmoved
  expect(next.lengthSample).toBe(32_653); // round(30_000 * 48_000 / 44_100)
});

// Acceptance 4 (D6)
it('acceptance 4 (D6): one undoSession restores the clip to its original source window', () => {
  const { source, clipA } = setupClipFixture();
  beginClipWork(EFFECT_CARD_WORK_ID);
  const work = findWorkDoc(source.id);
  useAppStore.getState().updateDocument({
    ...work,
    channels: [new Float32Array(30_000), new Float32Array(30_000)],
  });

  expect(canUndoSession()).toBe(true);
  undoSession();

  const clips = useSessionStore.getState().session.tracks.flatMap((t) => t.clips);
  const restored = clips.find((c) => c.id === clipA.id);
  expect(restored).toBeDefined();
  expect(restored!.documentId).toBe(source.id);
  expect(restored!.offsetSample).toBe(CLIP_OFFSET);
  expect(restored!.lengthSample).toBe(CLIP_LENGTH);
  expect(restored!.startSample).toBe(CLIP_START);
  expect(restored!.gainDb).toBe(CLIP_GAIN_DB);
  // Fix round 1 (finding 3) — without `withSessionGesture` around
  // `addClip`+`removeClip`, each pushes its OWN entry (two, not one), and one
  // `undoSession()` would only pop the most recent ("Remove clip"), leaving
  // BOTH the restored original clip AND the still-repointed `next` clip
  // (`documentId === work.id`) in the track simultaneously. The four field
  // checks above pass either way (clip A comes back regardless), so this is
  // the assertion that actually falls when the gesture wrap is removed.
  expect(clips.some((c) => c.documentId === work.id)).toBe(false);
});

// Acceptance 5 (D5)
it('acceptance 5 (D5): a second clip on the same source document is unaffected', () => {
  const { source, trackId } = setupClipFixture();
  const clipB = createClip({
    documentId: source.id,
    startSample: 300_000,
    offsetSample: 120_000,
    lengthSample: 60_000,
  });
  useSessionStore.getState().addClip(trackId, clipB);
  // Fix round 1 (finding 4) — D5's real hazard is B's AUDIO, which B does not
  // own (it is a window into `source`'s channels): B's own metadata fields
  // never move regardless of what this lot does, so the load-bearing check is
  // that `source` itself — what B actually reads at render/mixdown — is the
  // one thing D5 forbids writing. Captured here, matching acceptance 1.
  const sourceChannelsBefore = source.channels[0];

  beginClipWork(EFFECT_CARD_WORK_ID); // still targets clip A — B was never selected
  const work = findWorkDoc(source.id);
  useAppStore.getState().updateDocument({
    ...work,
    channels: [new Float32Array(30_000), new Float32Array(30_000)],
  });

  const sourceNow = useAppStore.getState().documents.find((d) => d.id === source.id)!;
  expect(sourceNow.channels[0]).toBe(sourceChannelsBefore); // same reference — B's audio is intact

  const b = useSessionStore
    .getState()
    .session.tracks.flatMap((t) => t.clips)
    .find((c) => c.id === clipB.id);
  expect(b).toBeDefined();
  expect(b!.documentId).toBe(source.id);
  expect(b!.offsetSample).toBe(120_000);
  expect(b!.lengthSample).toBe(60_000);
  expect(b!.startSample).toBe(300_000);
});

// Acceptance 6
it('acceptance 6: discard restores the working document, active document and captured selection', () => {
  const { source } = setupClipFixture();
  useAppStore.getState().setSelection({ start: 12_000, end: 60_000 });

  beginClipWork(EFFECT_CARD_WORK_ID);
  const workId = useAppStore.getState().activeDocumentId!;
  expect(workId).not.toBe(source.id);

  endClipWork(); // no edit — discard

  const app = useAppStore.getState();
  expect(app.documents.some((d) => d.id === workId)).toBe(false);
  expect(app.activeDocumentId).toBe(source.id);
  expect(app.selection).toEqual({ start: 12_000, end: 60_000 });
});

// Acceptance 7 (Risk 1) — the listener `beginClipWork` installs is the one
// this lot adds; `endClipWork` must remove it, not merely stop acting on it.
// Wraps the REAL callback `useAppStore.subscribe` receives in a counting spy
// (rather than spying on the private `repointClip`, which this module does
// not export) so the count reflects whether the SUBSCRIPTION itself still
// fires — independent of `repointClip`'s own idempotency (a second edit to
// an already-repointed clip is a documented no-op by clip id, which would
// make a spy on the session store's own actions pass even with a leaked
// listener).
it('acceptance 7: release — endClipWork stops the subscription from firing', () => {
  const { source } = setupClipFixture();

  const realSubscribe = useAppStore.subscribe.bind(useAppStore);
  let watched: jest.Mock | null = null;
  const subscribeSpy = jest
    .spyOn(useAppStore, 'subscribe')
    .mockImplementation((listener: Parameters<typeof useAppStore.subscribe>[0]) => {
      const wrapped = jest.fn(listener);
      watched = wrapped;
      return realSubscribe(wrapped);
    });

  beginClipWork(EFFECT_CARD_WORK_ID);
  subscribeSpy.mockRestore(); // stop intercepting further subscribe calls
  expect(watched).not.toBeNull();

  const work = findWorkDoc(source.id);
  useAppStore.getState().updateDocument({
    ...work,
    channels: [new Float32Array(9), new Float32Array(9)],
  });
  expect(watched!).toHaveBeenCalledTimes(1); // one call before release

  endClipWork();

  const workAfter = useAppStore.getState().documents.find((d) => d.id === work.id);
  expect(workAfter).toBeDefined(); // committed — the working copy stays active (D7)
  useAppStore.getState().updateDocument({
    ...workAfter!,
    channels: [new Float32Array(3), new Float32Array(3)],
  });
  expect(watched!).toHaveBeenCalledTimes(1); // one call TOTAL after — unchanged
});

// ---------------------------------------------------------------------------
// Fix round 1 — the CRITICAL/HIGH findings: per-kind slot ownership, and the
// drift-safe discard that keeps a watcher-triggered close from fighting
// whatever already moved `activeDocumentId` on. See lot-d-report.md's
// "Fix round 1" section for the full reproduction and the `activeDocumentId`
// writer enumeration.
//
// Fix round 2 correction — the line that stood here through fix round 1
// named the WRONG file for the App-level half of the fix (the drift watcher
// that actually closes a stale host, `App.tsx:635-645`) and was never
// verified: it said "pinned in App.effectHost.test.tsx", but no test there
// ever mentioned the watcher, and that file MOCKS `runEffectOnSelection`
// (`jest.mock('./services/effectRunner', ...)`), so an Apply there writes
// nothing regardless of which document is active — even a real regression
// would read green. The coordinator caught this by disabling the watcher and
// running exactly that file: 48 passed, 0 failed. The drift watcher is
// pinned in `App.test.tsx` instead (which mocks nothing effect-related), in
// the "the clip-work drift watcher closes a stale host..." describe block —
// four tests: the effect watcher and the tool watcher each verified in
// isolation (disabling one leaves the other's tests green), plus the full
// CRITICAL sequence in both orderings with a REAL `runEffectOnSelection`.
// This module (`clipPass.ts`) still cannot see any of that — it has no
// React coupling by design — so this file only ever pinned its own half
// (per-kind ownership, the drift-safe discard) and the correction above
// is the honest statement of that boundary, not a new unverified claim.
// ---------------------------------------------------------------------------

// Acceptance-2-adjacent (X3) — `clipPassTarget()`'s fourth refusal, the one
// branch with no coverage anywhere else in this lot (fix round 1, finding 8).
it('clipPassTarget: empty-window when the clip reads nothing from its (still open) source', () => {
  const { source, trackId } = setupClipFixture();
  // Offset sits exactly at the end of the 240_000-sample source: the
  // resolved window clamps to [240_000, 240_000) — empty, not merely short.
  const clip = createClip({
    documentId: source.id,
    startSample: 500_000,
    offsetSample: SOURCE_LEN,
    lengthSample: 1_000,
  });
  useSessionStore.getState().addClip(trackId, clip);
  useSessionStore.getState().setSelectedClips([clip.id]);

  expect(clipPassTarget()).toBe('empty-window');
});

// Fix round 1 (CRITICAL) — the per-kind ownership half of the fix: opening a
// SECOND, unrelated tool must never discard the effect card's own slot (the
// exact mechanism the reviewer's reproduction used — `edit.transcribe` is not
// a `CLIP_WORK_COMMANDS` member, so it mints nothing of its own, and the
// single-slot design's unconditional `endClipWork()` used to discard the
// effect's slot anyway).
it("fix round 1 (CRITICAL): opening an unrelated tool does not discard the effect card's slot", () => {
  const { source } = setupClipFixture();

  beginClipWork(EFFECT_CARD_WORK_ID);
  const effectTarget = clipWorkTargetId('effect');
  expect(effectTarget).not.toBeNull();
  expect(effectTarget).not.toBe(source.id);

  // 'edit.transcribe' is not a CLIP_WORK_COMMANDS member and mints nothing —
  // exactly the reviewer's reproduction's step 3.
  beginClipWork('edit.transcribe');

  expect(clipWorkTargetId('tool')).toBeNull(); // nothing minted for the tool kind
  expect(clipWorkTargetId('effect')).toBe(effectTarget); // UNTOUCHED
  // The working document itself is still open and active — proof this is not
  // merely "the id string survived", the actual document is intact.
  expect(useAppStore.getState().documents.some((d) => d.id === effectTarget)).toBe(true);
});

// Fix round 1 (CRITICAL) — the symmetric case: opening the effect card must
// never discard an already-open TOOL slot either.
it("fix round 1 (CRITICAL): opening the effect card does not discard a retained tool's slot", () => {
  setupClipFixture();

  beginClipWork('tempo.match');
  const toolTarget = clipWorkTargetId('tool');
  expect(toolTarget).not.toBeNull();

  beginClipWork(EFFECT_CARD_WORK_ID);

  expect(clipWorkTargetId('tool')).toBe(toolTarget); // UNTOUCHED
  expect(clipWorkTargetId('effect')).not.toBeNull();
  expect(clipWorkTargetId('effect')).not.toBe(toolTarget);
});

// Fix round 1 (HIGH) — the drift-safe discard: `endClipWork` must not FIGHT
// an `activeDocumentId` some OTHER writer already moved on its own (the
// watcher's own call arrives exactly in this state). Simulates "any writer"
// generically (`setActiveDocument`, standing in for FilesPanel/
// primeMultitrackDocTarget/a landing/etc. — see the enumeration in the
// report) rather than one specific call site.
it('fix round 1 (HIGH): a drifted discard closes the orphaned working copy without restoring over the new active document', () => {
  const { source } = setupClipFixture();
  const other = createDocument({
    name: 'Other.wav',
    sampleRate: SOURCE_SR,
    channels: [new Float32Array(1000)],
  });
  useAppStore.getState().addDocument(other); // becomes active momentarily
  useAppStore.getState().setView('multitrack'); // addDocument doesn't touch view

  beginClipWork(EFFECT_CARD_WORK_ID);
  const workId = clipWorkTargetId('effect')!;
  expect(useAppStore.getState().activeDocumentId).toBe(workId);

  // Something else (any of the enumerated writers) redirects the active
  // document away from the working copy WITHOUT going through clipPass.ts.
  useAppStore.getState().setActiveDocument(other.id);

  endClipWork('effect'); // the watcher's own call, in this exact state

  const app = useAppStore.getState();
  // The orphaned working copy is gone...
  expect(app.documents.some((d) => d.id === workId)).toBe(false);
  // ...but the drift is NOT fought: `other` stays active, not `source`
  // (the slot's captured restore point) and not reverted at all.
  expect(app.activeDocumentId).toBe(other.id);
});
