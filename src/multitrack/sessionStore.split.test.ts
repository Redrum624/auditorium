import { createClip, createTrack, type Clip, type Session } from './session';
import { splitClipsAt, splitTargets, useSessionStore } from './sessionStore';
import { resolveClipFadeSpecs } from './mixdown';
import { commitLanding, planLanding } from './sessionLanding';
import {
  SESSION_UNDO_KEY,
  _resetSessionUndo,
  canUndoSession,
  redoSession,
  undoSession,
} from './sessionUndo';
import { getHistory } from '../services/undoHistory';
import { _resetSnapPreference, setSnapEnabled } from '../services/snapPreference';

/**
 * Item 1 / M2 / N1-N5 — the split primitive: `splitClip` (one clip, one undo
 * entry), `splitTargets` (the pure predicate the enablement and the group verb
 * share) and `splitClipsAt` (the group verb).
 *
 * The load-bearing claims, each pinned below: the halves partition the span
 * with the LEFT keeping the id (N4); the right half's `offsetSample` advances
 * at the SOURCE document's rate (N3, `readClipSlice`'s own conversion); the
 * seam gets no fade while the outer fades ride their own half (N3); a split
 * inside or on the boundary of an overlap with a track-mate is refused, which
 * is what lets the write skip `maintainFacingFades` and still carry an armed
 * crossfade through untouched (N2); and the cursor sample is consumed verbatim
 * — the snap preference cannot change the result (N1).
 */

const store = () => useSessionStore.getState();
const sessionRef = () => useSessionStore.getState().session;
const doneLabels = () => getHistory(SESSION_UNDO_KEY).done;

function clipById(id: string): Clip | undefined {
  for (const t of sessionRef().tracks) {
    const c = t.clips.find((x) => x.id === id);
    if (c) return c;
  }
  return undefined;
}

/** Installs a session (raw setState — test setup is a load, not a mutation). */
function install(tracks: ReturnType<typeof createTrack>[]): void {
  useSessionStore.setState({
    session: { name: 'Split Fixture', sampleRate: 44100, tracks },
    selectedClipId: null,
    selectedClipIds: [],
    lastSplit: null, // G6 — every fixture starts with a clean anchor
    mtCursorSample: 0,
    mtPlayState: 'stopped',
    mtPlayheadSample: 0,
    mtEnvelope: null,
  });
}

/** Builds a session from a per-track list of `[start, length]` spans (the
 * `groupEdit.test.ts` builder). */
function seed(...tracks: [number, number][][]): { session: Session; ids: string[][] } {
  const built = tracks.map((spans, i) => {
    const t = createTrack(`Track ${i + 1}`);
    t.clips = spans.map(([startSample, lengthSample]) =>
      createClip({ documentId: `doc-${i + 1}`, startSample, offsetSample: 0, lengthSample })
    );
    return t;
  });
  install(built);
  return { session: useSessionStore.getState().session, ids: built.map((t) => t.clips.map((c) => c.id)) };
}

/** One track, one clip, written field by field — the geometry cases need
 * offsets, gain and fades the `[start, length]` builder does not carry. */
function seedOne(fields: Partial<Clip> & { startSample: number; lengthSample: number }): string {
  const t = createTrack('Track 1');
  const base = createClip({
    documentId: 'doc-1',
    startSample: fields.startSample,
    offsetSample: fields.offsetSample ?? 0,
    lengthSample: fields.lengthSample,
  });
  t.clips = [{ ...base, ...fields, id: base.id }];
  install([t]);
  return base.id;
}

const trackClips = (i = 0): Clip[] => sessionRef().tracks[i].clips;

beforeEach(() => {
  _resetSessionUndo();
});

afterEach(() => {
  _resetSnapPreference();
});

