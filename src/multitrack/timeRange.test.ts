/**
 * Lot J (item 10) — the pure time-range classification and band arithmetic,
 * no store, no React. Shared fixture (X3 — non-identity throughout): session
 * rate 48 000 (never the 44 100 default); `T1` = `c1 {start: 20_000,
 * len: 30_000, offsetSample: 5_000}`; `T2` = `c2 {start: 60_000, len:
 * 40_000}`, `c3 {start: 120_000, len: 25_000}`; `T3` = `c4 {start: 10_000,
 * len: 200_000}`. Range `R = {startSample: 40_000, endSample: 130_000}`. No
 * clip starts at 0; no asserted offset starts at 0.
 */
import { MIN_CLIP_SAMPLES, createClip, createTrack, type Session } from './session';
import { orderTimeRange, rangeBandPx, silenceTargets, trimTargets, type TimeRange } from './timeRange';

const R: TimeRange = { startSample: 40_000, endSample: 130_000 };

function fixtureSession(): { session: Session; c1: string; c2: string; c3: string; c4: string } {
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
  return { session, c1: c1.id, c2: c2.id, c3: c3.id, c4: c4.id };
}

/** A single track carrying exactly the clips given, for the isolated J8/edge
 * cases the shared fixture does not need to be dragged into. */
function soloTrack(clips: { startSample: number; lengthSample: number }[]): { session: Session; ids: string[] } {
  const track = createTrack('Solo');
  const made = clips.map((c) =>
    createClip({ documentId: 'doc-1', startSample: c.startSample, offsetSample: 0, lengthSample: c.lengthSample })
  );
  track.clips = made;
  return { session: { name: 'Solo Fixture', sampleRate: 48_000, tracks: [track] }, ids: made.map((c) => c.id) };
}

describe('MIN_CLIP_SAMPLES', () => {
  it('is 32', () => {
    expect(MIN_CLIP_SAMPLES).toBe(32);
  });
});

describe('orderTimeRange', () => {
  it('orders a reversed pair', () => {
    expect(orderTimeRange(130_000, 40_000)).toEqual({ startSample: 40_000, endSample: 130_000 });
  });

  it('clamps a negative sample to 0, independently of the other end', () => {
    expect(orderTimeRange(-900, 40_000)).toEqual({ startSample: 0, endSample: 40_000 });
  });

  it('collapses to null when both ends round to the same sample', () => {
    expect(orderTimeRange(70_000, 70_000)).toBeNull();
  });

  it('rounds each end independently before ordering', () => {
    expect(orderTimeRange(40_000.4, 129_999.6)).toEqual({ startSample: 40_000, endSample: 130_000 });
  });
});

describe('trimTargets (J1/J2)', () => {
  it('trims c1/c3/c4 to the range edges they cross and skips c2 (wholly inside)', () => {
    const { session, c1, c2, c3, c4 } = fixtureSession();
    const allTrackIds = session.tracks.map((t) => t.id);
    const targets = trimTargets(session, allTrackIds, R);
    expect(targets).toEqual([
      { kind: 'trim', clipId: c1, startTo: 40_000 },
      { kind: 'trim', clipId: c3, endTo: 130_000 },
      { kind: 'trim', clipId: c4, startTo: 40_000, endTo: 130_000 },
    ]);
    expect(targets.some((t) => t.clipId === c2)).toBe(false);
  });

  it('removes a clip entirely to the right of the range', () => {
    const { session, ids } = soloTrack([{ startSample: 200_000, lengthSample: 9_000 }]);
    const targets = trimTargets(session, [session.tracks[0].id], R);
    expect(targets).toEqual([{ kind: 'remove', clipId: ids[0] }]);
  });

  describe('J8 — the 32-sample floor, from both sides', () => {
    it('a 20-sample intersection (under the floor) is removed, not trimmed', () => {
      const { session, ids } = soloTrack([{ startSample: 129_980, lengthSample: 60_000 }]);
      const targets = trimTargets(session, [session.tracks[0].id], R);
      expect(targets).toEqual([{ kind: 'remove', clipId: ids[0] }]);
    });

    it('a 50-sample intersection (over the floor) is trimmed to the boundary', () => {
      const { session, ids } = soloTrack([{ startSample: 129_950, lengthSample: 60_000 }]);
      const targets = trimTargets(session, [session.tracks[0].id], R);
      expect(targets).toEqual([{ kind: 'trim', clipId: ids[0], endTo: 130_000 }]);
    });
  });
});

