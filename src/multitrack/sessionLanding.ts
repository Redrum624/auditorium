/**
 * Lot E — the ONE shared decision for "where does a landing go" (item 5,
 * general rule: E1/E2/E3/E4 in `docs/superpowers/plans/2026-09-14-editor-feedback/decisions.md`).
 *
 * Before this module there were THREE copies of "replace the whole session"
 * (`stemLanding.ts`, `coverJourney.ts`, `sessionFile.ts`) and they had already
 * drifted — `mtEnvelope: null` was written by one and missing from the other
 * two, leaving a stale open-envelope target pointing at a session that no
 * longer exists. X2 exists precisely for this: one surface (a session
 * replacement), one rule, one place it is stated.
 *
 * `installSession` is the REPLACE arm, used by every caller that wants a
 * wholesale swap (Open Project, the cover journey, and stem/voice/speaker
 * landing when E3's gate says the open session has no clips at all).
 * `planLanding` + `commitLanding` are the pair that let stem/voice/speaker
 * landing avoid replacing a session that already has clips: E1 puts the
 * separated tracks IN PLACE of the source track when it finds one, E2/E3
 * append them otherwise.
 */
import { locate } from '../services/coverPlacement';
import { useAppStore } from '../stores/appStore';
import { hasAnyClip, useSessionStore } from './sessionStore';
import { clearSessionHistory, withSessionGesture } from './sessionUndo';
import { defaultSessionZoom } from './sessionZoom';
import type { Session, Track } from './session';

export type LandingMode = 'replaced' | 'in-place' | 'appended';

export interface LandingPlan {
  mode: LandingMode;
  /** Session-sample start every landed clip is built at. 0 except `'in-place'`,
   * where it is the displaced anchor clip's own `startSample` (E4). */
  startSample: number;
  /** Where `commitLanding` splices the landed tracks in, in the track array
   * AFTER the displaced tracks have been removed. `null` = append at the end
   * (E2/E3's arm; `'replaced'` never reads this). */
  insertIndex: number | null;
  /** Every clip carrying the source document — not just the anchor (E1's
   * refinement: a leftover occurrence would put the source on the bus beside
   * its own separation). */
  displacedClipIds: string[];
  /** Tracks left with ZERO clips once `displacedClipIds` are gone — never the
   * literal "the track that carried the anchor", because a track carrying
   * other clips too must survive (E1's refinement). */
  displacedTrackIds: string[];
  /** The anchor clip's own window, verbatim — E6's in-place arm inherits
   * `offsetSample`/`lengthSample` rather than recomputing them, because they
   * are already correct at whatever rate the anchor was placed at. */
  window: { offsetSample: number; lengthSample: number; gainDb: number } | null;
  /** The anchor track's mix params, carried onto every landed track so E1's
   * "just splitted" reads as the same mix, not a reset one. */
  trackParams: Pick<Track, 'volumeDb' | 'pan' | 'muted' | 'automation'> | null;
  /** E6 — true when the source document's rate differs from the OPEN
   * session's rate. The session rate itself never moves (`adoptSessionRate`
   * already refuses on a non-empty session) — this only reports that a landed
   * clip's `lengthSample` required the doc-rate/session-rate conversion. */
  rateConverted: boolean;
}

/**
 * The REPLACE arm: swap `session` in wholesale, following the load-shaped
 * apply block every wholesale replacement in this app now shares (Open
 * Project, a stem/voice/speaker landing with no clips open, a cover journey).
 * Every transient (selection, cursor, zoom, transport, the open envelope
 * lane) belonged to the session that just went away.
 *
 * `projectPath` is the caller's to decide: `null` for every load-SHAPED
 * replacement that is not literally opening a `.audm` (a landing, a cover
 * session), the opened file's own path for `loadProjectFrom`.
 */
export function installSession(session: Session, projectPath: string | null): void {
  useSessionStore.setState({
    session,
    selectedClipId: null,
    mtCursorSample: 0,
    // MT1 (C1): fitted, not a hardcoded samples/px — see sessionZoom's own
    // ruling. A landing or a project load is how a user most often arrives at
    // a long multitrack session.
    mtZoom: defaultSessionZoom(session),
    mtPlayState: 'stopped',
    mtPlayheadSample: 0,
    // F0: a stale open-envelope target must not outlive the session it was
    // pointed at — the drift `sessionFile.ts` alone used to guard against.
    mtEnvelope: null,
    projectPath,
  });
  // R3: every wholesale replacement is a LOAD-shaped one — it starts a new
  // editing timeline, so the previous session's undo history is dropped
  // rather than recorded. Entries are whole-state snapshots, so leaving the
  // stack standing would let an undo of a pre-replacement entry silently
  // revert this replacement (the recording invariant in sessionUndo.ts).
  clearSessionHistory();
  useAppStore.getState().setView('multitrack');
}