describe('splitClip — the geometry of the two halves', () => {
  it('1a partitions the span: the left half keeps the id, the right is fresh and sorted after it', () => {
    const id = seedOne({ startSample: 1000, offsetSample: 500, lengthSample: 2000, gainDb: -3 });
    const before = clipById(id)!;

    const rightId = store().splitClip(id, 1800);

    const clips = trackClips();
    expect(clips).toHaveLength(2);
    const left = clips.find((c) => c.id === id)!;
    expect(left).toEqual({
      ...before,
      startSample: 1000,
      offsetSample: 500,
      lengthSample: 800,
      gainDb: -3,
    });
    const right = clips.find((c) => c.id !== id)!;
    expect(rightId).toBe(right.id);
    expect(right.id).toMatch(/^clip-\d+$/);
    expect(right.id).not.toBe(id);
    expect(right.startSample).toBe(1800);
    expect(right.offsetSample).toBe(1300);
    expect(right.lengthSample).toBe(1200);
    expect(right.gainDb).toBe(-3);
    expect(right.documentId).toBe(before.documentId);
    expect(clips.map((c) => c.startSample)).toEqual([1000, 1800]);
  });

  it('1b advances the right half offset at the SOURCE document rate (N3)', () => {
    const idA = seedOne({ startSample: 1000, offsetSample: 500, lengthSample: 2000 });
    store().splitClip(idA, 1800, { docRate: 48000 });
    expect(trackClips().find((c) => c.id !== idA)!.offsetSample).toBe(
      500 + Math.round((800 * 48000) / 44100)
    );
    expect(500 + Math.round((800 * 48000) / 44100)).toBe(1371);

    const idB = seedOne({ startSample: 1000, offsetSample: 500, lengthSample: 2000 });
    store().splitClip(idB, 1800, { docRate: 44100 });
    expect(trackClips().find((c) => c.id !== idB)!.offsetSample).toBe(1300);

    const idC = seedOne({ startSample: 1000, offsetSample: 500, lengthSample: 2000 });
    store().splitClip(idC, 1800);
    expect(trackClips().find((c) => c.id !== idC)!.offsetSample).toBe(1300);
  });

  it('1c gives each outer fade to its own half and the seam none (N3)', () => {
    const id = seedOne({
      startSample: 1000,
      offsetSample: 500,
      lengthSample: 2000,
      fadeInSample: 300,
      fadeInCurve: 'smooth',
      fadeOutSample: 400,
      fadeOutCurve: 'exponential',
    });

    store().splitClip(id, 1800);

    const left = clipById(id)!;
    const right = trackClips().find((c) => c.id !== id)!;
    expect(left.fadeInSample).toBe(300);
    expect(left.fadeInCurve).toBe('smooth');
    expect(left.fadeOutSample).toBeUndefined();
    expect(left.fadeOutCurve).toBeUndefined();
    expect(right.fadeOutSample).toBe(400);
    expect(right.fadeOutCurve).toBe('exponential');
    expect(right.fadeInSample).toBeUndefined();
  });

  it('1d re-clamps a fade that no longer fits its half (reconcileTrimmedFades)', () => {
    const idA = seedOne({
      startSample: 1000,
      offsetSample: 0,
      lengthSample: 2000,
      fadeInSample: 1500,
    });
    store().splitClip(idA, 1800); // the left half is 800 long
    expect(clipById(idA)!.fadeInSample).toBe(800);

    const idB = seedOne({
      startSample: 1000,
      offsetSample: 0,
      lengthSample: 2000,
      fadeOutSample: 1500,
    });
    store().splitClip(idB, 1800); // the right half is 1200 long
    expect(trackClips().find((c) => c.id !== idB)!.fadeOutSample).toBe(1200);
  });

  it('1e carries an armed crossfade at an outer edge through untouched (N2)', () => {
    const t = createTrack('Track 1');
    const a = {
      ...createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 1000 }),
      fadeOutSample: 200,
    };
    const b = {
      ...createClip({ documentId: 'doc-1', startSample: 800, offsetSample: 0, lengthSample: 1000 }),
      fadeInSample: 200,
    };
    t.clips = [a, b];
    install([t]);

    const rightId = store().splitClip(a.id, 400);
    expect(rightId).not.toBeNull();

    const clips = trackClips();
    const right = clips.find((c) => c.id === rightId)!;
    expect(right.startSample).toBe(400);
    expect(right.lengthSample).toBe(600);
    expect(right.fadeOutSample).toBe(200);
    const left = clips.find((c) => c.id === a.id)!;
    expect(left.fadeInSample).toBeUndefined();
    expect(left.fadeOutSample).toBeUndefined();

    const specs = resolveClipFadeSpecs(clips);
    expect(specs.get(rightId!)!.crossOut).not.toBeNull();
    expect(specs.get(rightId!)!.crossOut!.lengthSample).toBe(200);
    expect(specs.get(b.id)!.crossIn).not.toBeNull();
    expect(specs.get(b.id)!.crossIn!.lengthSample).toBe(200);
  });

  it('1f refuses a point inside or ON the boundary of an overlap with a track-mate (N2)', () => {
    const t = createTrack('Track 1');
    const a = createClip({ documentId: 'doc-1', startSample: 0, offsetSample: 0, lengthSample: 1000 });
    const b = createClip({ documentId: 'doc-1', startSample: 800, offsetSample: 0, lengthSample: 1000 });
    const c = createClip({ documentId: 'doc-1', startSample: 100, offsetSample: 0, lengthSample: 500 });
    t.clips = [a, c, b];
    install([t]);

    const cases: [string, number][] = [
      [a.id, 900], // inside the a/b overlap
      [a.id, 800], // exactly on its low edge
      [b.id, 1000], // exactly on its high edge
      [c.id, 300], // c is CONTAINED in a — every interior point overlaps
    ];
    for (const [id, sample] of cases) {
      const pre = sessionRef();
      expect(store().splitClip(id, sample)).toBeNull();
      expect(sessionRef()).toBe(pre);
    }
    expect(canUndoSession()).toBe(false);
    expect(doneLabels()).toEqual([]);
  });

  it('1g refuses an edge, an out-of-range, a non-integer and an unknown id — and splits at exactly 32 in', () => {
    const id = seedOne({ startSample: 1000, offsetSample: 0, lengthSample: 2000 }); // end 3000
    for (const sample of [1000, 3000, 1031, 2969, 500, 4000, NaN, 1800.5]) {
      const pre = sessionRef();
      expect(store().splitClip(id, sample)).toBeNull();
      expect(sessionRef()).toBe(pre);
    }
    const pre = sessionRef();
    expect(store().splitClip('clip-none', 1800)).toBeNull();
    expect(sessionRef()).toBe(pre);
    expect(doneLabels()).toEqual([]);

    // The 32-sample boundary itself is legal, on both sides.
    const idLow = seedOne({ startSample: 1000, offsetSample: 0, lengthSample: 2000 });
    expect(store().splitClip(idLow, 1032)).not.toBeNull();
    const idHigh = seedOne({ startSample: 1000, offsetSample: 0, lengthSample: 2000 });
    expect(store().splitClip(idHigh, 2968)).not.toBeNull();
  });

  it('1k leaves the track automation object identical (per-track, timeline-keyed)', () => {
    const { ids, session } = seed([[1000, 2000]]);
    store().upsertAutomationKey(session.tracks[0].id, 'volumeDb', {
      positionSample: 500,
      value: -6,
    });
    _resetSessionUndo();
    const automation = sessionRef().tracks[0].automation;

    store().splitClip(ids[0][0], 1800);

    expect(sessionRef().tracks[0].automation).toBe(automation);
  });

  it('1l consumes the sample verbatim — the snap preference cannot change it (N1)', () => {
    setSnapEnabled(false);
    const idOff = seedOne({ startSample: 1000, offsetSample: 500, lengthSample: 2000 });
    store().splitClip(idOff, 1777);
    const withSnapOff = trackClips().map((c) => ({ ...c, id: '' }));

    setSnapEnabled(true);
    const idOn = seedOne({ startSample: 1000, offsetSample: 500, lengthSample: 2000 });
    store().splitClip(idOn, 1777);
    const withSnapOn = trackClips().map((c) => ({ ...c, id: '' }));

    expect(withSnapOn).toEqual(withSnapOff);
    expect(withSnapOff[0].lengthSample).toBe(777);
  });
});

