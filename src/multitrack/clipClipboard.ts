// Lot L (items 11/12) — Copy and Paste for multitrack CLIPS. The verbs, not
// the slot: `services/clipboard.ts` owns the clip clipboard's storage and its
// mutual exclusion with the audio clipboard (L4a); this module owns what a
// Copy captures, what a Paste computes, and why a Paste is refused.
import type { AudioDocument } from '../audio/AudioDocument';
import { clampFadePair, createClip, type Clip, type Session } from './session';
import { warmClipResample } from './mixdown';
import { useSessionStore } from './sessionStore';
import { withSessionGesture } from './sessionUndo';
import { useAppStore } from '../stores/appStore';
import {
  getClipClipboard,
  getClipboardKind,
  setClipClipboard,
  type ClipboardClipEntry,
} from '../services/clipboard';

// The five reasons a Paste can be refused (or, read by `EditToolbar`, why
// Copy has nothing to copy). Exported as constants so the tooltip and the
// tests read the exact same strings — `pasteBlockReason` is the only place
// that composes one.
export const PASTE_EMPTY_REASON = 'nothing has been copied yet';
export const PASTE_HOLDS_AUDIO_REASON =
  'the clipboard holds a region of audio — copy a clip first';
export const PASTE_NO_TRACK_REASON = 'click a track’s background to choose where the clips land';
export const PASTE_CLOSED_SOURCE_REASON = 'the file these clips came from has been closed';
export const PASTE_HOLDS_CLIPS_REASON =
  'the clipboard holds multitrack clips — copy a region of audio first';

/**
 * Resolves `clipIds` against `session` and emits one {@link ClipboardClipEntry}
 * per live id, in READING ORDER — tracks in `session.tracks` order, clips
 * within a track by ascending `startSample` (the same order `clipIdsInSpan`,
 * lot K's marquee, emits). Pure: no store read, no store write.
 *
 * `trackOffset` is relative to the topmost SOURCE track (0 for it);
 * `startOffsetSample` is relative to the EARLIEST copied clip's `startSample`
 * (0 for it), both at the source session's rate. An id no live clip carries
 * is silently skipped — the caller (`copySelectedClips`) reads
 * `selectedClipIds`, which the store already keeps live, but a defensive
 * caller gets a defensive function.
 */
export function clipsToClipboardEntries(
  session: Session,
  clipIds: readonly string[]
): ClipboardClipEntry[] {
  const wanted = new Set(clipIds);
  const hits: { trackIndex: number; clip: Clip }[] = [];
  session.tracks.forEach((track, trackIndex) => {
    for (const clip of track.clips) {
      if (wanted.has(clip.id)) hits.push({ trackIndex, clip });
    }
  });
  if (hits.length === 0) return [];

  hits.sort((a, b) => a.trackIndex - b.trackIndex || a.clip.startSample - b.clip.startSample);
  const minTrackIndex = hits[0].trackIndex; // sorted ascending, so the first hit IS the minimum
  const minStartSample = Math.min(...hits.map((h) => h.clip.startSample));

  return hits.map(({ trackIndex, clip }) => {
    const entry: ClipboardClipEntry = {
      documentId: clip.documentId,
      trackOffset: trackIndex - minTrackIndex,
      startOffsetSample: clip.startSample - minStartSample,
      offsetSample: clip.offsetSample, // DOCUMENT samples — session.ts:187-197
      lengthSample: clip.lengthSample,
      gainDb: clip.gainDb,
    };
    // Fade keys copied only when present, so an unfaded clip round-trips
    // with none — `undefined` and "absent key" must stay indistinguishable
    // (session.ts's own fade invariant docblock).
    if (clip.fadeInSample !== undefined) entry.fadeInSample = clip.fadeInSample;
    if (clip.fadeOutSample !== undefined) entry.fadeOutSample = clip.fadeOutSample;
    if (clip.fadeInCurve !== undefined) entry.fadeInCurve = clip.fadeInCurve;
    if (clip.fadeOutCurve !== undefined) entry.fadeOutCurve = clip.fadeOutCurve;
    return entry;
  });
}

