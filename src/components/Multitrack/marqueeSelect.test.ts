/**
 * K1/K4/K5/X3 — the marquee's PURE geometry, no DOM and no store.
 *
 * Fixture (X3: no identity values — several tracks, non-zero non-round
 * starts, a span that touches some clips and misses others): three tracks —
 * `A` with `a1 [40 000, 60 000)`, `B` with `b1 [100 000, 130 000)` and
 * `b2 [200 000, 210 000)`, `C` with `c1 [45 000, 60 000)`. No clip starts at
 * 0.
 */
import type { Track } from '../../multitrack/session';
import {
  clipIdsInSpan,
  marqueeExceeded,
  MARQUEE_DRAG_THRESHOLD_PX,
  marqueeModeFor,
  orderedSpan,
  trackIdsInBand,
} from './marqueeSelect';

function track(id: string, clips: Track['clips']): Track {
  return { id, name: id, volumeDb: 0, pan: 0, muted: false, solo: false, armed: false, clips };
}

function clip(id: string, startSample: number, lengthSample: number): Track['clips'][number] {
  return { id, documentId: 'doc-1', startSample, offsetSample: 0, lengthSample, gainDb: 0 };
}

const tracks: Track[] = [
  track('A', [clip('a1', 40_000, 20_000)]),
  track('B', [clip('b1', 100_000, 30_000), clip('b2', 200_000, 10_000)]),
  track('C', [clip('c1', 45_000, 15_000)]),
];

describe('MARQUEE_DRAG_THRESHOLD_PX (X3 — a non-identity constant, pinned from both sides)', () => {
  it('is 4, the same threshold ClipView and EnvelopeLane already use', () => {
    expect(MARQUEE_DRAG_THRESHOLD_PX).toBe(4);
  });

  it('does not exceed just under the threshold on either axis', () => {
    expect(marqueeExceeded(100, 50, 103, 52)).toBe(false);
  });

  it('exceeds just at the threshold on X alone', () => {
    expect(marqueeExceeded(100, 50, 104, 50)).toBe(true);
  });

  it('exceeds on a vertical-only drag — Y alone counts', () => {
    expect(marqueeExceeded(100, 50, 100, 46)).toBe(true);
  });
});

describe('clipIdsInSpan (K4 — any-overlap, half-open at both ends)', () => {
  it('selects a clip the span only partially covers', () => {
    // b1 spans [100 000, 130 000); the span below covers only 95 000..120 000
    // of it — 20 000 of its 30 000 samples — and still counts as a hit.
    expect(clipIdsInSpan(tracks, ['B'], 95_000, 120_000)).toEqual(['b1']);
  });

  it('excludes a span that ends exactly where the clip starts', () => {
    expect(clipIdsInSpan(tracks, ['A'], 10_000, 40_000)).toEqual([]);
  });

  it('excludes a span that starts exactly where the clip ends', () => {
    expect(clipIdsInSpan(tracks, ['A'], 60_000, 90_000)).toEqual([]);
  });

  it('emits reading order: tracks in the order given, clips by ascending start', () => {
    expect(clipIdsInSpan(tracks, ['A', 'B', 'C'], 30_000, 250_000)).toEqual([
      'a1',
      'b1',
      'b2',
      'c1',
    ]);
  });
});

describe('trackIdsInBand (half-open row overlap, reading order preserved)', () => {
  const rows = [
    { id: 'A', top: 0, bottom: 96 },
    { id: 'B', top: 106, bottom: 202 },
    { id: 'C', top: 212, bottom: 308 },
  ];

  it('names every row the band touches, in the order given', () => {
    expect(trackIdsInBand(rows, 150, 220)).toEqual(['B', 'C']);
  });

  it('names nothing for a band wholly inside the inter-row gutter', () => {
    expect(trackIdsInBand(rows, 202, 206)).toEqual([]);
  });
});

describe('orderedSpan', () => {
  it('normalises either drag direction to the same whole-sample span', () => {
    expect(orderedSpan(60_500.4, 40_000.6)).toEqual({ startSample: 40_001, endSample: 60_500 });
  });
});

describe('marqueeModeFor (K5/J7 — Shift tested first, a different-GESTURE rule)', () => {
  it('picks the time-range sweep when Shift is held, even with Ctrl also held', () => {
    expect(marqueeModeFor({ ctrlKey: true, shiftKey: true })).toBe('range');
  });

  it('unions when only Ctrl is held', () => {
    expect(marqueeModeFor({ ctrlKey: true, shiftKey: false })).toBe('add');
  });

  it('replaces with neither modifier', () => {
    expect(marqueeModeFor({ ctrlKey: false, shiftKey: false })).toBe('replace');
  });
});
