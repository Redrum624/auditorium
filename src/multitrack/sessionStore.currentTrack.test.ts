/**
 * K2/K3 — `currentTrackId`, the CURRENT track: `setCurrentTrack`'s liveness
 * guard and no-op guard, and the reconcile subscriber that clears it when the
 * track it names is removed (the same treatment `selectedGap` already gets,
 * for the same reason — see the docblock beside `currentTrackId` in
 * `sessionStore.ts`).
 */
import { createClip, createTrack, type Session } from './session';
import { useSessionStore } from './sessionStore';
import { _resetSessionUndo, undoSession } from './sessionUndo';

const store = () => useSessionStore.getState();

/** Three tracks, non-zero clip starts (X3) — index 1 ('B') is the one every
 * test below actually exercises, so a bug that quietly reads `tracks[0]`
 * cannot pass by coincidence. */
function seed(): { session: Session; tracks: [string, string, string]; clip: string } {
  const t1 = createTrack('A');
  const t2 = createTrack('B');
  const t3 = createTrack('C');
  const clip = createClip({ documentId: 'doc-1', startSample: 40_000, offsetSample: 0, lengthSample: 20_000 });
  t2.clips = [clip];
  const session: Session = { name: 'Current Track Fixture', sampleRate: 44_100, tracks: [t1, t2, t3] };
  useSessionStore.setState({
    session,
    selectedClipId: null,
    selectedClipIds: [],
    selectedGap: null,
    currentTrackId: null,
    mtCursorSample: 0,
    mtPlayState: 'stopped',
    mtPlayheadSample: 0,
    mtEnvelope: null,
  });
  return { session, tracks: [t1.id, t2.id, t3.id], clip: clip.id };
}

let fx: ReturnType<typeof seed>;

beforeEach(() => {
  _resetSessionUndo();
  fx = seed();
});

describe('setCurrentTrack', () => {
  it('stores a live track id', () => {
    store().setCurrentTrack(fx.tracks[1]);
    expect(store().currentTrackId).toBe(fx.tracks[1]);
  });

  it('ignores an id no track in the session carries, leaving the standing value', () => {
    store().setCurrentTrack(fx.tracks[1]);
    store().setCurrentTrack('no-such-track');
    expect(store().currentTrackId).toBe(fx.tracks[1]);
  });

  it('clears with null', () => {
    store().setCurrentTrack(fx.tracks[1]);
    store().setCurrentTrack(null);
    expect(store().currentTrackId).toBeNull();
  });

  it('is a no-op that returns the same state object when the value is unchanged', () => {
    store().setCurrentTrack(fx.tracks[1]);
    const held = useSessionStore.getState();

    store().setCurrentTrack(fx.tracks[1]);

    expect(useSessionStore.getState()).toBe(held);
  });
});

describe('the reconcile subscriber (same treatment as selectedGap)', () => {
  it('removeTrack on the CURRENT track clears it to null', () => {
    store().setCurrentTrack(fx.tracks[1]);
    store().removeTrack(fx.tracks[1]);
    expect(store().currentTrackId).toBeNull();
  });

  it('removeTrack on a DIFFERENT track leaves the current one standing', () => {
    store().setCurrentTrack(fx.tracks[1]);
    store().removeTrack(fx.tracks[2]);
    expect(store().currentTrackId).toBe(fx.tracks[1]);
  });

  it('survives an undo/redo of a clip move — it rides no snapshot, session or view state', () => {
    store().setCurrentTrack(fx.tracks[1]);
    store().moveClip(fx.clip, fx.tracks[1], 50_000);

    undoSession();

    expect(store().currentTrackId).toBe(fx.tracks[1]);
  });

  it('is cleared by an undo that removes the track it names', () => {
    store().addTrack(); // records 'Add track' — a 4th track, D
    const added = store().session.tracks[store().session.tracks.length - 1].id;
    store().setCurrentTrack(added);
    expect(store().currentTrackId).toBe(added);

    undoSession(); // undoes the addTrack — D is gone from the restored session

    expect(store().currentTrackId).toBeNull();
  });
});