/**
 * The one decision every stem/voice/speaker landing now asks before it builds
 * a single track: does the open session get REPLACED, does the new material
 * go IN PLACE of the source document's own clip(s), or does it get APPENDED
 * alongside whatever is already there?
 *
 * The gate is E3's, restated by amendment E2-a: "the session already has
 * CLIPS" (`hasAnyClip`), never "has tracks" — `newSession` mints four empty
 * tracks, so a literal "has tracks" test is always true and would defeat the
 * rule outright.
 */
export function planLanding(sourceDocId: string, docRate: number): LandingPlan {
  const session = useSessionStore.getState().session;
  const rateConverted = docRate !== session.sampleRate;
  const empty = {
    startSample: 0,
    insertIndex: null,
    displacedClipIds: [] as string[],
    displacedTrackIds: [] as string[],
    window: null,
    trackParams: null,
    rateConverted,
  };

  if (!hasAnyClip(session)) return { mode: 'replaced', ...empty };

  const located = locate(session.tracks, sourceDocId);
  if (!located) return { mode: 'appended', ...empty };

  // E1's refinement: EVERY clip carrying this document, not just the anchor —
  // and a track loses its place in the session only when the removal leaves
  // it with zero clips.
  const displacedClipIds: string[] = [];
  const displacedTrackIds: string[] = [];
  for (const track of session.tracks) {
    const matching = track.clips.filter((c) => c.documentId === sourceDocId);
    if (matching.length === 0) continue;
    for (const c of matching) displacedClipIds.push(c.id);
    if (matching.length === track.clips.length) displacedTrackIds.push(track.id);
  }

  // The insert index is stated against the track array AFTER the displaced
  // tracks are gone (that is what `commitLanding` actually splices into), so
  // it is the anchor's original index minus however many displaced tracks sit
  // ahead of it.
  const anchorIndex = session.tracks.findIndex((t) => t.id === located.track.id);
  const removedBeforeAnchor = displacedTrackIds.filter(
    (id) => session.tracks.findIndex((t) => t.id === id) < anchorIndex
  ).length;

  return {
    mode: 'in-place',
    startSample: located.clip.startSample,
    insertIndex: anchorIndex - removedBeforeAnchor,
    displacedClipIds,
    displacedTrackIds,
    window: {
      offsetSample: located.clip.offsetSample,
      lengthSample: located.clip.lengthSample,
      gainDb: located.clip.gainDb,
    },
    trackParams: {
      volumeDb: located.track.volumeDb,
      pan: located.track.pan,
      muted: located.track.muted,
      automation: located.track.automation,
    },
    rateConverted,
  };
}

/**
 * The IN-PLACE/APPENDED arm's write: one undo gesture that removes whatever
 * `planLanding` marked displaced, splices `tracks` in at `plan.insertIndex`
 * (or the end), and selects the first landed clip. Never called for
 * `'replaced'` — that arm is `installSession`.
 *
 * Deliberately does NOT call `clearSessionHistory()` and does NOT write
 * `projectPath: null` / `mtZoom` / `mtCursorSample` / `mtPlayheadSample` /
 * `mtPlayState` — the open `.audm` (if any) is still where these tracks live,
 * and the rest of the session's undo stack is the user's own work
 * (`coverJourney.test.ts`'s cancelled-run case is what clearing here would
 * have silently reverted).
 */
export function commitLanding(plan: LandingPlan, tracks: readonly Track[], gestureLabel: string): void {
  withSessionGesture(gestureLabel, () => {
    const store = useSessionStore.getState();
    for (const clipId of plan.displacedClipIds) store.removeClip(clipId);
    for (const trackId of plan.displacedTrackIds) store.removeTrack(trackId);
    store.insertTracks(tracks, plan.insertIndex ?? undefined);
    const firstLandedClipId = tracks[0]?.clips[0]?.id ?? null;
    store.setSelectedClip(firstLandedClipId);
  });
  useAppStore.getState().setView('multitrack');
}