/**
 * L4b — the ONLY place the sample-rate rule for a pasted clip exists. Pure.
 *
 * `ratio = session.sampleRate / payload.sampleRate`: `startSample` and
 * `lengthSample` are session samples and scale by it; `offsetSample` is
 * NEVER converted — it is stated in the source DOCUMENT's own samples, and
 * `clipSourceWindow` (`session.ts:187-197`) already converts
 * `lengthSample -> document samples` at `docRate/sessionRate` on every read,
 * so a clip pasted into a session at another rate already sounds right with
 * no sample touched here.
 *
 * `ratio === 1` short-circuits to the stored values verbatim, so a same-rate
 * paste is byte-identical geometry — no rounding pass to disagree with itself.
 *
 * Fades go through `clampFadePair` (never scaled independently) so the fade
 * invariant `fadeIn + fadeOut <= lengthSample` survives the rounding; a 0
 * result normalizes back to an ABSENT key, never `fadeInSample: 0`.
 */
export function pastedClipGeometry(
  entry: ClipboardClipEntry,
  anchorSample: number,
  ratio: number
): {
  startSample: number;
  offsetSample: number;
  lengthSample: number;
  fadeInSample?: number;
  fadeOutSample?: number;
} {
  if (ratio === 1) {
    const out: ReturnType<typeof pastedClipGeometry> = {
      startSample: anchorSample + entry.startOffsetSample,
      offsetSample: entry.offsetSample,
      lengthSample: entry.lengthSample,
    };
    if (entry.fadeInSample !== undefined) out.fadeInSample = entry.fadeInSample;
    if (entry.fadeOutSample !== undefined) out.fadeOutSample = entry.fadeOutSample;
    return out;
  }

  const startSample = anchorSample + Math.round(entry.startOffsetSample * ratio);
  // 1 is the type floor a clip's length may never go below (a 0-length clip
  // has no geometry to render) — not a tuned tolerance, so X3 does not bind a
  // fixture to it; this lot introduces no new threshold.
  const lengthSample = Math.max(1, Math.round(entry.lengthSample * ratio));
  const rawFadeIn = Math.round((entry.fadeInSample ?? 0) * ratio);
  const rawFadeOut = Math.round((entry.fadeOutSample ?? 0) * ratio);
  const { fadeIn, fadeOut } = clampFadePair(rawFadeIn, rawFadeOut, lengthSample, 'in');

  const out: ReturnType<typeof pastedClipGeometry> = {
    startSample,
    offsetSample: entry.offsetSample,
    lengthSample,
  };
  if (fadeIn > 0) out.fadeInSample = fadeIn;
  if (fadeOut > 0) out.fadeOutSample = fadeOut;
  return out;
}

/**
 * L1 — Copy, on the multitrack clip selection. Returns `false` WITHOUT
 * writing when the selection resolves to no entries (an empty selection, or
 * one whose ids the store has already dropped) — a Copy that copies nothing
 * leaves a standing clipboard exactly as it was, audio or clips. No undo
 * entry: this changes the clipboard, not the session.
 */
export function copySelectedClips(): boolean {
  const { session, selectedClipIds } = useSessionStore.getState();
  const entries = clipsToClipboardEntries(session, selectedClipIds);
  if (entries.length === 0) return false;
  setClipClipboard({ entries, sampleRate: session.sampleRate });
  return true;
}

/**
 * L3 / L4a — the ONE function that is both the `edit.paste` gate (multitrack
 * arm) and its displayed reason, so a second predicate that could disagree
 * with the tooltip never exists. Checked in this order: an empty clipboard;
 * an audio-shaped clipboard (copy a clip instead); no CURRENT track (K2/K3;
 * L3's own ruling — "does nothing and the clipboard keeps its contents"); a
 * clip whose source document has been closed since it was copied
 * (`mixdown.ts`/`sessionFile.ts` would otherwise render it as nothing and
 * then drop it on save). `undefined` means Paste may proceed.
 */
