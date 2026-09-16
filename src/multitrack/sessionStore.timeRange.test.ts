/**
 * Lot J (item 10) — the multitrack TIME RANGE in the store: the raw setter,
 * its mutual exclusivity with `selectedGap` (J5) and independence from the
 * clip selection (J2), the two group verbs (`trimClipsToRange`,
 * `silenceClipsInRange`), and the ruling-3 view-state treatment (absent from
 * `SessionSnapshot`, absent from `.audm`).
 *
 * Shared fixture (X3 — non-identity throughout): session rate 48 000 (never
 * the 44 100 default); `T1` = `c1 {start: 20_000, len: 30_000, offsetSample:
 * 5_000}`; `T2` = `c2 {start: 60_000, len: 40_000}`, `c3 {start: 120_000,
 * len: 25_000}`; `T3` = `c4 {start: 10_000, len: 200_000}`. Range
 * `R = {startSample: 40_000, endSample: 130_000}`.
 */
import { serializeSession } from './sessionFile';
import { createClip, createTrack, type Session } from './session';
import { silenceClipsInRange, trimClipsToRange, useSessionStore } from './sessionStore';
import { SESSION_UNDO_KEY, _resetSessionUndo, undoSession } from './sessionUndo';
import { getHistory } from '../services/undoHistory';
import type { TimeRange } from './timeRange';

const store = () => useSessionStore.getState();
const doneLabels = () => getHistory(SESSION_UNDO_KEY).done;

const R: TimeRange = { startSample: 40_000, endSample: 130_000 };

function seed(): {
  session: Session;
  t1: string;
  t2: string;
  t3: string;
  c1: string;
  c2: string;
  c3: string;
  c4: string;
} {
  const t1 = createTrack('T1');
  const t2 = createTrack('T2');
  const t3 = createTrack('T3');
  const c1 = createClip({ documentId: 'doc-1', startSample: 20_000, offsetSample: 5_000, lengthSample: 30_000 });
  const c2 = createClip({ documentId: 'doc-1', startSample: 60_000, offsetSample: 0, lengthSample: 40_000 });
  const c3 = createClip({ documentId: 'doc-1', startSample: 120_000, offsetSample: 0, lengthSample: 25_000 });
  const c4 = createClip({ documentId: 'doc-1', startSample: 10_000, offsetSample: 0, lengthSample: 200_000 });
  t1.clips = [c1];
  t2.clips = [c2, c3];
  t3.clips = [c4];
  const session: Session = { name: 'Range Fixture', sampleRate: 48_000, tracks: [t1, t2, t3] };
  useSessionStore.setState({
    session,
    selectedClipId: null,
    selectedClipIds: [],
    selectedGap: null,
    currentTrackId: null,
    lastSplit: null,
    mtCursorSample: 0,
    mtTimeRange: null,
    mtZoom: { samplesPerPixel: 500, scrollSample: 0 },
    mtPlayState: 'stopped',
    mtPlayheadSample: 0,
    mtEnvelope: null,
  });
  return { session, t1: t1.id, t2: t2.id, t3: t3.id, c1: c1.id, c2: c2.id, c3: c3.id, c4: c4.id };
}

beforeEach(() => {
  _resetSessionUndo();
});

describe('setMtTimeRange — the raw setter and J5 mutual exclusivity', () => {
  it('stores the range and clears a standing selectedGap', () => {
    const { t1 } = seed();
    store().setSelectedGap({ trackId: t1, startSample: 0, endSample: 20_000 });
    store().setMtTimeRange(R);
    expect(store().mtTimeRange).toEqual(R);
    expect(store().selectedGap).toBeNull();
  });

  it('setMtTimeRange(null) leaves a standing gap alone', () => {
    const { t1 } = seed();
    const gap = { trackId: t1, startSample: 0, endSample: 20_000 };
    store().setSelectedGap(gap);
    store().setMtTimeRange(null);
    expect(store().selectedGap).toEqual(gap);
    expect(store().mtTimeRange).toBeNull();
  });

  it('re-setting the identical range returns the SAME state object (no-op guard)', () => {
    seed();
    store().setMtTimeRange(R);
    const before = useSessionStore.getState();
    store().setMtTimeRange({ startSample: R.startSample, endSample: R.endSample });
    expect(useSessionStore.getState()).toBe(before);
  });
});

