import type { Clip, Session } from './session';
import { MIN_CLIP_SAMPLES } from './session';
import { isLegalSplitPoint } from './sessionStore';
import { sampleToPixel } from '../components/Editor/waveformRender';

/**
 * Lot J (item 10) — the multitrack TIME RANGE: one span drawn over every
 * lane, session samples, half-open like every other span in this codebase
 * (`gaps.ts:10-17`). Field names deliberately match `TrackGap`
 * (`gaps.ts:13-17`), NOT the editor's `{start,end}` (`appStore`'s
 * `SelectionRange`): J6 makes these two different coordinate systems that
 * must never be confused, and giving them different field names is what
 * keeps a stray assignment between the two a type error instead of a silent
 * unit mismatch.
 *
 * `startSample < endSample` by construction — `orderTimeRange` is the only
 * production constructor and refuses the equal case.
 */
export interface TimeRange {
  startSample: number;
  endSample: number;
}

/**
 * Normalizes two raw (possibly unordered, possibly fractional) sample
 * positions into a `TimeRange`: each is rounded and floored at 0
 * independently (a session has no fixed END to clamp against —
 * `MultitrackView.tsx`'s own scrollable-extent comment makes the same call
 * for the timeline generally), then ordered. `null` when the two collapse to
 * the same sample — a sweep that never moved is not a range, the same rule
 * `dragToSelection` (`selectionGestures.ts`) applies to the editor's own
 * drag-selection.
 */
export function orderTimeRange(a: number, b: number): TimeRange | null {
  const x = Math.max(0, Math.round(a));
  const y = Math.max(0, Math.round(b));
  if (x === y) return null;
  return x < y ? { startSample: x, endSample: y } : { startSample: y, endSample: x };
}

/** Clips in `startSample` order, via a SORTED COPY — trap T40
 * (`session.ts:107-111`): `trimClip('start')` writes in place with no
 * re-sort, so `Track.clips` cannot be trusted to already be ascending
 * (`sessionStore.ts`'s own `resolveOverlap`/`clipRangeOnTrack` copy-and-sort
 * for the identical reason). Neither this module nor its callers may assume
 * the OUTPUT order says anything about array position either. */
function sortedClips(clips: readonly Clip[]): Clip[] {
  return [...clips].sort((x, y) => x.startSample - y.startSample);
}

export type TrimAction =
  | { kind: 'remove'; clipId: string }
  | { kind: 'trim'; clipId: string; startTo?: number; endTo?: number };

function trimAction(clipId: string, startTo: number | undefined, endTo: number | undefined): TrimAction {
  const action: TrimAction = { kind: 'trim', clipId };
  if (startTo !== undefined) action.startTo = startTo;
  if (endTo !== undefined) action.endTo = endTo;
  return action;
}

/**
 * J1/J2/J8 — what Trim does to every clip on `trackIds`, pure: a clip
 * ENTIRELY outside `range` is removed; one whose intersection with `range` is
 * under `MIN_CLIP_SAMPLES` is removed too (J8 — held-at-the-floor would leave
 * an inaudible sliver hanging past the range edge, breaking J1's "shortened
 * to the boundary"); otherwise the clip is shortened to whichever edge(s) of
 * `range` it crosses, and a clip wholly INSIDE `range` emits NOTHING — J1's
 * "everything kept stays at its session position" means literally untouched,
 * not a no-op trim to its own current edges.
 *
 * Tracks in `session.tracks` order, clips within a track from a sorted copy
 * (T40). `edit.trim`'s multitrack predicate (`menuActions.ts`) is exactly
 * "this returns a non-empty array" — the row greys for precisely the
 * selections/ranges that would change nothing.
 */
export function trimTargets(session: Session, trackIds: readonly string[], range: TimeRange): TrimAction[] {
  const wanted = new Set(trackIds);
  const out: TrimAction[] = [];
  for (const track of session.tracks) {
    if (!wanted.has(track.id)) continue;
    for (const clip of sortedClips(track.clips)) {
      const clipEnd = clip.startSample + clip.lengthSample;
      if (clipEnd <= range.startSample || clip.startSample >= range.endSample) {
        out.push({ kind: 'remove', clipId: clip.id }); // wholly outside (J1)
        continue;
      }
      const overlap = Math.min(clipEnd, range.endSample) - Math.max(clip.startSample, range.startSample);
      if (overlap < MIN_CLIP_SAMPLES) {
        out.push({ kind: 'remove', clipId: clip.id }); // J8
        continue;
      }
      const startTo = clip.startSample < range.startSample ? range.startSample : undefined;
      const endTo = clipEnd > range.endSample ? range.endSample : undefined;
      if (startTo === undefined && endTo === undefined) continue; // wholly inside: untouched
      out.push(trimAction(clip.id, startTo, endTo));
    }
  }
  return out;
}

