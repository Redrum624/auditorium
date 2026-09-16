/**
 * Lot E — `sessionLanding`'s own contract: `planLanding` decides which of the
 * three arms a landing takes, `commitLanding` writes the in-place/appended
 * arms as one undo gesture, `installSession` is the shared REPLACE arm every
 * wholesale session swap in this app now goes through.
 *
 * X3: every fixture below plants clips at NON-ZERO starts on a session whose
 * source clip is NOT the first track, so a landing test that only proves
 * itself against `start: 0` / a single track cannot pass here.
 */
import { createDocument } from '../audio/AudioDocument';
import { createClip, createTrack, type Session } from './session';
import { hasAnyClip, useSessionStore } from './sessionStore';
import { _resetSessionUndo, canUndoSession, SESSION_UNDO_KEY, undoSession } from './sessionUndo';
import { getHistory } from '../services/undoHistory';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { commitLanding, installSession, planLanding } from './sessionLanding';
import { landStems } from '../services/stemLanding';
import { STEM_LABELS, type StemSeparationOutput } from '../services/stemService';

function seedSession(): { foreignClipId: string; sourceClipId: string; sourceTrackId: string } {
  const t1 = createTrack('Track 1');
  const t2 = createTrack('Track 2');
  const t3 = createTrack('Track 3');
  const t4 = createTrack('Track 4');
  const foreign = createClip({
    documentId: 'doc-foreign',
    startSample: 132_300,
    offsetSample: 0,
    lengthSample: 4000,
  });
  const source = createClip({
    documentId: 'doc-source',
    startSample: 220_500,
    offsetSample: 700,
    lengthSample: 5000,
    gainDb: -4,
    // Fix round 1 (item 3): non-identity fades on the anchor clip, so a
    // landing test that drops them cannot pass by accident.
    fadeInSample: 300,
    fadeOutSample: 450,
    fadeInCurve: 'equal-gain',
    fadeOutCurve: 'exponential',
  });
  t1.clips = [foreign];
  t2.clips = [source];
  t2.volumeDb = -6;
  t2.pan = 0.3;
  const session: Session = { name: 'My Session', sampleRate: 44100, tracks: [t1, t2, t3, t4] };
  useSessionStore.setState({
    session,
    selectedClipId: null,
    selectedClipIds: [],
    selectedGap: null,
    mtCursorSample: 12345,
    mtZoom: { samplesPerPixel: 100, scrollSample: 0 },
    mtPlayState: 'stopped',
    mtPlayheadSample: 0,
    mtEnvelope: null,
    projectPath: 'D:\\p.audm',
  });
  return { foreignClipId: foreign.id, sourceClipId: source.id, sourceTrackId: t2.id };
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  useSessionStore.getState().newSession(44100);
  // `newSession` above is itself a RECORDED mutation ('New session'), so every
  // test starts with a clean undo stack rather than one growing across the
  // whole file — the same convention `sessionStore.undo.test.ts` uses.
  _resetSessionUndo();
});

