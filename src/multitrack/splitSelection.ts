/**
 * Item 7 (G1-G6) - the pure rule behind "cutting a track twice selects only
 * the middle piece". Imports nothing from the store: `splitClipsAt`
 * (`sessionStore.ts`) is a thin shell that gathers the arguments below from
 * the live session and applies whatever this returns.
 *
 * THE FIRST split on a track (no live anchor) reproduces the ORIGINAL N4
 * rule exactly - the "legacy arm" below - because `anchor` starts `null` and
 * every later reset (G6) puts it back there. G1/G3 only take effect once an
 * anchor is standing.
 */

/** `SessionState.lastSplit` (G6) - the previous `splitClipsAt`'s cut point,
 * every piece it made, and the selection it left standing. See the doc
 * comment on `SessionState.lastSplit` in `sessionStore.ts` for the two gates
 * that decide whether it is still "live" for a later split. */
export interface LastSplit {
  sample: number;
  pieceIds: string[];
  selectionAfter: string[];
}

/** One clip a `splitClipsAt` gesture actually cut, in the shape the anchor
 * rule needs: which track, the two halves' ids (`leftId` keeps the original
 * clip's id - `splitClip`'s own contract), the ORIGINAL clip's span (before
 * the cut, so `clipStart`/`clipEnd` are the outer edges both halves partition),
 * and whether the original clip (`leftId`) was already a selection member
 * before this gesture ran. */
export interface SplitOutcome {
  trackId: string;
  leftId: string;
  rightId: string;
  clipStart: number;
  clipEnd: number;
  wasMember: boolean;
}

/**
 * Item 7 - what the clip selection becomes after a `splitClipsAt` gesture.
 * `null` means "no selection write at all" (today's no-op case: nothing in
 * the gesture was a pre-existing selection member).
 *
 * Two arms, chosen ONCE for the whole gesture based on whether ANY outcome
 * matches the anchor (G4's "one undo step" - the choice is per gesture, but
 * each outcome's OWN middle-or-not verdict is still per track):
 *
 *  - LEGACY (G2, and every first split): the additive N4 rule, unchanged -
 *    the right half of every outcome whose original clip (`leftId`) was
 *    already selected joins the standing selection; an outcome whose
 *    original clip was not selected contributes nothing.
 *  - ANCHOR (G1/G3/G4, once a live anchor names at least one of this
 *    gesture's outcomes as its own piece): every track the anchor matched is
 *    narrowed to that track's single middle piece; every track it did not
 *    match (untouched entirely, or split for the first time in the same
 *    gesture) keeps whatever the legacy rule above gives it. The replacement
 *    is per TRACK, the array is a REPLACE for the whole selection.
 */
export function splitSelectionAfter(args: {
  anchor: LastSplit | null;
  selectionBefore: readonly string[];
  outcomes: readonly SplitOutcome[];
  trackOfPiece: (clipId: string) => string | null;
}): string[] | null {
  const { anchor, selectionBefore, outcomes, trackOfPiece } = args;

  // Gate 1 (G6) - the anchor is only worth consulting when nothing has
  // touched the selection since it was written: same length, same order.
  const anchorLive =
    anchor !== null &&
    anchor.selectionAfter.length === selectionBefore.length &&
    anchor.selectionAfter.every((id, i) => id === selectionBefore[i]);

  // Gate 2 (G6) - per outcome: is the clip THIS gesture just split literally
  // a piece the anchor's own cut made, and did the anchor's cut point sit on
  // that clip's own outer edge? `clipStart` -> the anchor cut this clip's
  // LEFT edge last time, so the left half (same span this time) is the
  // middle; `clipEnd` -> the anchor cut its RIGHT edge (G3, cutting
  // leftwards), so the NEW right half is the middle.
  const middleIds: (string | null)[] = outcomes.map((o) => {
    if (!anchorLive || anchor === null || !anchor.pieceIds.includes(o.leftId)) return null;
    if (anchor.sample === o.clipStart) return o.leftId;
    if (anchor.sample === o.clipEnd) return o.rightId;
    return null;
  });

  if (middleIds.every((m) => m === null)) {
    // No outcome matched the anchor (no live anchor at all, or every cut
    // landed somewhere the anchor does not name) - the whole gesture is the
    // legacy arm, byte-for-byte the additive N4 rule.
    const joining = outcomes.filter((o) => o.wasMember).map((o) => o.rightId);
    return joining.length === 0 ? null : [...selectionBefore, ...joining];
  }

  // At least one track narrowed to a middle: replace the WHOLE selection,
  // track by track.
  const anchorTracks = new Set(
    outcomes.filter((_, i) => middleIds[i] !== null).map((o) => o.trackId)
  );
  // anchor cannot be null here: a non-null middleId requires anchorLive,
  // which requires anchor !== null.
  const pieceIds = anchor !== null ? anchor.pieceIds : [];
  const drop = new Set(
    pieceIds.filter((id) => {
      const trackId = trackOfPiece(id);
      return trackId !== null && anchorTracks.has(trackId);
    })
  );
  const survivors = selectionBefore.filter((id) => !drop.has(id));

  const legacyPairs: string[] = [];
  outcomes.forEach((o, i) => {
    if (middleIds[i] === null && o.wasMember) legacyPairs.push(o.leftId, o.rightId);
  });

  const middles = middleIds.filter((m): m is string => m !== null);

  return [...survivors, ...legacyPairs, ...middles];
}
