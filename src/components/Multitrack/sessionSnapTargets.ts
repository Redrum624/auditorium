/**
 * Task B4 — WHAT a dragged clip's magnet snaps to, in SESSION samples.
 * Task W2 — clip EDGES join the set, and the set gains PRIORITY TIERS.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DRAGGED CLIP — AND EVERY CO-MOVING GROUP MEMBER — IS EXCLUDED
 * (trap 27, extended by W2)
 * ---------------------------------------------------------------------------
 * A clip carries its beat grid with it: every one of its own tics sits at a
 * fixed offset from its own start, so "snap the clip's start to one of the
 * clip's own tics" is satisfied at *every* position and moves nothing. Its own
 * EDGES are worse than a no-op: its start IS the position being dragged, so
 * they would pin the drag wherever it began. The target set is therefore the
 * SESSION's: the other clips' edges, mapped grids and source markers, and the
 * multitrack cursor.
 *
 * W2 extends the exclusion to every member of a group drag, for the reason the
 * T5 I1 overlap-hint fix recorded: targets are captured at pointerdown and the
 * group moves RIGIDLY, so a co-moving member's captured positions describe
 * where it is about to not be — snapping the grabbed clip to a sibling's stale
 * edge aligns it to nothing. Excluding only the member's edges would not even
 * achieve that much: a clip's first beat usually coincides with its start, so
 * its stale grid would re-offer the very position its excluded edge withheld.
 * The exclusion is therefore the member's WHOLE contribution.
 *
 * ---------------------------------------------------------------------------
 * CLIP EDGES ARE TARGETS (W2) — superseding the note that excluded them
 * ---------------------------------------------------------------------------
 * Until W2 this header deliberately excluded clip edges: "v1.9 task X5 is
 * about to make same-track clip boundaries first-class *crossfade joins*.
 * Snapping to a boundary that is about to change meaning belongs to that
 * feature, not to this one. Note that a clip's first beat usually coincides
 * with its start anyway (`offsetSample` 0), so head-to-head alignment mostly
 * works already, via the grid." Both halves of that reasoning have expired:
 *
 *  - X5 SHIPPED and settled the boundary's meaning, and it settled it in edge
 *    snapping's favour: a crossfade arms only on a STRICT overlap
 *    (`crossfadableOverlap` rule 1 answers `null` when `b.startSample >=
 *    aEnd`), so an exact butt join — end == start, the position edge snapping
 *    produces — is zero overlap and NO crossfade. Edge snapping therefore
 *    PREVENTS the accidental micro-overlap crossfades the old note feared; it
 *    is how a clean butt join is made on purpose. KNOWN_LIMITATIONS item 4
 *    recorded the exclusion as "sequenced, not dropped" for exactly this day.
 *  - The grid mitigation covers the HEAD of an ANALYSED clip only: never a
 *    tail, never an un-analysed clip. The session that motivated W2 (hand-
 *    aligning an original mix to an instrumental's start) is the uncovered
 *    case.
 *
 * Edges are also the one contribution that needs NO source rate: `startSample`
 * and `lengthSample` are session-sample facts of the clip itself, so a clip
 * that has outlived its closed document still offers its edges — the docRate
 * guard below protects only the beats and markers conversions.
 *
 * ---------------------------------------------------------------------------
 * PRIORITY TIERS (W2) — hard geometry outranks derived geometry
 * ---------------------------------------------------------------------------
 * Tier 0: clip edges + the multitrack cursor — positions the user PLACED.
 * Tier 1: source markers — placed too, but in the source, not the session.
 * Tier 2: beat-grid lines — DERIVED by analysis, and dense enough that a flat
 *         nearest-wins set let them silently beat everything (the H3 hazard).
 * Resolution is `snapSampleTiered`/`snapSpanTiered`'s: nearest within the
 * highest tier holding a candidate. The flat union (`sessionSnapTargets`) is
 * kept for the POINT surfaces — a clip drop or an envelope key has no clip of
 * its own aimed at an edge, so priority buys those gestures nothing.
 *
 * ---------------------------------------------------------------------------
 * F2/F3 — THE CURSOR IS NOT ITS OWN TARGET IN THE GESTURES THAT MOVE IT
 * ---------------------------------------------------------------------------
 * `mtCursorSample` is included in tier 0 by default (`{ includeCursor: true }`)
 * for every gesture that aims AT the bar — a clip drop, an envelope key drag —
 * exactly as `excludeClipIds` withholds a dragged clip's own edges from
 * itself. But the multitrack ruler seek and the cursor handle drag both MOVE
 * the bar, and the bar's own current position was a live snap target for both:
 * a small deliberate move near "where it already is" got pulled straight back
 * to it, which is precisely the literal reading of the user's complaint ("near
 * its last position"). That is the same trap-27 shape the header above
 * describes for a dragged clip — "the dragged thing is never its own target" —
 * applied to the cursor instead of a clip. `mtSnapTargets`
 * (`MultitrackView.tsx`) is therefore the one caller that passes
 * `{ includeCursor: false }`, which covers both bar-moving gestures at once
 * (the ruler prop and the handle capture share that one function).
 *
 * This overturns the note this header used to carry: "for the ruler the
 * cursor is its own old position, which a dominant tier would turn into a
 * sticky trap." That sentence removed the tier *dominance* (kept the ruler on
 * the flat union) but left the cursor *in* the target set, so the trap
 * survived in a milder form — a flat-union near-miss instead of a
 * tier-guaranteed one. `includeCursor: false` removes the target itself.
 *
 * ---------------------------------------------------------------------------
 * THE MAPPING
 * ---------------------------------------------------------------------------
 * Plan ruling 1, the same conversion B3 draws the tics with — `mapBeatsToClip`
 * is reused verbatim for beats so the magnet can never disagree with the tic it
 * is pulling towards, and `mapClipSourceSample` below applies the identical
 * arithmetic to a marker.
 */
