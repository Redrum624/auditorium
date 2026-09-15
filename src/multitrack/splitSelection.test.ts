import { splitSelectionAfter, type LastSplit, type SplitOutcome } from './splitSelection';

/**
 * Item 7 (G1-G6) — the pure rule behind `splitClipsAt`'s selection narrowing.
 * X3: every id/sample below is a non-identity value (real-looking clip ids,
 * non-zero non-round samples), never `0`/`'id'`/a single-character stub.
 */

const trackOf = (map: Record<string, string>) => (id: string): string | null => map[id] ?? null;

describe('splitSelectionAfter', () => {
  it('an anchor at the clip\'s startSample keeps the LEFT id as the middle', () => {
    const outcome: SplitOutcome = {
      trackId: 'track-4',
      leftId: 'clip-701',
      rightId: 'clip-703',
      clipStart: 16000,
      clipEnd: 36000,
      wasMember: true,
    };
    const anchor: LastSplit = {
      sample: 16000,
      pieceIds: ['clip-701', 'clip-703'],
      selectionAfter: ['clip-701', 'clip-703'],
    };

    const result = splitSelectionAfter({
      anchor,
      selectionBefore: ['clip-701', 'clip-703'],
      outcomes: [outcome],
      trackOfPiece: trackOf({ 'clip-701': 'track-4', 'clip-703': 'track-4' }),
    });

    expect(result).toEqual(['clip-701']);
  });

  it('an anchor at the clip\'s clipEnd keeps the RIGHT id as the middle (G3, cutting leftwards)', () => {
    const outcome: SplitOutcome = {
      trackId: 'track-4',
      leftId: 'clip-808',
      rightId: 'clip-811',
      clipStart: 20000,
      clipEnd: 24000,
      wasMember: true,
    };
    const anchor: LastSplit = {
      sample: 24000,
      pieceIds: ['clip-808'],
      selectionAfter: ['clip-808'],
    };

    const result = splitSelectionAfter({
      anchor,
      selectionBefore: ['clip-808'],
      outcomes: [outcome],
      trackOfPiece: trackOf({ 'clip-808': 'track-4' }),
    });

    expect(result).toEqual(['clip-811']);
  });

  it('a mismatched selectionAfter (an intervening selection act) falls back to the legacy array', () => {
    const outcome: SplitOutcome = {
      trackId: 'track-4',
      leftId: 'clip-920',
      rightId: 'clip-921',
      clipStart: 5000,
      clipEnd: 9000,
      wasMember: true,
    };
    const anchor: LastSplit = {
      sample: 5000,
      pieceIds: ['clip-920'],
      selectionAfter: ['clip-999'], // a click landed since — not equal to selectionBefore
    };

    const result = splitSelectionAfter({
      anchor,
      selectionBefore: ['clip-920'],
      outcomes: [outcome],
      trackOfPiece: trackOf({ 'clip-920': 'track-4' }),
    });

    expect(result).toEqual(['clip-920', 'clip-921']);
  });

  it('a leftId absent from pieceIds (this clip is not one the anchor cut) falls back to the legacy array', () => {
    const outcome: SplitOutcome = {
      trackId: 'track-4',
      leftId: 'clip-1030',
      rightId: 'clip-1031',
      clipStart: 7000,
      clipEnd: 12000,
      wasMember: true,
    };
    const anchor: LastSplit = {
      sample: 7000,
      pieceIds: ['clip-9999'], // not this clip's id
      selectionAfter: ['clip-1030'], // gate 1 holds...
    };

    const result = splitSelectionAfter({
      anchor,
      selectionBefore: ['clip-1030'], // ...selectionBefore matches, so gate 1 alone is not enough
      outcomes: [outcome],
      trackOfPiece: trackOf({ 'clip-1030': 'track-4' }),
    });

    expect(result).toEqual(['clip-1030', 'clip-1031']);
  });

  it('an empty legacy joining (nothing cut was already selected) returns null — no selection write at all', () => {
    const outcome: SplitOutcome = {
      trackId: 'track-4',
      leftId: 'clip-1140',
      rightId: 'clip-1141',
      clipStart: 8000,
      clipEnd: 15000,
      wasMember: false,
    };

    const result = splitSelectionAfter({
      anchor: null,
      selectionBefore: ['clip-2200'], // selected, but on a track this gesture never touched
      outcomes: [outcome],
      trackOfPiece: trackOf({ 'clip-1140': 'track-4' }),
    });

    expect(result).toBeNull();
  });

  it('the returned order puts survivors, then legacy pairs, then middles last', () => {
    // Track A has a live anchor and narrows to a middle; Track B is split for
    // the first time in the SAME act (a legacy pair); Track C is untouched
    // and merely survives. B's own left id necessarily appears in BOTH
    // survivors and the legacy pair — `setSelectedClips` (the real caller)
    // de-duplicates, which is why the pure rule does not have to.
    const outcomeA: SplitOutcome = {
      trackId: 'track-A',
      leftId: 'clip-50',
      rightId: 'clip-52',
      clipStart: 16000,
      clipEnd: 24000,
      wasMember: true,
    };
    const outcomeB: SplitOutcome = {
      trackId: 'track-B',
      leftId: 'clip-60',
      rightId: 'clip-61',
      clipStart: 9000,
      clipEnd: 14000,
      wasMember: true,
    };
    const anchor: LastSplit = {
      sample: 16000,
      pieceIds: ['clip-50', 'clip-52'],
      selectionAfter: ['clip-70', 'clip-50', 'clip-60'],
    };

    const result = splitSelectionAfter({
      anchor,
      selectionBefore: ['clip-70', 'clip-50', 'clip-60'],
      outcomes: [outcomeA, outcomeB],
      trackOfPiece: trackOf({
        'clip-50': 'track-A',
        'clip-52': 'track-A',
        'clip-60': 'track-B',
        'clip-70': 'track-C',
      }),
    });

    expect(result).toEqual(['clip-70', 'clip-60', 'clip-60', 'clip-61', 'clip-50']);
  });
});