describe('J5/J2 — which writers touch the range and which do not', () => {
  it('setSelectedGap(g) clears a standing range', () => {
    const { t1 } = seed();
    store().setMtTimeRange(R);
    store().setSelectedGap({ trackId: t1, startSample: 0, endSample: 20_000 });
    expect(store().mtTimeRange).toBeNull();
  });

  it('setSelectedClips leaves a standing range untouched (J2: scope is orthogonal to the range)', () => {
    const { c2 } = seed();
    store().setMtTimeRange(R);
    store().setSelectedClips([c2]);
    expect(store().mtTimeRange).toEqual(R);
  });
});

describe('trimClipsToRange (J1)', () => {
  it('shortens c1/c3/c4 to the range edges, leaves c2 untouched by object identity, in ONE undo entry', () => {
    const { session, t1, t2, t3, c1, c2, c3, c4 } = seed();
    const originalC2 = session.tracks[1].clips[0];
    const before = doneLabels().length;

    trimClipsToRange([t1, t2, t3], R);

    const byId = (id: string) => store().session.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
    expect(byId(c1)).toMatchObject({ startSample: 40_000, lengthSample: 10_000, offsetSample: 25_000 });
    expect(byId(c2)).toBe(originalC2); // same reference — never touched
    expect(byId(c3)).toMatchObject({ startSample: 120_000, lengthSample: 10_000 });
    expect(byId(c4)).toMatchObject({ startSample: 40_000, lengthSample: 90_000 });

    expect(doneLabels().length).toBe(before + 1);
    expect(doneLabels()[doneLabels().length - 1]).toBe('Trim to range');

    undoSession();
    const afterUndo = store().session;
    expect(afterUndo.tracks[0].clips[0]).toMatchObject({ startSample: 20_000, lengthSample: 30_000 });
    expect(afterUndo.tracks[1].clips).toEqual(session.tracks[1].clips);
    expect(afterUndo.tracks[2].clips[0]).toMatchObject({ startSample: 10_000, lengthSample: 200_000 });
  });

  it('pushes NO undo entry for an empty track-id list', () => {
    const { t1 } = seed();
    void t1;
    const before = doneLabels().length;
    trimClipsToRange([], R);
    expect(doneLabels().length).toBe(before);
  });

  it('pushes NO undo entry when the range changes nothing on the scoped tracks', () => {
    const { t1 } = seed();
    const before = doneLabels().length;
    // c1 [20_000, 50_000) sits entirely inside this range: nothing to trim.
    trimClipsToRange([t1], { startSample: 0, endSample: 1_000_000 });
    expect(doneLabels().length).toBe(before);
  });
});

describe('silenceClipsInRange (J4)', () => {
  it('splits the spanning clip on T3 into two pieces, in ONE undo entry', () => {
    const { t3 } = seed();
    const before = doneLabels().length;

    silenceClipsInRange([t3], R);

    const clips = store()
      .session.tracks.find((t) => t.id === t3)!
      .clips.slice()
      .sort((a, b) => a.startSample - b.startSample);
    expect(clips).toHaveLength(2);
    expect(clips[0]).toMatchObject({ startSample: 10_000, lengthSample: 30_000 });
    expect(clips[1]).toMatchObject({ startSample: 130_000, lengthSample: 80_000 });

    expect(doneLabels().length).toBe(before + 1);
    expect(doneLabels()[doneLabels().length - 1]).toBe('Silence range');
  });
});

describe('mtTimeRange is ruling-3 view state', () => {
  it('is absent from SessionSnapshot: set R, move a clip, undo — the range survives', () => {
    const { c1, t1 } = seed();
    store().setMtTimeRange(R);
    store().moveClip(c1, t1, 25_000);
    expect(store().mtTimeRange).toEqual(R); // untouched by an unrelated mutation

    undoSession(); // undoes the move, not the range
    expect(store().mtTimeRange).toEqual(R);
  });

  it('is null after newSession(48_000)', () => {
    seed();
    store().setMtTimeRange(R);
    store().newSession(48_000);
    expect(store().mtTimeRange).toBeNull();
  });

  it('serializeSession is byte-identical whether or not a range is standing', () => {
    const { session } = seed();
    const withoutRange = serializeSession(session, []).json;
    store().setMtTimeRange(R);
    const withRange = serializeSession(store().session, []).json;
    expect(withRange).toBe(withoutRange);
  });
});