import type { AudioDocument } from '../../audio/AudioDocument';
import type { Clip } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
import { getBeatGrid, type BeatGrid } from '../../services/beatGrid';
import { mergeTargets } from '../../services/snap';
import { isSnapEnabled } from '../../services/snapPreference';
import { useAppStore } from '../../stores/appStore';
import { mapBeatsToClip, type ClipSpan } from './clipBeatTics';

/** Tier indices of the session magnet's target set — see the header. */
export const SNAP_TIER_EDGE = 0; // clip edges + the multitrack cursor
export const SNAP_TIER_MARKER = 1; // source markers, mapped
export const SNAP_TIER_BEAT = 2; // beat-grid lines, mapped

/** The session's targets in priority order, each ascending and duplicate-free,
 * indexable by the SNAP_TIER_* constants above. */
export type SessionSnapTiers = [number[], number[], number[]];

/** Source samples spanned by `lengthSample` session samples — `readClipSlice`'s
 * own conversion, kept identical on purpose (the exported statement is
 * `clipSourceWindow` in `multitrack/session`; `clipBeatTics` has its own copy). */
function docSpan(lengthSample: number, docRate: number, sessionRate: number): number {
  return docRate === sessionRate ? lengthSample : Math.round((lengthSample * docRate) / sessionRate);
}

/**
 * Where a SOURCE-document sample is heard on the SESSION timeline for `clip`,
 * or `null` when it falls outside the clip's half-open source window
 * `[offsetSample, offsetSample + span)` — exactly the window `readClipSlice`
 * reads, so a position at the far edge belongs to whatever clip follows rather
 * than being drawn twice at a seam.
 *
 * Never invents a rate: a missing or non-positive rate on either side yields
 * `null` rather than a guessed conversion.
 */
export function mapClipSourceSample(
  sourceSample: number,
  clip: ClipSpan,
  docRate: number,
  sessionRate: number
): number | null {
  if (!Number.isFinite(sourceSample)) return null;
  if (!Number.isFinite(docRate) || docRate <= 0) return null;
  if (!Number.isFinite(sessionRate) || sessionRate <= 0) return null;

  const docStart = clip.offsetSample;
  const docEnd = docStart + docSpan(clip.lengthSample, docRate, sessionRate);
  if (sourceSample < docStart || sourceSample >= docEnd) return null;

  return docRate === sessionRate
    ? clip.startSample + (sourceSample - docStart)
    : clip.startSample + Math.round(((sourceSample - docStart) * sessionRate) / docRate);
}

/** One clip's contribution to the session target set, already resolved from the
 * stores so the builder below stays pure. */
export interface ClipSnapSource {
  clipId: string;
  clip: ClipSpan;
  /** The source document's sample rate, or `null` when the clip has outlived
   * its source (a clip legitimately keeps a closed document's id). */
  docRate: number | null;
  grid: BeatGrid | null;
  /** The source document's marker positions, in SOURCE samples. */
  markers: readonly number[];
}

/**
 * The pure half: the session's targets as priority tiers, each ascending and
 * duplicate-free.
 *
 * @param excludeClipIds the dragged clip AND every co-moving member of its
 *   group — see the trap-27 note above. Their whole contribution is withheld.
 * @param extra positions already in session samples (the multitrack cursor) —
 *   tier 0, beside the edges: the cursor is parked geometry, not derived.
 */