describe('splitTargets — the pure resolver behind the enablement and the verb', () => {
  it('names at most one clip per track, and only on the named tracks', () => {
    const { session, ids } = seed([[0, 4000]], [[1000, 5000]], [[0, 4000]]);
    const [t1, t2, t3] = session.tracks.map((t) => t.id);

    const targets = splitTargets(sessionRef(), [t1, t2], 2000);
    expect(targets.map((x) => x.trackId)).toEqual([t1, t2]);
    expect(targets.map((x) => x.clip.id)).toEqual([ids[0][0], ids[1][0]]);
    expect(splitTargets(sessionRef(), [t3], 4000)).toEqual([]); // the edge
    expect(splitTargets(sessionRef(), [], 2000)).toEqual([]);
  });
});

describe('splitClipsAt — the group verb (one gesture, N4 selection)', () => {
  it('1h splits every named track in ONE undo entry, reversibly, with stable right ids', () => {
    const { session, ids } = seed([[0, 4000]], [[1000, 5000]], [[0, 4000]]);
    const [t1, t2] = session.tracks.map((t) => t.id);
    const untouched = sessionRef().tracks[2].clips[0];

    const made = splitClipsAt([t1, t2], 2000);

    expect(made).toHaveLength(2);
    expect(doneLabels()).toEqual(['Split clips']);
    expect(sessionRef().tracks[2].clips[0]).toBe(untouched);
    expect(trackClips(0)).toHaveLength(2);
    expect(trackClips(1)).toHaveLength(2);

    undoSession();
    const restored = sessionRef().tracks.flatMap((t) => t.clips);
    expect(restored).toHaveLength(3);
    expect(restored.map((c) => c.id)).toEqual([ids[0][0], ids[1][0], ids[2][0]]);
    expect(restored.map((c) => c.lengthSample)).toEqual([4000, 5000, 4000]);

    redoSession();
    expect(sessionRef().tracks.flatMap((t) => t.clips)).toHaveLength(5);
    expect(trackClips(0).map((c) => c.id)).toEqual([ids[0][0], made[0]]);
    expect(trackClips(1).map((c) => c.id)).toEqual([ids[1][0], made[1]]);
  });

  it('1h uses the singular label for a single target', () => {
    const { session } = seed([[0, 4000]], [[1000, 5000]]);
    splitClipsAt([session.tracks[0].id], 2000);
    expect(doneLabels()).toEqual(['Split clip']);
  });

  it('1i records no gesture at all when nothing qualifies', () => {
    const { session } = seed([[0, 4000]]);
    const pre = sessionRef();

    expect(splitClipsAt([session.tracks[0].id], 4000)).toEqual([]);

    expect(canUndoSession()).toBe(false);
    expect(doneLabels()).toEqual([]);
    expect(sessionRef()).toBe(pre);
  });

  it('1j adds the right halves of SELECTION MEMBERS only, primary unchanged (N4)', () => {
    const { session, ids } = seed([[0, 4000], [5000, 2000]]);
    const t1 = session.tracks[0].id;
    const a1 = ids[0][0];
    store().setSelectedClip(a1);

    const made = splitClipsAt([t1], 2000);

    expect(store().selectedClipId).toBe(a1);
    expect(store().selectedClipIds).toEqual([a1, made[0]]);
  });

  it('1j splits an UNSELECTED track-mate but leaves it out of the selection (M2 + N4)', () => {
    const { session, ids } = seed([[0, 4000], [5000, 2000]]);
    const t1 = session.tracks[0].id;
    const [a1, b1] = ids[0];
    store().setSelectedClip(b1); // the selected clip is NOT under the cursor

    const made = splitClipsAt([t1], 2000);

    expect(made).toHaveLength(1);
    expect(trackClips(0).map((c) => c.id)).toEqual([a1, made[0], b1]);
    expect(store().selectedClipIds).toEqual([b1]);
    expect(store().selectedClipId).toBe(b1);
  });
});