describe('silenceTargets (J4)', () => {
  it('trims the two boundary crossers, removes the wholly-inside clip, and splits the spanning one', () => {
    const { session, c1, c2, c3, c4 } = fixtureSession();
    const allTrackIds = session.tracks.map((t) => t.id);
    const targets = silenceTargets(session, allTrackIds, R);
    expect(targets).toEqual([
      { kind: 'trim', clipId: c1, endTo: 40_000 },
      { kind: 'remove', clipId: c2 },
      { kind: 'trim', clipId: c3, startTo: 130_000 },
      { kind: 'split', clipId: c4, atSample: 40_000, rightStartTo: 130_000 },
    ]);
  });

  it('omits a spanning clip whose split point falls inside an overlap with a track-mate', () => {
    const { session, ids } = soloTrack([
      { startSample: 10_000, lengthSample: 200_000 }, // spans R, same as c4
      { startSample: 35_000, lengthSample: 20_000 }, // [35_000, 55_000): straddles R.startSample (40_000)
    ]);
    const [spanningId, mateId] = ids;
    const targets = silenceTargets(session, [session.tracks[0].id], R);
    // The spanning clip's cut point (40_000) sits inside its raw overlap with
    // the mate ([35_000, 55_000)), so `isLegalSplitPoint` refuses it and the
    // action is OMITTED — the row would grey for exactly this, matching
    // `splitTargets`'s own precedent. The mate itself DOES overlap R (it
    // crosses the left boundary only, [35_000, 40_000) survives at 5_000
    // samples — over the floor) and gets its own ordinary trim; asserted
    // explicitly so this test cannot pass merely because everything vanished.
    expect(targets).toEqual([{ kind: 'trim', clipId: mateId, endTo: 40_000 }]);
    expect(targets.some((t) => t.clipId === spanningId)).toBe(false);
  });

  describe('J8 on the spanning case — a remaining side under the floor degrades to a plain trim', () => {
    it('a 31-sample right remainder is dropped: the whole clip trims to the left piece only', () => {
      // Spans R barely past the end: range.endSample(130_000) + 31 = 130_031.
      const { session, ids } = soloTrack([{ startSample: 10_000, lengthSample: 120_031 }]); // end 130_031
      const targets = silenceTargets(session, [session.tracks[0].id], R);
      expect(targets).toEqual([{ kind: 'trim', clipId: ids[0], endTo: 40_000 }]);
    });

    it('a 32-sample right remainder is kept: a real split', () => {
      const { session, ids } = soloTrack([{ startSample: 10_000, lengthSample: 120_032 }]); // end 130_032
      const targets = silenceTargets(session, [session.tracks[0].id], R);
      expect(targets).toEqual([{ kind: 'split', clipId: ids[0], atSample: 40_000, rightStartTo: 130_000 }]);
    });
  });
});

describe('rangeBandPx', () => {
  it('converts both edges through the zoom and clamps to the lane width', () => {
    expect(rangeBandPx(R, { samplesPerPixel: 500, scrollSample: 20_000 }, 300)).toEqual({
      leftPx: 40,
      widthPx: 180,
    });
  });

  it('is null once the range scrolls entirely out of view', () => {
    expect(rangeBandPx(R, { samplesPerPixel: 500, scrollSample: 200_000 }, 300)).toBeNull();
  });

  it('clamps leftPx to 0 for a range starting left of the viewport, keeping a positive width', () => {
    const band = rangeBandPx({ startSample: 0, endSample: 40_000 }, { samplesPerPixel: 500, scrollSample: 20_000 }, 300);
    expect(band).not.toBeNull();
    expect(band!.leftPx).toBe(0);
    expect(band!.widthPx).toBeGreaterThan(0);
  });

  it('is null for a null range', () => {
    expect(rangeBandPx(null, { samplesPerPixel: 500, scrollSample: 0 }, 300)).toBeNull();
  });
});