export function buildSessionSnapTiers(
  sources: readonly ClipSnapSource[],
  sessionRate: number,
  excludeClipIds: readonly string[],
  extra: ArrayLike<number> = []
): SessionSnapTiers {
  const excluded = new Set(excludeClipIds);
  const edgeLists: ArrayLike<number>[] = [extra];
  const markerLists: number[][] = [];
  const beatLists: ArrayLike<number>[] = [];

  for (const s of sources) {
    if (excluded.has(s.clipId)) continue;

    // Edges first: the one contribution that needs no rate (see the header).
    edgeLists.push([s.clip.startSample, s.clip.startSample + s.clip.lengthSample]);

    const docRate = s.docRate;
    if (docRate === null) continue; // no rate, no conversion, no guess

    if (s.grid && s.grid.sampleRate === docRate) {
      // Reused verbatim from B3 so the magnet and the drawn tic are the same
      // position by construction. `beatSamples` is only indexed in there.
      beatLists.push(mapBeatsToClip(s.grid, s.clip, docRate, sessionRate).beats);
    }

    if (s.markers.length > 0) {
      const mapped: number[] = [];
      for (const m of s.markers) {
        const pos = mapClipSourceSample(m, s.clip, docRate, sessionRate);
        if (pos !== null) mapped.push(pos);
      }
      if (mapped.length > 0) markerLists.push(mapped);
    }
  }

  return [mergeTargets(...edgeLists), mergeTargets(...markerLists), mergeTargets(...beatLists)];
}

/** F2/F3 — see the header note above. `includeCursor` defaults to `true`: the
 * cursor stays a tier-0 target for every gesture EXCEPT the two that move the
 * bar itself, which pass `{ includeCursor: false }`. */
export interface SessionSnapOptions {
  includeCursor?: boolean;
}

/**
 * The session's snap tiers, resolved from the stores. Empty — with no work
 * done at all — whenever the magnet is off.
 *
 * `getBeatGrid` is asked ONCE per distinct source document rather than once per
 * clip: the workflow this feature exists for is five stems of one source, and
 * the analysis cache holds four rows, so repeating the lookup per clip is
 * exactly the pressure B1's inheritance was built to relieve (trap 18).
 *
 * Deliberately a plain function, not a hook — see the note in
 * `editorSnapTargets.ts`. It is called once at pointerdown; the set a drag uses
 * is the set as it stood when the drag began.
 */
export function sessionSnapTiers(
  excludeClipIds: readonly string[],
  opts: SessionSnapOptions = {}
): SessionSnapTiers {
  if (!isSnapEnabled()) return [[], [], []];

  const { session, mtCursorSample } = useSessionStore.getState();
  const { documents, markers } = useAppStore.getState();

  const docsById = new Map<string, AudioDocument>(documents.map((d) => [d.id, d]));
  const gridCache = new Map<string, BeatGrid | null>();
  const gridFor = (docId: string): BeatGrid | null => {
    if (!gridCache.has(docId)) gridCache.set(docId, getBeatGrid(docId));
    return gridCache.get(docId) ?? null;
  };

  const sources: ClipSnapSource[] = [];
  for (const track of session.tracks) {
    for (const clip of track.clips) {
      const doc = docsById.get(clip.documentId);
      sources.push({
        clipId: clip.id,
        clip: clipSpan(clip),
        docRate: doc ? doc.sampleRate : null,
        grid: doc ? gridFor(clip.documentId) : null,
        markers: (markers[clip.documentId] ?? []).map((m) => m.positionSample),
      });
    }
  }

  const extra = opts.includeCursor === false ? [] : [mtCursorSample];
  return buildSessionSnapTiers(sources, session.sampleRate, excludeClipIds, extra);
}

/**
 * The FLAT union of every tier, for the point surfaces (an envelope key's X,
 * the multitrack ruler seek). A dragged key has no clip edge of its own aiming
 * at a target, so priority buys that gesture nothing. The ruler seek is the
 * one caller (via `mtSnapTargets`) that passes `{ includeCursor: false }` —
 * see F2/F3 above. Clip gestures (move, trim, drop) take `sessionSnapTiers`
 * instead.
 */
export function sessionSnapTargets(
  excludeClipId: string | null,
  opts: SessionSnapOptions = {}
): number[] {
  return mergeTargets(...sessionSnapTiers(excludeClipId === null ? [] : [excludeClipId], opts));
}

function clipSpan(clip: Clip): ClipSpan {
  return {
    startSample: clip.startSample,
    offsetSample: clip.offsetSample,
    lengthSample: clip.lengthSample,
  };
}