export type SilenceAction =
  | { kind: 'remove'; clipId: string }
  | { kind: 'trim'; clipId: string; startTo?: number; endTo?: number }
  | { kind: 'split'; clipId: string; atSample: number; rightStartTo: number };

/**
 * J4 — what Silence does to every clip on `trackIds`: clears `range` on those
 * tracks and leaves the hole, exactly like multitrack Delete leaves a gap —
 * nothing moves, the timeline keeps its length. A clip with NO overlap is
 * untouched (nothing emitted, unlike Trim's `remove`: Silence only acts where
 * the swept range actually touches); one wholly INSIDE is removed outright; a
 * boundary crosser is shortened to whichever edge it keeps; a clip spanning
 * the whole range is SPLIT at `range.startSample` and the new right half
 * trimmed back to `range.endSample`, so the middle is a clean hole between
 * two surviving pieces.
 *
 * J8 applies per remaining PIECE, not just per action: a piece under
 * `MIN_CLIP_SAMPLES` is removed rather than kept as an inaudible sliver.
 * Composed onto the spanning case too — if one side's remaining piece would
 * be too small, this degrades to the boundary-crosser trim that keeps only
 * the other (viable) side, and if BOTH sides would be too small the clip is
 * removed outright — never a `split` action with a piece the store would
 * refuse to keep. A `split` whose cut point is illegal
 * (`isLegalSplitPoint` — inside a raw overlap with a track-mate) is OMITTED
 * entirely, the same "grey for what the store would refuse" precedent
 * `splitTargets` sets (`sessionStore.ts`).
 */
export function silenceTargets(
  session: Session,
  trackIds: readonly string[],
  range: TimeRange
): SilenceAction[] {
  const wanted = new Set(trackIds);
  const out: SilenceAction[] = [];
  for (const track of session.tracks) {
    if (!wanted.has(track.id)) continue;
    for (const clip of sortedClips(track.clips)) {
      const clipEnd = clip.startSample + clip.lengthSample;
      if (clipEnd <= range.startSample || clip.startSample >= range.endSample) continue; // no overlap
      const hasLeft = clip.startSample < range.startSample;
      const hasRight = clipEnd > range.endSample;
      if (!hasLeft && !hasRight) {
        out.push({ kind: 'remove', clipId: clip.id }); // wholly inside
        continue;
      }
      const leftLen = hasLeft ? range.startSample - clip.startSample : 0;
      const rightLen = hasRight ? clipEnd - range.endSample : 0;
      const keepLeft = hasLeft && leftLen >= MIN_CLIP_SAMPLES;
      const keepRight = hasRight && rightLen >= MIN_CLIP_SAMPLES;

      if (hasLeft && hasRight) {
        if (keepLeft && keepRight) {
          if (!isLegalSplitPoint(track.clips, clip, range.startSample)) continue; // omitted (N2 precedent)
          out.push({ kind: 'split', clipId: clip.id, atSample: range.startSample, rightStartTo: range.endSample });
        } else if (keepLeft) {
          out.push(trimAction(clip.id, undefined, range.startSample));
        } else if (keepRight) {
          out.push(trimAction(clip.id, range.endSample, undefined));
        } else {
          out.push({ kind: 'remove', clipId: clip.id }); // both sides sub-floor
        }
        continue;
      }
      if (hasLeft) {
        out.push(keepLeft ? trimAction(clip.id, undefined, range.startSample) : { kind: 'remove', clipId: clip.id });
        continue;
      }
      out.push(keepRight ? trimAction(clip.id, range.endSample, undefined) : { kind: 'remove', clipId: clip.id });
    }
  }
  return out;
}

/**
 * The range's on-screen band, in LANE pixels (the caller adds `HEADER_W`
 * once, mirroring `MultitrackView.tsx`'s own `cursorX` — no fifth copy of
 * the 224). Both edges through `sampleToPixel`, the one conversion every
 * surface on this screen shares, then clamped to `[0, laneWidth]`; `null`
 * when the clamped span has no width left to paint (the range is entirely
 * off-screen on one side).
 */
export function rangeBandPx(
  range: TimeRange | null,
  zoom: { samplesPerPixel: number; scrollSample: number },
  laneWidth: number
): { leftPx: number; widthPx: number } | null {
  if (range === null) return null;
  const rawLeft = sampleToPixel(range.startSample, zoom.scrollSample, zoom.samplesPerPixel);
  const rawRight = sampleToPixel(range.endSample, zoom.scrollSample, zoom.samplesPerPixel);
  const leftPx = Math.max(0, Math.min(rawLeft, laneWidth));
  const rightPx = Math.max(0, Math.min(rawRight, laneWidth));
  const widthPx = rightPx - leftPx;
  return widthPx <= 0 ? null : { leftPx, widthPx };
}
