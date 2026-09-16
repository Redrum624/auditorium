import type { Track } from '../../multitrack/session';
import { exceedsDragThreshold } from '../Editor/selectionGestures';

/**
 * K1 — the marquee's own drag threshold, in CSS px.
 *
 * Deliberately **4**, not `selectionGestures.ts`'s own default of 3
 * (`snap.ts:52-53` records the same divergence for the editor's drag
 * threshold): every OTHER drag gesture already sharing this surface —
 * `ClipView.tsx`'s `DRAG_THRESHOLD` and `EnvelopeLane.tsx`'s own copy — uses
 * 4, and a marquee that started a pixel earlier than a clip move would be a
 * second, silently different threshold on the same surface (X2). Reusing
 * `exceedsDragThreshold` rather than writing a third local comparison keeps
 * the ARITHMETIC shared even though the NUMBER differs per gesture family.
 */
export const MARQUEE_DRAG_THRESHOLD_PX = 4;

/**
 * K1 — has this press moved far enough, on EITHER axis, to become a
 * rectangle rather than a click? A vertical-only drag counts: sweeping
 * straight down across stacked tracks with no horizontal movement at all is
 * still a marquee, not a no-op — `orderedSpan` below would otherwise collapse
 * a vertical-only rectangle's horizontal span to zero width and the sweep
 * would silently hit nothing.
 */
export function marqueeExceeded(anchorX: number, anchorY: number, x: number, y: number): boolean {
  return (
    exceedsDragThreshold(anchorX, x, MARQUEE_DRAG_THRESHOLD_PX) ||
    exceedsDragThreshold(anchorY, y, MARQUEE_DRAG_THRESHOLD_PX)
  );
}

/** The rectangle's horizontal span as whole samples, order-independent — the
 * anchor may land on either side of the current pointer position. */
export function orderedSpan(a: number, b: number): { startSample: number; endSample: number } {
  return { startSample: Math.round(Math.min(a, b)), endSample: Math.round(Math.max(a, b)) };
}

/**
 * K1 — which track ROWS (by id) the rectangle's vertical span touches, in the
 * order the caller gave them (reading order, top to bottom). Half-open
 * overlap, like every other span in this codebase (`gaps.ts:10-17`):
 * `row.top < yMax && yMin < row.bottom`, so a band that lands exactly on a
 * boundary (the inter-row gutter) touches neither row on either side of it.
 *
 * Coordinates are SCROLLER CONTENT Y (the caller's job to supply them that
 * way) — not viewport Y — so a vertical scroll mid-drag cannot detach the
 * rectangle from the rows it was drawn against (risk 8 in the brief).
 */
export function trackIdsInBand(
  rows: readonly { id: string; top: number; bottom: number }[],
  yA: number,
  yB: number
): string[] {
  const yMin = Math.min(yA, yB);
  const yMax = Math.max(yA, yB);
  return rows.filter((r) => r.top < yMax && yMin < r.bottom).map((r) => r.id);
}

/**
 * K4 — any-overlap hit test: a clip is in the span if the rectangle touches
 * ANY of it, half-open at both ends (`gaps.ts`'s own convention):
 * `clip.startSample < endSample && startSample < clip.startSample +
 * clip.lengthSample`. Emitted in READING ORDER — tracks in the order
 * `trackIds` names them, clips within a track by ascending `startSample` —
 * so the caller can seat a primary by reversing (or not) without re-sorting.
 */
export function clipIdsInSpan(
  tracks: readonly Track[],
  trackIds: readonly string[],
  startSample: number,
  endSample: number
): string[] {
  const ids: string[] = [];
  for (const trackId of trackIds) {
    const track = tracks.find((t) => t.id === trackId);
    if (!track) continue;
    const clips = [...track.clips].sort((a, b) => a.startSample - b.startSample);
    for (const clip of clips) {
      if (clip.startSample < endSample && startSample < clip.startSample + clip.lengthSample) {
        ids.push(clip.id);
      }
    }
  }
  return ids;
}

/**
 * K5/J7 — what a press's modifiers mean on this surface. `shiftKey` is
 * tested FIRST and selects `'range'` — lot J's time-range sweep — even when
 * `ctrlKey` is also held. That is NOT K5's "Ctrl wins over Shift" precedence
 * (`ClipView.tsx:991-994`): that rule composes two modifiers on ONE gesture
 * (a click), where Ctrl's toggle is checked ahead of Shift's range-extend.
 * Here Shift and Ctrl pick between two DIFFERENT gestures, and Shift is
 * reserved for lot J unconditionally — lot K starts no gesture under it.
 */
export function marqueeModeFor(e: {
  ctrlKey: boolean;
  shiftKey: boolean;
}): 'range' | 'add' | 'replace' {
  if (e.shiftKey) return 'range';
  if (e.ctrlKey) return 'add';
  return 'replace';
}