describe('planLanding — the mode gate (E2/E3, amendment E2-a)', () => {
  it('is "replaced" when the open session has no clips, even though newSession minted 4 tracks', () => {
    expect(hasAnyClip(useSessionStore.getState().session)).toBe(false);
    const plan = planLanding('doc-source');
    expect(plan.mode).toBe('replaced');
    expect(plan.startSample).toBe(0);
    expect(plan.insertIndex).toBeNull();
    expect(plan.displacedClipIds).toEqual([]);
    expect(plan.displacedTrackIds).toEqual([]);
    expect(plan.window).toBeNull();
    expect(plan.trackParams).toBeNull();
  });

  it('is "appended" when the session has clips but none carry the source document', () => {
    seedSession();
    const plan = planLanding('doc-not-open-anywhere');
    expect(plan.mode).toBe('appended');
    expect(plan.startSample).toBe(0);
    expect(plan.insertIndex).toBeNull();
    expect(plan.displacedClipIds).toEqual([]);
    expect(plan.displacedTrackIds).toEqual([]);
  });

  it('is "in-place" when a clip carries the source document — anchored to that clip, not sample 0', () => {
    const { sourceClipId, sourceTrackId } = seedSession();
    const plan = planLanding('doc-source');
    expect(plan.mode).toBe('in-place');
    expect(plan.startSample).toBe(220_500); // E4: the source clip's own startSample
    expect(plan.insertIndex).toBe(1); // track-2's position; no earlier track was displaced
    expect(plan.displacedClipIds).toEqual([sourceClipId]);
    expect(plan.displacedTrackIds).toEqual([sourceTrackId]); // that track carried ONLY this clip
    expect(plan.window).toEqual({
      offsetSample: 700,
      lengthSample: 5000,
      gainDb: -4,
      fadeInSample: 300,
      fadeOutSample: 450,
      fadeInCurve: 'equal-gain',
      fadeOutCurve: 'exponential',
    });
    expect(plan.trackParams).toEqual({ volumeDb: -6, pan: 0.3, muted: false, automation: undefined });
  });

  it('removes EVERY occurrence of the source document, not just the anchor, and only fully-emptied tracks', () => {
    const t1 = createTrack('Track 1');
    const t2 = createTrack('Track 2');
    const anchor = createClip({ documentId: 'doc-source', startSample: 1000, offsetSample: 0, lengthSample: 500 });
    const second = createClip({ documentId: 'doc-source', startSample: 9000, offsetSample: 0, lengthSample: 500 });
    const survivor = createClip({ documentId: 'doc-other', startSample: 500, offsetSample: 0, lengthSample: 500 });
    t1.clips = [anchor];
    // t2 carries a SECOND occurrence of the source AND a clip of something
    // else — it must lose the source's clip but must NOT be removed, because
    // it is not left with zero clips (the refinement E1 does not literally
    // ask for, stated rather than silently deviated).
    t2.clips = [second, survivor];
    const session: Session = { name: 'S', sampleRate: 44100, tracks: [t1, t2] };
    useSessionStore.setState({ session });

    const plan = planLanding('doc-source');
    expect(plan.mode).toBe('in-place');
    expect(plan.displacedClipIds.sort()).toEqual([anchor.id, second.id].sort());
    expect(plan.displacedTrackIds).toEqual([t1.id]); // t2 survives — it still has `survivor`
  });

});

describe('commitLanding — the in-place/appended write', () => {
  it('in-place: removes the displaced clip and its now-empty track, splices the landed tracks in at the anchor position, selects the first landed clip, one undo entry, and touches nothing else (undo shape)', () => {
    const { foreignClipId, sourceTrackId } = seedSession();
    const plan = planLanding('doc-source');
    const landed = createTrack('Voice');
    landed.clips = [
      createClip({ documentId: 'doc-voice', startSample: plan.startSample, offsetSample: 0, lengthSample: 5000 }),
    ];

    const before = useSessionStore.getState();
    commitLanding(plan, [landed], 'Separate Voice');
    const after = useSessionStore.getState();

    const tracks = after.session.tracks;
    expect(tracks.map((t) => t.id)).not.toContain(sourceTrackId);
    expect(tracks[1].id).toBe(landed.id); // spliced at the displaced track's own position
    expect(tracks.find((t) => t.id === 'track-does-not-exist')).toBeUndefined();
    // The foreign clip on track 1 is completely untouched.
    expect(tracks[0].clips.map((c) => c.id)).toEqual([foreignClipId]);
    expect(after.selectedClipId).toBe(landed.clips[0].id);

    expect(getHistory(SESSION_UNDO_KEY).done).toEqual(['Separate Voice']);
    // Everything ruling 3 says a landing must NOT touch:
    expect(after.projectPath).toBe(before.projectPath);
    expect(after.session.name).toBe(before.session.name);
    expect(after.mtPlayState).toBe(before.mtPlayState);
    expect(after.mtPlayheadSample).toBe(before.mtPlayheadSample);

    undoSession();
    const restored = useSessionStore.getState();
    expect(restored.session.tracks.map((t) => t.id)).toContain(sourceTrackId);
    expect(restored.projectPath).toBe('D:\\p.audm'); // still remembered — an append is not a load
  });

  it('appended: inserts at the end when insertIndex is null, leaves every existing track and clip standing', () => {
    seedSession();
    const plan = planLanding('doc-not-open-anywhere');
    expect(plan.insertIndex).toBeNull();
    const landedA = createTrack('Speaker 1');
    landedA.clips = [createClip({ documentId: 'doc-s1', startSample: 0, offsetSample: 0, lengthSample: 1000 })];
    const landedB = createTrack('Backing');
    landedB.clips = [createClip({ documentId: 'doc-b', startSample: 0, offsetSample: 0, lengthSample: 1000 })];

    const beforeCount = useSessionStore.getState().session.tracks.length;
    commitLanding(plan, [landedA, landedB], 'Separate Speakers');

    const tracks = useSessionStore.getState().session.tracks;
    expect(tracks).toHaveLength(beforeCount + 2);
    expect(tracks[tracks.length - 2].id).toBe(landedA.id);
    expect(tracks[tracks.length - 1].id).toBe(landedB.id);
    expect(useSessionStore.getState().selectedClipId).toBe(landedA.clips[0].id);
  });

  it('does not clear the session undo stack — a prior entry survives beside the landing (coverJourney.test.ts:823 is the filed case for a sibling site)', () => {
    seedSession();
    useSessionStore.getState().renameTrack(useSessionStore.getState().session.tracks[2].id, 'Renamed');
    expect(canUndoSession()).toBe(true);
    const plan = planLanding('doc-not-open-anywhere');
    const landed = createTrack('Backing');
    landed.clips = [createClip({ documentId: 'doc-b', startSample: 0, offsetSample: 0, lengthSample: 1000 })];

    commitLanding(plan, [landed], 'Separate Voice');

    expect(getHistory(SESSION_UNDO_KEY).done).toEqual(['Rename track', 'Separate Voice']);
  });
});