export function pasteBlockReason(): string | undefined {
  const kind = getClipboardKind();
  if (kind === null) return PASTE_EMPTY_REASON;
  if (kind === 'audio') return PASTE_HOLDS_AUDIO_REASON;

  const { session, currentTrackId } = useSessionStore.getState();
  if (currentTrackId === null || !session.tracks.some((t) => t.id === currentTrackId)) {
    return PASTE_NO_TRACK_REASON;
  }

  const payload = getClipClipboard();
  const docs = useAppStore.getState().documents;
  if (payload !== null && payload.entries.some((e) => !docs.some((d) => d.id === e.documentId))) {
    return PASTE_CLOSED_SOURCE_REASON;
  }

  return undefined;
}

/**
 * L2 — Paste: re-checks {@link pasteBlockReason} (a stale caller gets `[]`,
 * never a half-run paste) and, when clear, places one clip per clipboard
 * entry inside ONE undo entry ('Paste clip' / 'Paste clips'), the
 * `sessionInsert.placeDocumentsOnTrack` shape:
 *
 *  - the anchor is `Math.max(0, Math.round(mtCursorSample))` — the bar,
 *    UNCLAMPED by its own setter, clamped the same way `sessionInsert.ts`
 *    clamps a drop position;
 *  - each entry's track is `min(currentTrackIndex + trackOffset,
 *    tracks.length - 1)` — track SHAPE is preserved (paste never creates or
 *    refuses for lack of tracks), so entries clamped to the same track
 *    overlap, which `addClip` already accepts verbatim;
 *  - the primary afterward is the topmost track's earliest pasted clip, via
 *    the SAME reversed-id trick `mergeClips.ts`'s `commitMergedClips` and lot
 *    K's marquee use against `setSelectedClips`'s last-id-wins rule.
 *
 * The clipboard is NOT cleared and NOT touched by undo — undoing a paste does
 * not un-copy, matching every other "paste again" workflow in the app.
 * Returns the placed ids in reading order (`[]` when refused).
 */
export function pasteClipsAtCursor(): string[] {
  if (pasteBlockReason() !== undefined) return [];
  const payload = getClipClipboard();
  if (payload === null) return [];

  const { session, currentTrackId, mtCursorSample, addClip, setSelectedClips } =
    useSessionStore.getState();
  const baseIdx = session.tracks.findIndex((t) => t.id === currentTrackId);
  if (baseIdx === -1) return []; // defensive; pasteBlockReason already refused this case

  const ratio = session.sampleRate / payload.sampleRate;
  const anchor = Math.max(0, Math.round(mtCursorSample));
  const docs = useAppStore.getState().documents;

  const placedIds: string[] = [];
  const built: { doc: AudioDocument; clip: Clip }[] = [];
  withSessionGesture(payload.entries.length === 1 ? 'Paste clip' : 'Paste clips', () => {
    for (const entry of payload.entries) {
      const geo = pastedClipGeometry(entry, anchor, ratio);
      const trackIdx = Math.min(baseIdx + entry.trackOffset, session.tracks.length - 1);
      const clip = createClip({
        documentId: entry.documentId,
        startSample: geo.startSample,
        offsetSample: geo.offsetSample,
        lengthSample: geo.lengthSample,
        gainDb: entry.gainDb,
        fadeInSample: geo.fadeInSample,
        fadeOutSample: geo.fadeOutSample,
        fadeInCurve: entry.fadeInCurve,
        fadeOutCurve: entry.fadeOutCurve,
      });
      addClip(session.tracks[trackIdx].id, clip);
      placedIds.push(clip.id);
      const doc = docs.find((d) => d.id === entry.documentId);
      if (doc) built.push({ doc, clip });
    }
    // Reversed against reading order, so the reading-order-FIRST id (topmost
    // track, earliest start) ends up LAST — `setSelectedClips`'s own
    // last-id-wins rule then makes it the primary. Identical to lot K's
    // marquee (`MultitrackView.tsx`'s `reversedHits`) and
    // `mergeClips.ts:218-226`'s ordering.
    setSelectedClips([...placedIds].reverse());
  });

  // MT2-2, off the play path: a clip that will need converting gets
  // converted now, once the gesture (and any rate adoption it could have
  // triggered — paste never adopts, L4b) has settled.
  const sessionRate = useSessionStore.getState().session.sampleRate;
  for (const { doc, clip } of built) warmClipResample(doc, clip, sessionRate);

  return placedIds;
}
