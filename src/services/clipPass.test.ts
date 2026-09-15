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

  const restored = useSessionStore
    .getState()
    .session.tracks.flatMap((t) => t.clips)
    .find((c) => c.id === clipA.id);
  expect(restored).toBeDefined();
  expect(restored!.documentId).toBe(source.id);
  expect(restored!.offsetSample).toBe(CLIP_OFFSET);
  expect(restored!.lengthSample).toBe(CLIP_LENGTH);
  expect(restored!.startSample).toBe(CLIP_START);
  expect(restored!.gainDb).toBe(CLIP_GAIN_DB);
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

  beginClipWork(EFFECT_CARD_WORK_ID); // still targets clip A — B was never selected
  const work = findWorkDoc(source.id);
  useAppStore.getState().updateDocument({
    ...work,
    channels: [new Float32Array(30_000), new Float32Array(30_000)],
  });

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