describe('installSession — the shared REPLACE arm', () => {
  function freshSession(): Session {
    const t = createTrack('Only');
    t.clips = [createClip({ documentId: 'doc-x', startSample: 0, offsetSample: 0, lengthSample: 1000 })];
    return { name: 'Landed', sampleRate: 48000, tracks: [t] };
  }

  it('swaps the session wholesale, resets every transient, clears history, and switches to multitrack', () => {
    seedSession();
    useSessionStore.getState().renameTrack(useSessionStore.getState().session.tracks[0].id, 'X');
    expect(canUndoSession()).toBe(true);
    useAppStore.getState().setView('waveform');

    const session = freshSession();
    installSession(session, 'D:\\new.audm');

    const after = useSessionStore.getState();
    expect(after.session).toBe(session);
    expect(after.selectedClipId).toBeNull();
    expect(after.mtCursorSample).toBe(0);
    expect(after.mtPlayState).toBe('stopped');
    expect(after.mtPlayheadSample).toBe(0);
    expect(after.projectPath).toBe('D:\\new.audm');
    expect(canUndoSession()).toBe(false); // history cleared — R3, the load-shaped rule
    expect(useAppStore.getState().view).toBe('multitrack');
  });

  it('resets mtEnvelope to null even when a real target was open (the drift the three copies disagreed on)', () => {
    seedSession();
    useSessionStore.getState().setMtEnvelope({ trackId: 't1', param: 'volumeDb' });
    expect(useSessionStore.getState().mtEnvelope).not.toBeNull();

    installSession(freshSession(), null);

    expect(useSessionStore.getState().mtEnvelope).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Acceptance item 9 (first half) — FAILS TODAY against the pre-lot-E code,
// which built its session-replacement object literal directly in
// `stemLanding.ts` and never wrote `mtEnvelope: null` (only `sessionFile.ts`
// did). The second half — the cover journey's Place stage — is pinned in
// `coverJourney.test.ts`, which already carries the mocking this journey
// needs; duplicating that harness here would test the mock, not the module.
// ---------------------------------------------------------------------------
describe('E5/mtEnvelope — landStems (replaced arm) does not leave a stale open-envelope target', () => {
  function makeOutput(): StemSeparationOutput {
    const length = 2000;
    const channels = (): Float32Array[] => [new Float32Array(length)];
    const source = createDocument({ name: 'Song', sampleRate: 44100, channels: channels() });
    useAppStore.getState().addDocument(source);
    return {
      sourceDocId: source.id,
      sourceName: source.name,
      sampleRate: 44100,
      channelCount: 1,
      lengthSamples: length,
      stems: STEM_LABELS.map((label) => ({ label, channels: channels() })),
      residual: channels(),
      sanitisedEstimateSamples: 0,
    };
  }

  it('resets mtEnvelope to null', () => {
    expect(hasAnyClip(useSessionStore.getState().session)).toBe(false); // the 'replaced' gate
    useSessionStore.getState().setMtEnvelope({ trackId: 't1', param: 'pan' });
    expect(useSessionStore.getState().mtEnvelope).not.toBeNull();

    landStems(makeOutput());

    expect(useSessionStore.getState().mtEnvelope).toBeNull();
  });
});