/**
 * Item 7 (G1-G6) — the second and later split narrows the selection to the
 * single piece between the last two cut points, via the `lastSplit` anchor
 * (`SessionState.lastSplit`) and `splitSelectionAfter`. X3: every fixture
 * below uses a clip at `startSample` 6000 (never 0) and cuts at 16000, 24000
 * and 20000 — the values named in the brief's Acceptance section, none of
 * them identity values.
 */
describe('splitClipsAt — item 7 (G1-G6): the anchor narrows the selection', () => {
  it('1 (G1) the SECOND split narrows to the single middle piece — FAILS TODAY', () => {
    const id = seedOne({ startSample: 6000, offsetSample: 0, lengthSample: 30000 });
    store().setSelectedClip(id);
    const t1 = sessionRef().tracks[0].id;

    const made1 = splitClipsAt([t1], 16000);
    splitClipsAt([t1], 24000);

    const r1 = made1[0]; // the FIRST split's right half is this track's post-2nd-cut middle
    expect(store().selectedClipIds).toEqual([r1]);
    expect(store().selectedClipId).toBe(r1);
    const middle = clipById(r1)!;
    expect(middle.startSample).toBe(16000);
    expect(middle.lengthSample).toBe(8000);
  });

  it('2 (G3) cutting leftwards still selects the span between the two cuts', () => {
    const id = seedOne({ startSample: 6000, offsetSample: 0, lengthSample: 30000 });
    store().setSelectedClip(id);
    const t1 = sessionRef().tracks[0].id;

    splitClipsAt([t1], 16000);
    const made2 = splitClipsAt([t1], 10000); // leftward: before the first cut

    expect(store().selectedClipIds).toEqual([made2[0]]); // the NEW right half, not the original
    const middle = clipById(made2[0])!;
    expect(middle.startSample).toBe(10000);
    expect(middle.lengthSample).toBe(6000);
  });

  it('3 (G1) a third split keeps narrowing to the newest middle', () => {
    const id = seedOne({ startSample: 6000, offsetSample: 0, lengthSample: 30000 });
    store().setSelectedClip(id);
    const t1 = sessionRef().tracks[0].id;

    splitClipsAt([t1], 16000);
    splitClipsAt([t1], 24000);
    splitClipsAt([t1], 20000);

    expect(store().selectedClipIds).toHaveLength(1);
    const middle = clipById(store().selectedClipIds[0])!;
    expect(middle.startSample).toBe(20000);
    expect(middle.lengthSample).toBe(4000);
  });

  it('4 (G4) a track not cut at the previous point keeps its own result, in one undo step', () => {
    const { session, ids } = seed([[6000, 30000]], [[40000, 20000]]);
    const [t1, t2] = session.tracks.map((t) => t.id);
    const [a1] = ids[0];
    const [b1] = ids[1];
    store().setSelectedClips([a1, b1]);

    const made1 = splitClipsAt([t1, t2], 16000); // 16000 is only legal on T1
    expect(made1).toHaveLength(1);
    splitClipsAt([t1, t2], 24000); // still only T1 (T2's clip starts at 40000)

    expect(doneLabels()).toEqual(['Split clip', 'Split clip']); // two SINGLE-target gestures
    expect(store().selectedClipIds).toEqual([b1, made1[0]]);
  });

  it('5 (G4) both tracks cut land two middles', () => {
    const { session, ids } = seed([[6000, 30000]], [[6000, 30000]]);
    const [t1, t2] = session.tracks.map((t) => t.id);
    const [a1] = ids[0];
    const [b1] = ids[1];
    store().setSelectedClips([a1, b1]);

    splitClipsAt([t1, t2], 16000);
    splitClipsAt([t1, t2], 24000);

    expect(store().selectedClipIds).toHaveLength(2);
    const spans = store()
      .selectedClipIds.map((id) => clipById(id)!)
      .map((c) => ({ start: c.startSample, end: c.startSample + c.lengthSample }));
    expect(spans).toEqual([
      { start: 16000, end: 24000 },
      { start: 16000, end: 24000 },
    ]);
  });

  it('6 (G6) an unrelated click resets the anchor', () => {
    const id = seedOne({ startSample: 6000, offsetSample: 0, lengthSample: 30000 });
    store().setSelectedClip(id);
    const t1 = sessionRef().tracks[0].id;

    splitClipsAt([t1], 16000);
    store().setSelectedClip(id); // an unrelated selection act (a click)
    splitClipsAt([t1], 24000);

    // The legacy arm wrote nothing: the second cut's target (the piece cut
    // at 16000) was not a selection member, so nothing joined it.
    expect(store().selectedClipIds).toEqual([id]);
    expect(trackClips(0)).toHaveLength(3);
  });

  it('7 (G6) undo resets the anchor', () => {
    const id = seedOne({ startSample: 6000, offsetSample: 0, lengthSample: 30000 });
    store().setSelectedClip(id);
    const t1 = sessionRef().tracks[0].id;

    splitClipsAt([t1], 16000);
    splitClipsAt([t1], 24000);
    expect(store().lastSplit).not.toBeNull();

    undoSession();

    expect(store().lastSplit).toBeNull();
  });

  // 8 (G2) — the first split is unchanged: pinned by the pre-existing '1j'
  // tests in the `splitClipsAt` describe block above ('adds the right halves
  // of SELECTION MEMBERS only...' and 'splits an UNSELECTED track-mate...'),
  // which this lot did not modify and which still pass.

  it('a mixed act: one track matches the anchor, a different track is split for the first time', () => {
    // Track A already has a live anchor from a previous split; Track B is cut
    // for the first time in the SAME gesture. A's selection narrows to its
    // middle; B's pre-existing selected clip gains its new right half exactly
    // as a first split would (the legacy arm), and the untouched survivor on
    // a third track keeps its place. Exercises `splitSelectionAfter`'s mixed
    // branch (survivors + a legacy pair + a middle) through the real store:
    // B's own id is produced BOTH as a survivor and by the legacy pair, and
    // `setSelectedClips` de-duplicates it down to one.
    const { session, ids } = seed([[6000, 30000]], [[6000, 40000]], [[100000, 5000]]);
    const [tA, tB] = session.tracks.map((t) => t.id);
    const [a1] = ids[0];
    const [b1] = ids[1];
    const [c1] = ids[2];
    store().setSelectedClips([c1, a1, b1]);

    const made1 = splitClipsAt([tA], 16000); // A only — establishes A's anchor
    const a2 = made1[0]; // A's middle after the next cut
    const madeMixed = splitClipsAt([tA, tB], 24000); // A narrows; B is cut for the first time
    const b2 = madeMixed[1]; // session-track order: A's outcome first, then B's

    expect(store().selectedClipIds).toEqual([c1, b1, b2, a2]);
  });

  it('fix round 1 (CONFIRMED REGRESSION, M2/N4) an unselected track-mate cut twice must not narrow into the selection', () => {
    // One track, two clips: a1 selected, b1 never selected — the exact '1j'
    // shape ("splits an UNSELECTED track-mate but leaves it out of the
    // selection"), now exercised a SECOND time on the unselected clip.
    const { ids } = seed([[6000, 30000], [50000, 30000]]);
    const t1 = sessionRef().tracks[0].id;
    const [a1, b1] = ids[0];
    store().setSelectedClip(a1); // b1 is never selected

    splitClipsAt([t1], 60000); // cuts b1 — the existing 1j pin, restated
    expect(store().selectedClipIds).toEqual([a1]);

    splitClipsAt([t1], 70000); // cuts b1's own right half a SECOND time

    // Must NOT grow: b1's second-cut middle happens to satisfy gate 2's piece
    // identity (it IS a piece of the anchor `lastSplit` just wrote), but it
    // was never a selection member, and gate 2 must refuse it on that alone.
    expect(store().selectedClipIds).toEqual([a1]);
    expect(trackClips(0)).toHaveLength(4); // a1, and b1 split into three pieces
  });

  it('fix round 1 (G4 coverage) drop is scoped to the tracks THIS act narrowed', () => {
    // Two tracks both cut at 16000 (first split, legacy arm on both — T2's
    // clip is deliberately too short to reach 24000). Then ONLY T1 qualifies
    // at 24000: T2's OWN result from the first cut must survive untouched
    // alongside T1's narrowed middle — replacing the track-scoped `drop` with
    // `new Set(anchor.pieceIds)` (every anchor piece, not just the ones on
    // the tracks this act actually narrowed) collapses T2's selection too.
    const { session, ids } = seed([[6000, 30000]], [[6000, 14000]]);
    const [t1, t2] = session.tracks.map((t) => t.id);
    const [a1] = ids[0];
    const [c1] = ids[1];
    store().setSelectedClips([a1, c1]);

    const made1 = splitClipsAt([t1, t2], 16000); // both narrow for the first time
    const [a2, c2] = made1; // track order: t1 then t2

    splitClipsAt([t1, t2], 24000); // legal ONLY on T1 — T2's clip (4000 long) can't reach it

    expect(store().selectedClipIds).toEqual([c1, c2, a2]);
  });

  it('fix round 1 (item 4a) an appended landing invalidates the anchor via gate 1 alone', () => {
    const id = seedOne({ startSample: 6000, offsetSample: 0, lengthSample: 30000 });
    store().setSelectedClip(id);
    const t1 = sessionRef().tracks[0].id;

    splitClipsAt([t1], 16000);
    expect(store().lastSplit).not.toBeNull();

    // An APPENDED landing (E2/E3): a brand-new track carrying a document this
    // session has never seen, landed alongside the existing session.
    const landedTrack = createTrack('Landed Track');
    landedTrack.clips = [
      createClip({ documentId: 'doc-landed', startSample: 0, offsetSample: 0, lengthSample: 5000 }),
    ];
    const plan = planLanding('doc-landed');
    expect(plan.mode).toBe('appended');
    commitLanding(plan, [landedTrack], 'Land test track');

    // `commitLanding`'s own `setSelectedClip` narrows the selection to the
    // landed clip alone — no explicit `lastSplit: null` needed; gate 1 fails
    // on its own the next time a split runs.
    const landedClipId = landedTrack.clips[0].id;
    expect(store().selectedClipIds).toEqual([landedClipId]);

    // A further split at the very sample/piece the (still non-null, unread)
    // anchor names must take the legacy arm — nothing here is a selection
    // member, so nothing joins.
    splitClipsAt([t1], 24000);
    expect(store().selectedClipIds).toEqual([landedClipId]);
  });
});
