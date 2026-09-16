import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { FileDown, FilePlus2, Plus } from 'lucide-react';
import { GlassButton } from '../UI/glass';
import { commandReason, isCommandEnabled, runCommand } from '../../services/menuActions';
import { usePassLock } from '../../services/passLock';
import { useAppStore } from '../../stores/appStore';
import { hasAnyClip, publishSessionLaneWidth, useSessionStore } from '../../multitrack/sessionStore';
import { orderTimeRange, rangeBandPx } from '../../multitrack/timeRange'; // lot J
import { sessionLaneWidth } from '../../multitrack/sessionViewport';
import { snapSample } from '../../services/snap';
import TimelineRuler from '../Editor/TimelineRuler';
import {
  CURSOR_HANDLE,
  CURSOR_HANDLE_H,
  CURSOR_HANDLE_HALF_W,
  CURSOR_HANDLE_HIT_H,
  CURSOR_HANDLE_HIT_PX,
  pixelToSample,
  sampleToPixel,
} from '../Editor/waveformRender';
import {
  clipIdsInSpan,
  marqueeExceeded,
  marqueeModeFor,
  orderedSpan,
  trackIdsInBand,
} from './marqueeSelect';
import { sessionSnapTargets } from './sessionSnapTargets';
import TrackHeader from './TrackHeader';
import TrackLane from './TrackLane';
import { useMultitrackZoom } from './useMultitrackZoom';

const HEADER_W = 224; // Tailwind w-56 (14rem)
const LANE_H = 96; // Tailwind h-24

/** F11-2: the ruler's magnet targets for THIS surface — every clip edge and
 * beat in the session. Nothing is excluded: a ruler seek is not a clip drag,
 * so there is no clip whose own edges must be left out.
 *
 * F2/F3 (item 6) — `includeCursor: false`, because this function feeds BOTH
 * bar-moving gestures (the ruler seek prop below, and the cursor handle drag
 * at `onHandlePointerDown`): the multitrack cursor's OWN current position used
 * to sit in the target set, so a small deliberate move near "where the bar
 * already is" snapped straight back to it — the literal complaint, "near its
 * last position". `sessionSnapTargets.ts`'s header explains the trap-27
 * parallel. The bar stays a target for gestures that aim AT it (a clip drop,
 * an envelope key) — those call `sessionSnapTiers`/`sessionSnapTargets` with
 * no options and keep the default `includeCursor: true`. */
function mtSnapTargets(): number[] {
  return sessionSnapTargets(null, { includeCursor: false });
}

/** T7: the same Alt escape hatch every drag surface in this app keeps
 * (`useEditorGestures`, `ClipView`, `EnvelopeLane`) — re-read per event, so
 * pressing or releasing Alt mid-drag takes effect on the next move. */
function snapSuspended(e: { altKey: boolean }): boolean {
  return e.altKey;
}

/** T7: above EnvelopeLane's `z-10` capture surface — the only positive z under
 * the overlay wrapper — so the handle both paints over and wins the press
 * against everything in the lanes. */
const CURSOR_HANDLE_Z = 20;

/**
 * The multitrack editor. Left column of TrackHeaders aligned with a right lane
 * area sharing the session store's own zoom (`mtZoom`); a TimelineRuler on top
 * seeks the multitrack cursor; a playhead line tracks realtime playback. Works
 * with no open document (an empty session shows a hint). Vertical track scroll
 * is a single scroller with the header + lane in each row; horizontal zoom/scroll
 * is Ctrl/Shift-wheel over the lanes (see useMultitrackZoom).
 */
export default function MultitrackView() {
  // Lot M: the pass lock is module state, not zustand — subscribe so Mix
  // Down's `disabled`/`title` recompute the instant the lock moves.
  usePassLock();
  const session = useSessionStore((s) => s.session);
  const mtZoom = useSessionStore((s) => s.mtZoom);
  const selectedClipId = useSessionStore((s) => s.selectedClipId);
  const mtCursorSample = useSessionStore((s) => s.mtCursorSample);
  const mtPlayState = useSessionStore((s) => s.mtPlayState);
  const mtPlayheadSample = useSessionStore((s) => s.mtPlayheadSample);
  const setMtCursor = useSessionStore((s) => s.setMtCursor);
  const addTrack = useSessionStore((s) => s.addTrack);
  // K2/K3 — the CURRENT track, so each row can mark itself.
  const currentTrackId = useSessionStore((s) => s.currentTrackId);
  // K1 — the marquee's own writers. Read as actions here (not captured at
  // gesture start) because the commit reads `selectedClipIds` fresh from
  // `getState()` at press time instead (K5's `baseIds`).
  const setSelectedClip = useSessionStore((s) => s.setSelectedClip);
  const setSelectedClips = useSessionStore((s) => s.setSelectedClips);
  const setSelectedGap = useSessionStore((s) => s.setSelectedGap);
  // Lot J — the multitrack time range and its own raw setter.
  const mtTimeRange = useSessionStore((s) => s.mtTimeRange);
  const setMtTimeRange = useSessionStore((s) => s.setMtTimeRange);

  const documents = useAppStore((s) => s.documents);
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  useMultitrackZoom(scrollRef);

  // MT1-1: this scroller IS the stage the session zoom fits to, and nothing else
  // in the app knows how wide it is — the same fact `WaveformView` publishes for
  // the editor, published here for the session. `publishSessionLaneWidth` takes
  // the SCROLLER's width and subtracts the header column itself, so the 224 px
  // constant stays a layout fact of this file and a zoom fact of exactly one
  // module. A session opened before any lane existed was fitted to the FALLBACK
  // width, so the first real measurement re-fits it — but only because those
  // load paths now commit a fitted zoom (C1). While they wrote a hardcoded 512
  // this effect rescued nothing: `publishSessionLaneWidth` only re-fits a view
  // already AT its fit, and 512 is far zoomed in of it for any real session.
  // T7 review F3 — the scroller width mirrored into state PURELY as a render
  // trigger: `publishSessionLaneWidth` has a load-bearing no-op guard (a
  // resize that leaves the resolved zoom unchanged writes nothing to the
  // store), so without this mirror the handle's right-edge cull below would
  // keep judging against a stale `sessionLaneWidth()` until the next
  // unrelated store change. The value itself is never read — the cull keeps
  // reading `sessionLaneWidth()`, the one copy of the header subtraction.
  const [, setScrollerW] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      publishSessionLaneWidth(el.clientWidth); // first, so the width is fresh when the render lands
      setScrollerW(el.clientWidth);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [dragTargetTrackId, setDragTargetTrackId] = useState<string | null>(null);

  const docs = new Map(documents.map((d) => [d.id, d]));
  const hasClips = hasAnyClip(session);
  const hasActiveDoc = activeDocumentId !== null;

  const resolveTrackAt = useCallback((clientX: number, clientY: number): string | null => {
    const el = document.elementFromPoint(clientX, clientY);
    const lane = el instanceof Element ? el.closest('[data-track-id]') : null;
    return lane?.getAttribute('data-track-id') ?? null;
  }, []);

  const cursorX = HEADER_W + sampleToPixel(mtCursorSample, mtZoom.scrollSample, mtZoom.samplesPerPixel);
  const playheadX =
    HEADER_W + sampleToPixel(mtPlayheadSample, mtZoom.scrollSample, mtZoom.samplesPerPixel);

  // Task 8 — "the bar goes over and off the track instead of disappearing."
  // The overlay wrapper clips on the right, but the header column sits INSIDE
  // it, so nothing hid an x below HEADER_W; and nothing hid a sample scrolled
  // past the right edge either. Exact-edge cull, the DOM twin of the canvas's
  // own `cx >= 0 && cx <= width` for its cursor/playhead lines (`waveformRender`
  // renderWaveform, ~:257/266). Review round 1: the handle uses this SAME rule
  // below (not the canvas's wider `cursorHandleVisible`) — "no handle without
  // a line" is a real constraint for this DOM overlay, unlike the canvas
  // where the triangle is independently drawn and licensed to outlive the
  // line by its own half-width.
  //
  // `sessionLaneWidth()` never actually returns <= 0 (it falls back to
  // `FALLBACK_SESSION_LANE_WIDTH` before the first measurement) — the `<= 0`
  // arm is belt-and-suspenders against that contract ever changing, so the
  // cursor at sample 0 still paints at HEADER_W rather than the guard
  // collapsing to "nothing visible" on an unmeasured lane.
  const laneVisible = (x: number): boolean => {
    const laneWidth = sessionLaneWidth();
    return x >= HEADER_W && (laneWidth <= 0 || x <= HEADER_W + laneWidth);
  };

  // T7 — the session cursor's grab handle, the multitrack sibling of F11-1.
  // The editor's handle is canvas paint hit-tested by `isOnCursorHandle`; this
  // overlay is DOM, so the hit band IS the element (± CURSOR_HANDLE_HIT_PX ×
  // CURSOR_HANDLE_HIT_H) and the triangle a CSS-border child, both sized from
  // the `waveformRender` constants so three views share one geometry.
  //
  // Same gesture contract as `useEditorGestures`' playhead arm: targets frozen
  // at pointerdown (an analysis or edit completing mid-drag must not move the
  // position under the user's hand), Alt re-read per event, whole samples,
  // clamped at 0 (a session has no fixed end, so no upper clamp — the ruler's
  // own rule), and NO transport call on release: nothing in `transportService`
  // watches the cursor, it is where the NEXT play starts.
  const overlayRef = useRef<HTMLDivElement | null>(null);
  /** F3 (item 6) — carries the whole press gesture, not just its frozen
   * targets: `pressRaw` (unclamped, so the release reproduces `snappedMt`'s
   * snap-then-clamp order) and `moved`, set true by the first handled
   * pointermove. A release with `moved === false` commits `pressRaw` through
   * `snappedMt` — see `onHandlePointerUp` below. */
  const handleDragRef = useRef<{ targets: number[]; pressRaw: number; moved: boolean } | null>(
    null
  );
  const [handleGrabbed, setHandleGrabbed] = useState(false);

  /** Lane-relative x for a client x — the overlay wrapper's rect minus the
   * header column, the inverse of the `cursorX` arithmetic above. */
  const laneXAtClientX = (clientX: number): number => {
    const rect = overlayRef.current?.getBoundingClientRect() ?? { left: 0 };
    return clientX - rect.left - HEADER_W;
  };

  // K1 — THE MARQUEE. One gesture record for the whole press, mirroring the
  // cursor handle's own `handleDragRef` shape above: captured once at
  // pointerdown, read and cleared at pointerup/cancel, nothing kept in React
  // state except what must repaint (`marqueeRect`, the drawn rectangle).
  //
  // `targetEl` is the element pointer capture was actually taken on (risk 1,
  // the brief's own hazard) — released against the SAME element, never
  // `overlayRef`. `anchorSample`/`anchorContentY` are the press position in
  // SAMPLE and SCROLLER-CONTENT-Y space respectively (not client px), so a
  // mid-drag zoom, scroll or horizontal pan cannot detach the rectangle from
  // what it is supposed to be drawn against (risk 8). `anchorClientX/Y` are
  // kept separately, in raw client px, purely for the THRESHOLD test — CSS
  // px is what `MARQUEE_DRAG_THRESHOLD_PX` and every sibling drag threshold
  // on this surface are measured in, and re-deriving px from the sample
  // anchor would reintroduce the samples/px rounding the threshold must not
  // see. `baseIds` is the selection as it stood at press time (K5's Ctrl
  // union base); `deferredClear` is X6's flag — Ctrl or Shift held at press,
  // committed (or not) at pointerup by `TrackLane`'s own half of this rule.
  const marqueeRef = useRef<{
    pointerId: number;
    targetEl: Element;
    // 'range' (fix round 2, X6; lot J) — a Shift press. Carries the SAME
    // shape as 'add'/'replace' for K's own purpose (catching the
    // sub-threshold click-away clear: `onOverlayPointerUp` returns before
    // computing a hit set for it, and `onOverlayPointerMove` draws no
    // MARQUEE rectangle for it) — lot J owns the actual sweep, reading
    // `anchorRangeSample`/`targets` below, fields K's own 'add'/'replace'
    // modes never populate.
    mode: 'add' | 'replace' | 'range';
    anchorSample: number;
    anchorContentY: number;
    anchorClientX: number;
    anchorClientY: number;
    lastClientX: number;
    lastClientY: number;
    baseIds: string[];
    deferredClear: boolean;
    exceeded: boolean;
    // Lot J — 'range' mode only. `targets` is `mtSnapTargets()` FROZEN once
    // at pointerdown (T7's rule: a drag's magnet must not change under the
    // user's hand mid-gesture), `null` for 'add'/'replace' (K's own modes
    // never read it). `anchorRangeSample` is the SNAPPED anchor — unlike
    // K's own `anchorSample` above (raw, unsnapped: the marquee's rectangle
    // is pixel-accurate, not magnet-seeking) — snapped once at pointerdown
    // and reused verbatim for every move, the `useEditorGestures.ts:252`
    // precedent ("the anchor is snapped once; only the moving edge is
    // re-snapped").
    targets: number[] | null;
    anchorRangeSample: number;
  } | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);

  /** The sample a client x lands on, clamped at 0 — the same conversion the
   * cursor handle uses (`laneXAtClientX` + `pixelToSample`), reused here so
   * the marquee's horizontal span and the bar's own position agree on one
   * pixel↔sample mapping. */
  const marqueeSampleAt = (clientX: number): number =>
    pixelToSample(Math.max(0, laneXAtClientX(clientX)), mtZoom.scrollSample, mtZoom.samplesPerPixel);

  /** The scroller-content Y for a client y: the inverse of the rectangle's own
   * `top` arithmetic below, and the SAME transform `anchorContentY` was
   * captured with at pointerdown, so a live drag and a post-scroll redraw
   * both read the same coordinate space. */
  const contentYAt = (clientY: number): number => {
    const rect = scrollRef.current?.getBoundingClientRect();
    const scrollTop = scrollRef.current?.scrollTop ?? 0;
    return clientY - (rect?.top ?? 0) + scrollTop;
  };

  /** The drawn rectangle for a gesture anchored at `rec`'s sample/content-Y,
   * dragged to `(clientX, clientY)` — one derivation, shared by the live
   * pointermove handler and the `onScroll` redraw below, so the two can never
   * draw two different rectangles for the same gesture. Left is clamped at
   * the lane origin (a drag off the left edge must not paint under the
   * header column); top/height are in on-screen (viewport) px, converted back
   * from content-Y by subtracting the CURRENT scrollTop, which is exactly
   * what makes the scroll handler's redraw track a scroll with no auto-scroll
   * of its own (K6). */
  const marqueeRectFor = (
    rec: { anchorSample: number; anchorContentY: number },
    clientX: number,
    clientY: number
  ): { left: number; top: number; width: number; height: number } => {
    const span = orderedSpan(rec.anchorSample, marqueeSampleAt(clientX));
    const rawLeft = HEADER_W + sampleToPixel(span.startSample, mtZoom.scrollSample, mtZoom.samplesPerPixel);
    const rawRight = HEADER_W + sampleToPixel(span.endSample, mtZoom.scrollSample, mtZoom.samplesPerPixel);
    const left = Math.max(HEADER_W, rawLeft);
    const scrollTop = scrollRef.current?.scrollTop ?? 0;
    const contentY = contentYAt(clientY);
    const yTop = Math.min(rec.anchorContentY, contentY) - scrollTop;
    const yBottom = Math.max(rec.anchorContentY, contentY) - scrollTop;
    return { left, top: yTop, width: Math.max(0, rawRight - left), height: Math.max(0, yBottom - yTop) };
  };

  /** K1/X6 — the capture-phase gate. CAPTURE, not bubble: it must decide
   * before `TrackLane`'s own bubble `onPointerDown` runs, so `baseIds` below
   * is the selection as it stood BEFORE that handler's deferred clear.
   *
   * The positive target test is mandatory, not defensive (risk 4): several
   * surfaces under this wrapper bubble a button-0 pointerdown without
   * stopping it (`mt-cursor-handle`, `TrackHeader`'s Vol/Pan inputs and
   * rename box), and capturing a marquee under one of THOSE presses would
   * starve the real gesture of `pointerup` the moment its own capture takes
   * over. Checking `e.target` here (not `e.currentTarget`, which is always
   * this wrapper) is what tells a lane/scroller background press apart from
   * every one of them. This handler runs BEFORE rows 1-5 of the pointer
   * contract ever see the event (capture is top-down; those rows' own
   * `stopPropagation` calls happen later, at target/bubble phase, so they
   * are irrelevant to this gate) — only the target test above excludes them.
   *
   * Fix round 2 (X6, BLOCKER) — a Shift press (`marqueeModeFor` → `'range'`)
   * USED to return here with no record written at all, on the theory that
   * lot J owns the whole gesture. That was wrong: `TrackLane.tsx`'s own
   * pointerdown skips ITS clear whenever Ctrl **or** Shift is held, so with
   * no record from here either, a Shift press-and-release on empty lane
   * space cleared nothing — `USER_GUIDE.md:1720` silently false, the exact
   * regression the amendment named. A `'range'` press now writes the SAME
   * record shape as `'add'`/`'replace'` (`mode: 'range'`) — it exists solely
   * so `onOverlayPointerUp` can commit the click-away clear on a
   * SUB-THRESHOLD release; `onOverlayPointerMove` draws no rectangle for it
   * and `onOverlayPointerUp` commits no clip/gap selection for it once the
   * gesture exceeds the threshold (see both, below) — J's actual sweep is
   * untouched by any of this. */
  const onOverlayPointerDownCapture = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    // K1, fix round 2 — `data-lane-bg`, not `data-testid`: a testid rename is
    // cosmetic anywhere else in the app and would silently kill the marquee
    // if this read it. `TrackLane.tsx`'s own comment beside the attribute
    // names the same reasoning.
    const isLaneBg = target.dataset.laneBg === 'true';
    const isScrollerBg = target === scrollRef.current;
    if (!isLaneBg && !isScrollerBg) return;

    const mode = marqueeModeFor(e);

    // Pointer capture on `e.target` — the lane or the scroller — and NEVER on
    // `overlayRef` (the brief's own hazard 1): Chromium retargets the
    // compatibility mouse events (click/dblclick) to the CAPTURING element,
    // so capturing on an ancestor would silently move `TrackLane`'s
    // `onDoubleClick`'s `e.target === e.currentTarget` gap gesture off itself
    // and kill it with no jsdom test able to see it (jsdom does not
    // implement the retargeting).
    target.setPointerCapture?.(e.pointerId);

    const anchorSample = marqueeSampleAt(e.clientX);
    const anchorContentY = contentYAt(e.clientY);
    // Lot J — 'range' mode only: the snap targets frozen for the whole
    // gesture (T7), and the anchor snapped ONCE against them
    // (`useEditorGestures.ts:252`'s precedent). `anchorSample` above stays
    // K's own raw, unsnapped pixel anchor for the marquee rectangle; this is
    // a SEPARATE sample in a separate coordinate role, not a second name for
    // the same value.
    const targets = mode === 'range' ? mtSnapTargets() : null;
    const anchorRangeSample = targets !== null ? snappedMt(anchorSample, targets, e) : 0;
    marqueeRef.current = {
      pointerId: e.pointerId,
      targetEl: target,
      mode,
      anchorSample,
      anchorContentY,
      anchorClientX: e.clientX,
      anchorClientY: e.clientY,
      lastClientX: e.clientX,
      lastClientY: e.clientY,
      baseIds: [...useSessionStore.getState().selectedClipIds],
      targets,
      anchorRangeSample,
      // X6 — fix round 2 (item 6, the gutter asymmetry). On a LANE,
      // `TrackLane.onPointerDown` already clears immediately for the PLAIN
      // case (no modifiers); this flag only needs to cover what it defers
      // (Ctrl or Shift), so `deferredClear` mirrors that condition exactly.
      // On the SCROLLER gutter there is no `TrackLane` underneath at all —
      // nothing else will EVER clear a plain press there — so this flag has
      // to cover the plain case itself, and Ctrl/Shift (an ADD modifier)
      // must not destroy a selection the press never touched. The two
      // surfaces therefore use INVERTED conditions on purpose, not by
      // accident: matching outcomes (a click-away clears; Ctrl/Shift-click
      // does not except where a lane's own deferred-clear rule already says
      // otherwise), reached by different logic because a different handler
      // owns the plain case on each surface.
      deferredClear: isLaneBg ? e.ctrlKey || e.shiftKey : !(e.ctrlKey || e.shiftKey),
      exceeded: false,
    };
  };

  const onOverlayPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rec = marqueeRef.current;
    if (!rec || e.pointerId !== rec.pointerId) return;
    rec.lastClientX = e.clientX;
    rec.lastClientY = e.clientY;
    if (!rec.exceeded && marqueeExceeded(rec.anchorClientX, rec.anchorClientY, e.clientX, e.clientY)) {
      rec.exceeded = true;
    }
    // Below the threshold, render NOTHING — this is what keeps the gap
    // double-click's two sub-threshold presses from flashing a rectangle
    // (risk 3): the first press's pointerup below commits nothing at all
    // while `!rec.exceeded`, not even an empty selection.
    //
    // `'range'` draws no rectangle even once exceeded (fix round 2, X6):
    // this record exists only to catch the click-away clear on a
    // sub-threshold release; a real Shift-drag is lot J's own sweep, drawing
    // whatever lot J draws, not K1's rubber-band.
    if (rec.mode === 'range') {
      // Lot J — below the threshold, write nothing (same rule as the
      // marquee: an un-exceeded press must not paint a band any more than it
      // draws a rectangle). Past it, only the MOVING edge is re-snapped —
      // `rec.anchorRangeSample` was snapped once at pointerdown and is
      // reused verbatim — and `setMtTimeRange` is the ONLY thing painting the
      // band: no parallel preview variable exists for a stale label to read.
      if (rec.exceeded) {
        const raw = marqueeSampleAt(e.clientX);
        const moving = snappedMt(raw, rec.targets ?? [], e);
        setMtTimeRange(orderTimeRange(rec.anchorRangeSample, moving));
      }
      return;
    }
    if (rec.exceeded) setMarqueeRect(marqueeRectFor(rec, e.clientX, e.clientY));
  };

  /** K6 — no edge auto-scroll, but a plain (uncaptured) vertical scroll mid-drag
   * still happens, and the drawn rectangle must track it: `anchorContentY` and
   * the live content-Y are both scroll-invariant, so re-deriving the ON-SCREEN
   * rectangle against the CURRENT `scrollTop` is the entire fix. A React prop,
   * so there is no listener to remove. */
  const onScrollerScroll = () => {
    const rec = marqueeRef.current;
    if (!rec || !rec.exceeded) return;
    setMarqueeRect(marqueeRectFor(rec, rec.lastClientX, rec.lastClientY));
  };

  /** The row rects the commit hit-tests against: `scrollRef.current`'s DIRECT
   * children carrying `data-track-id`, never `querySelectorAll` (risk 7) —
   * `TrackLane`'s own root ALSO carries that attribute, nested one level
   * deeper, so an unscoped query would return 2N elements and silently double
   * the row mapping. Content-Y, the same transform `anchorContentY` uses. */
  const marqueeRows = (): { id: string; top: number; bottom: number }[] => {
    const scroller = scrollRef.current;
    if (!scroller) return [];
    const scrollerRect = scroller.getBoundingClientRect();
    const scrollTop = scroller.scrollTop;
    return Array.from(scroller.children)
      .filter((el): el is HTMLElement => el instanceof HTMLElement && el.hasAttribute('data-track-id'))
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          id: el.getAttribute('data-track-id') as string,
          top: r.top - scrollerRect.top + scrollTop,
          bottom: r.bottom - scrollerRect.top + scrollTop,
        };
      });
  };

  const onOverlayPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rec = marqueeRef.current;
    if (!rec || e.pointerId !== rec.pointerId) return;
    marqueeRef.current = null;
    setMarqueeRect(null);
    try {
      rec.targetEl.releasePointerCapture?.(rec.pointerId);
    } catch {
      // Capture may already have been released (lost on blur); ignore — the
      // same pattern the cursor handle's own release uses above.
    }
    if (!rec.exceeded) {
      // X6 — the deferred clear's other half: a press that never became a
      // drag is a CLICK, and `TrackLane` already spoke for the current-track
      // write; all that is left is the clear it skipped when Ctrl/Shift was
      // held (or, on the gutter, the clear nothing else was ever going to
      // do — see `deferredClear`'s own comment above). Nothing else, ever —
      // a sub-threshold release must commit no selection at all (risk 3), so
      // the gap double-click's first press stays inert. This is also where a
      // sub-threshold `'range'` (Shift) press resolves: `deferredClear` is
      // always true for it, so a Shift press-and-release still deselects
      // (X6, fix round 2).
      if (rec.deferredClear) setSelectedClip(null);
      // Lot J (row 9) — the sweep's own click-away: a sub-threshold `'range'`
      // release is a Shift-click, not a drag, so it clears a standing time
      // range exactly as Escape does (`edit.deselect`) rather than leaving a
      // band up with nothing that swept it.
      if (rec.mode === 'range') setMtTimeRange(null);
      // Item 3, fix round 3 — the GUTTER has no `TrackLane` to run its own
      // gap-clearing check (`TrackLane.tsx`'s D3 block, which clears a
      // standing gap unconditionally on modifiers whenever the press is not
      // INSIDE that gap's own span on its own lane). A gutter press can
      // never be "inside" any track's gap band — there is no lane under it
      // — so there is no exception to preserve, and the gutter's own
      // click-away must clear unconditionally too, or a plain gutter click
      // would drop the clip selection while leaving a selected gap painted:
      // two click-away surfaces with different results, exactly the
      // asymmetry item 6 existed to remove. `rec.targetEl === scrollRef.current`
      // is the same test `isScrollerBg` used at press time, re-read off the
      // stored target rather than a second stored flag.
      if (rec.targetEl === scrollRef.current) setSelectedGap(null);
      return;
    }
    // K1's commit — the swept clip selection — is `'add'`/`'replace'` only.
    // A `'range'` record that exceeded the threshold is a REAL Shift-drag,
    // i.e. lot J's time-range sweep, already fully committed by the last
    // `onOverlayPointerMove` (every move writes `mtTimeRange` directly —
    // there is no separate commit step, the same "no parallel preview state"
    // rule that keeps the drawn band and the store in lockstep). Nothing
    // left to do here but let the generic teardown above run.
    if (rec.mode === 'range') return;
    const rowIds = trackIdsInBand(marqueeRows(), rec.anchorContentY, contentYAt(e.clientY));
    const span = orderedSpan(rec.anchorSample, marqueeSampleAt(e.clientX));
    const hits = clipIdsInSpan(session.tracks, rowIds, span.startSample, span.endSample);
    // The primary ruling (`sessionStore.ts:1406-1409`'s "last id wins" +
    // `mergeClips.ts:218-226`'s same reordering trick): REVERSED reading
    // order seats the topmost track's earliest clip as primary. For a Ctrl
    // union the base ids go first, so the standing primary (already the last
    // id in `baseIds` by construction) survives the store's own rule and
    // nothing moves.
    const reversedHits = [...hits].reverse();
    setSelectedClips(rec.mode === 'add' ? [...rec.baseIds, ...reversedHits] : reversedHits);
    // The zero-hit sweep and a standing gap: a committed drag always clears
    // it (a drag proves the press was not the first half of the gap
    // double-click), and `setSelectedGap`'s own no-op guard makes this free
    // when `setSelectedClips` already cleared it via a non-empty hit set.
    setSelectedGap(null);
  };

  const onOverlayPointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rec = marqueeRef.current;
    if (!rec || e.pointerId !== rec.pointerId) return;
    marqueeRef.current = null;
    setMarqueeRect(null);
    // T1's written precedent (`ClipView.tsx:956-975`): A CANCELLED GESTURE
    // COMMITS NOTHING. The platform took the gesture away — capture lost on
    // blur, alt-tab, the OS stealing the pointer — so the press was never
    // completed and is not a click either; no selection write, no
    // `deferredClear` commit, just teardown.
    //
    // Lot J — for `'range'` this is DELIBERATELY unlike `ClipView.tsx`'s own
    // cancel, which rolls a clip back to where it started: `mtTimeRange` is
    // view state with no undo entry (the `selectedGap` treatment), not an
    // edit, so a half-swept range is left EXACTLY where the last move put
    // it — an honest position, not a half-committed one to unwind. Teardown
    // here clears only the gesture record, never the range itself.
    try {
      rec.targetEl.releasePointerCapture?.(rec.pointerId);
    } catch {
      // Capture may already have been released; ignore.
    }
  };

  /** Fix round 2 (item 8) — a captured element that UNMOUNTS mid-drag (a
   * track removed by shortcut while its lane holds the marquee's pointer
   * capture) never delivers `pointercancel` to `onOverlayPointerCancel`
   * above: a DETACHED element has no ancestor chain left for the event to
   * bubble through by the time the browser would dispatch it, and this
   * handler is registered on `overlayRef`, an ancestor. Rather than depend
   * on an event that may never arrive, this watches the session directly —
   * every mutation, a track removal included, replaces its reference — and
   * tears the gesture down the moment its captured element is no longer
   * connected to the document, exactly the recovery a delivered
   * `pointercancel` would have performed. Cheap even though it runs on every
   * session change: one `isConnected` read, no-op the rest of the time. */
  useEffect(() => {
    const rec = marqueeRef.current;
    if (rec && !rec.targetEl.isConnected) {
      marqueeRef.current = null;
      setMarqueeRect(null);
    }
  }, [session]);

  /** The editor's `snapped()` shape with the session's pieces: snap the RAW
   * position FIRST, then clamp, then round — `useEditorGestures`' order, so a
   * drag far off the left edge lands at 0 rather than being clamped to 0 and
   * then magnet-pulled onto a target just inside it (T7 review F2). Round on
   * both arms (PW1 — a fractional session fit must not park the cursor
   * between two samples); clamp at 0 only, a session has no fixed end. */
  const snappedMt = (raw: number, targets: number[], e: { altKey: boolean }): number => {
    if (snapSuspended(e) || targets.length === 0) return Math.round(Math.max(0, raw));
    return Math.round(Math.max(0, snapSample(raw, targets, mtZoom.samplesPerPixel).sample));
  };

  const onHandlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    handleDragRef.current = {
      targets: mtSnapTargets(), // captured once per gesture
      pressRaw: pixelToSample(laneXAtClientX(e.clientX), mtZoom.scrollSample, mtZoom.samplesPerPixel),
      moved: false,
    };
    const el = e.currentTarget;
    if (typeof el.setPointerCapture === 'function') el.setPointerCapture(e.pointerId);
    setHandleGrabbed(true);
    // F3 (item 6) overturns the ruling this comment used to state — "grabbing
    // a handle must not itself move it": still true of the PRESS. What
    // changed is the RELEASE: a press that never moves now commits the press
    // position (see `onHandlePointerUp`), because a click on the handle that
    // committed nothing at all was the second cause of "give more precision
    // to the bar" (item 6) — a dead zone, not a snap-back. So: the press does
    // not move the bar; the release does, if and only if the pointer never
    // moved. Still no setMtCursor here.
  };

  const onHandlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = handleDragRef.current;
    if (!drag) return; // hovering — the grab affordance is plain CSS here
    drag.moved = true;
    const raw = pixelToSample(laneXAtClientX(e.clientX), mtZoom.scrollSample, mtZoom.samplesPerPixel);
    setMtCursor(snappedMt(raw, drag.targets, e));
  };

  const onHandlePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = handleDragRef.current; // captured before clearing (F3)
    handleDragRef.current = null;
    setHandleGrabbed(false);
    const el = e.currentTarget;
    if (typeof el.releasePointerCapture === 'function') {
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        // Capture may already have been released (lost on blur); ignore.
      }
    }
    // F3 (item 6) — a press that never moved commits the PRESS position, snapped
    // and clamped exactly as a live move would (`snappedMt`'s own order), with
    // Alt read from THIS release event. This overturns the ruling this file used
    // to state at this line — "Deliberately no setMtCursor: grabbing a handle
    // must not itself move it" — for the release only; the press above still
    // moves nothing.
    if (drag && !drag.moved) setMtCursor(snappedMt(drag.pressRaw, drag.targets, e));
  };

  /** F3/F-c (item 6) — a cancel (capture lost on blur, alt-tab, the OS
   * stealing the pointer) tears the gesture down WITHOUT committing. Now that
   * a travel-free release commits a position (above), routing cancel to the
   * same handler as release would write the bar to wherever a cancelled press
   * happened to land — harmless before this lot, when release was a no-op, and
   * wrong now. Same teardown as release, no `setMtCursor` call. */
  const onHandlePointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    handleDragRef.current = null;
    setHandleGrabbed(false);
    const el = e.currentTarget;
    if (typeof el.releasePointerCapture === 'function') {
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        // Capture may already have been released (lost on blur); ignore.
      }
    }
  };

  // Task 8 review (round 1) — unified onto `laneVisible`, the SAME rule as
  // the line: "the handle's hit band follows the line (no handle without a
  // line)" is a real requirement here, not the canvas's. The canvas keeps its
  // own wider `cursorHandleVisible` (±CURSOR_HANDLE_HALF_W) because there the
  // triangle is drawn independently of the line and is allowed to outlive it
  // by half its own width; this DOM overlay has no such license — a lone
  // triangle with no line under it reads as a rendering bug, not a feature.
  // Parked out of the lane, the handle is not drawn at a clamped wrong
  // position — it is not drawn at all. A GRABBED handle stays mounted
  // regardless, because unlike the editor (where the canvas outlives its
  // culled drawing) this element IS the gesture surface, and unmounting it
  // mid-drag would drop the pointer capture.
  const handleVisible = handleGrabbed || laneVisible(cursorX);

  // G6: the view sits on the radial stage (stage-inset root) with each track
  // row floating as a glass card. The horizontal geometry inside the relative
  // wrapper is untouched — rows still start at x=0 with the lane at exactly
  // HEADER_W, so the cursor/playhead overlay math and the wheel-zoom anchor
  // (D1: `useMultitrackZoom` anchors on `mtCursorSample` through the pure
  // `anchoredZoom` helper, using `sessionLaneWidth()` for the lane width — it
  // reads no rect at all) hold unchanged; the stage padding lives OUTSIDE the
  // wrapper, shifting ruler and lanes together. Rows are separated by
  // vertical gaps only (x-neutral).
  return (
    <div
      className="stage-inset flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="multitrack-view"
      // F11-4 — outside a lane, a FILE drop does nothing, visibly. A lane that
      // accepts a drag has already called preventDefault by the time the event
      // bubbles here, so this only speaks for the parts of the surface that are
      // not a lane: it refuses the drop (dropEffect 'none' is the OS's "no"
      // cursor) and swallows it.
      //
      // Honestly, about the swallowing (M3, matching `App.tsx`'s window guard).
      // `navigateOnDragDrop` — the webPreferences flag that would make Chromium
      // navigate to a dropped file, replacing the app with a file viewer — has
      // defaulted to FALSE since Electron 3, and `electron/main.cjs` never sets
      // it, so the catastrophe this once cited is not currently reachable. The
      // refusal stays as config-drift insurance: it costs one condition and the
      // failure it covers is total.
      //
      // The `Files` gate is not optional. Without it this refused EVERY
      // unclaimed drag, and the default action being suppressed for a text drag
      // is the one that inserts the text into a text control — which this view
      // owns: the track-rename input in `TrackHeader`. That is the exact
      // regression `0ddcb68` fixed at the window level, which had a second copy
      // here. A text drag carries `text/plain`, a clip drag carries our own
      // MIME, and neither carries `Files`.
      //
      // `dragover` gets the same condition as `drop`, because a `drop` whose
      // `dragover` was not prevented never fires at all.
      onDragOver={(e) => {
        if (e.defaultPrevented) return; // a lane took it
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'none';
      }}
      onDrop={(e) => {
        if (e.defaultPrevented) return;
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
      }}
    >
      {/* Session strip: glass buttons on the bare stage (no band chrome). */}
      <div className="flex shrink-0 items-center gap-2 pb-2">
        <GlassButton
          disabled={!hasActiveDoc}
          onClick={() => void runCommand('multitrack.insertDoc')}
          className="disabled:opacity-40"
          style={{ padding: '5px 12px', fontSize: 12, gap: 6 }}
        >
          <FilePlus2 size={13} /> Insert Active File
        </GlassButton>
        <GlassButton
          disabled={!isCommandEnabled('multitrack.mixdown')}
          title={commandReason('multitrack.mixdown') ?? undefined}
          onClick={() => void runCommand('multitrack.mixdown')}
          className="disabled:opacity-40"
          style={{ padding: '5px 12px', fontSize: 12, gap: 6 }}
        >
          <FileDown size={13} /> Mix Down
        </GlassButton>
        <span className="ml-auto text-[10px]" style={{ color: 'var(--glass-text-muted)' }}>
          {(session.sampleRate / 1000).toFixed(1)} kHz · Ctrl+wheel zoom · Shift+wheel scroll
        </span>
      </div>

      {/* Ruler row (transparent spacer over the header column, ruler over the lanes) */}
      <div className="flex shrink-0">
        <div className="w-56 shrink-0" />
        <div className="min-w-0 flex-1">
          {/* F11-2: the session's own snap targets, at the session's own zoom —
              the editor's would quantise this surface at the wrong scale. */}
          <TimelineRuler
            sampleRate={session.sampleRate}
            zoom={mtZoom}
            onSeek={setMtCursor}
            snapTargets={mtSnapTargets}
          />
        </div>
      </div>

      {/* Lanes + headers (relative wrapper carries the playhead/cursor overlays).
          K1 — the marquee's capture-phase gate and its move/up/cancel triplet
          live on THIS wrapper (bubble phase for the latter three: the capture
          target sits inside it, so captured moves/ups still reach it here). */}
      <div
        ref={overlayRef}
        className="relative min-h-0 flex-1 overflow-hidden"
        onPointerDownCapture={onOverlayPointerDownCapture}
        onPointerMove={onOverlayPointerMove}
        onPointerUp={onOverlayPointerUp}
        onPointerCancel={onOverlayPointerCancel}
      >
        <div
          ref={scrollRef}
          className="h-full overflow-y-auto overflow-x-hidden"
          onScroll={onScrollerScroll}
        >
          {session.tracks.map((track) => (
            <div
              key={track.id}
              // V1 review, Minor 3 — THE WHOLE ROW IS THE TRACK, header
              // included. `resolveTrackAt` walks up from the element under the
              // pointer to the nearest `[data-track-id]`; only the LANE carried
              // one, so a drag whose pointer sat over another track's header
              // resolved to nothing and `?? trackId` in ClipView committed the
              // move back on the source track — a drop the highlight never
              // offered, because nothing was highlighted either. (Before V1
              // clipped the lane, the same pointer hit that lane's overhanging
              // clip box and DID resolve to the foreign track; V1 removed the
              // overhang, and this row attribute is what puts the answer back
              // on purpose rather than by accident.)
              //
              // The lane keeps its own attribute and still wins inside it —
              // `closest` takes the nearest — so this only speaks for the 224 px
              // header column. Nothing here widens a GROUP drag: that branch
              // never consults the resolver (K1 v1 moves every member on its own
              // track), and this is the single-clip drop's answer.
              data-track-id={track.id}
              className="glass-track-row flex"
              style={{ height: LANE_H, marginBottom: 10 }}
            >
              <TrackHeader track={track} />
              <TrackLane
                track={track}
                docs={docs}
                zoom={mtZoom}
                sessionRate={session.sampleRate}
                laneHeight={LANE_H}
                selectedClipId={selectedClipId}
                isDragTarget={dragTargetTrackId === track.id}
                isCurrent={currentTrackId === track.id}
                resolveTrackAt={resolveTrackAt}
                onDragOverTrack={setDragTargetTrackId}
              />
            </div>
          ))}

          <button
            type="button"
            onClick={() => addTrack()}
            className="m-2 flex items-center gap-1 rounded-lg border border-dashed border-white/20 px-3 py-1.5 text-xs text-[#8a8a92] transition-colors hover:border-[#26c6da] hover:text-[#d8d8de]"
          >
            <Plus size={13} /> Add Track
          </button>

          {!hasClips && (
            <div
              className="pointer-events-none px-4 py-6 text-center text-xs"
              style={{ color: 'var(--glass-text-muted)' }}
            >
              Empty session. Open an audio file, then use “Insert Active File” to place it on a track.
            </div>
          )}
        </div>

        {/* Lot J — the swept TIME RANGE band. Rendered BEFORE `mt-cursor-line`
            (below) so the white cursor paints over it, exactly as the gap
            band's own tokens (`TrackLane.tsx`'s `--accent-soft`/
            `--accent-ring`) — the same colour language, deliberately: J5
            keeps the two mutually exclusive on screen, so reusing the gap's
            look says "this is the multitrack's other kind of span" rather
            than inventing a third visual language. No `z-index` of its own
            (paints under `EnvelopeLane`'s `z-10` and the cursor handle's 20,
            same as the marquee rectangle). `rangeBandPx` returns LANE
            pixels; `HEADER_W` is added here once, mirroring `cursorX` above
            — no fifth copy of the 224. */}
        {(() => {
          const band = rangeBandPx(mtTimeRange, mtZoom, sessionLaneWidth());
          return (
            band !== null && (
              <div
                data-testid="mt-time-range"
                className="pointer-events-none absolute top-0 bottom-0"
                style={{
                  left: HEADER_W + band.leftPx,
                  width: band.widthPx,
                  backgroundColor: 'var(--accent-soft)',
                  boxShadow: 'inset 0 0 0 1px var(--accent-ring)',
                }}
              />
            )
          );
        })()}
        {/* Multitrack cursor (white) — where playback will start. The LINE
            stays inert; only the handle below is grabbable, the same split as
            the editor's hit rule. Task 8: culled by `laneVisible` — a bar off
            the lane disappears instead of painting over the header column or
            trailing off the right edge. */}
        {laneVisible(cursorX) && (
          <div
            data-testid="mt-cursor-line"
            className="pointer-events-none absolute top-0 bottom-0 w-px bg-[#d4d4d8]/70"
            style={{ left: cursorX }}
          />
        )}
        {/* K1 — the marquee rectangle. Lives HERE, in the overlay wrapper, and
            NOT as a child of any one lane: `TrackLane`'s root is
            `overflow-clip` on purpose (its own V1 docblock), and a rectangle
            spanning several rows would be clipped at the first lane's box.
            No `z-index` of its own, so it paints UNDER an open
            `EnvelopeLane` (z-10) and under the cursor handle (z 20) — both
            correct and intended: an open envelope owns its lane's pointer
            events regardless, and the handle must keep winning the press
            over everything in the lanes. `pointer-events-none`, like the drop
            ghost: it is drawn feedback for a gesture already owned by the
            overlay wrapper's own handlers, never a hit target of its own. */}
        {marqueeRect !== null && (
          <div
            data-testid="mt-marquee"
            className="pointer-events-none absolute"
            style={{
              left: marqueeRect.left,
              top: marqueeRect.top,
              width: marqueeRect.width,
              height: marqueeRect.height,
              backgroundColor: 'var(--accent-soft)',
              boxShadow: 'inset 0 0 0 1px var(--accent)',
            }}
          />
        )}
        {/* T7: the cursor's red grab handle, riding the top of the lanes area
            just as the editor's rides the canvas top. */}
        {handleVisible && (
          <div
            data-testid="mt-cursor-handle"
            onPointerDown={onHandlePointerDown}
            onPointerMove={onHandlePointerMove}
            onPointerUp={onHandlePointerUp}
            onPointerCancel={onHandlePointerCancel}
            className="absolute"
            style={{
              left: cursorX - CURSOR_HANDLE_HIT_PX,
              top: 0,
              width: CURSOR_HANDLE_HIT_PX * 2,
              height: CURSOR_HANDLE_HIT_H,
              cursor: handleGrabbed ? 'grabbing' : 'grab',
              zIndex: CURSOR_HANDLE_Z,
            }}
          >
            <div
              style={{
                position: 'absolute',
                left: CURSOR_HANDLE_HIT_PX - CURSOR_HANDLE_HALF_W,
                top: 0,
                width: 0,
                height: 0,
                borderLeft: `${CURSOR_HANDLE_HALF_W}px solid transparent`,
                borderRight: `${CURSOR_HANDLE_HALF_W}px solid transparent`,
                borderTop: `${CURSOR_HANDLE_H}px solid ${CURSOR_HANDLE}`,
              }}
            />
          </div>
        )}
        {/* Playhead (accent + soft glow, G6) while playing. Task 8: ALSO
            culled by `laneVisible` — playing is necessary but not sufficient,
            the sweep must still be on-lane to paint. */}
        {mtPlayState === 'playing' && laneVisible(playheadX) && (
          <div
            data-testid="mt-playhead"
            className="pointer-events-none absolute top-0 bottom-0 w-0.5"
            style={{
              left: playheadX,
              backgroundColor: 'var(--accent)',
              boxShadow: '0 0 8px var(--accent-ring)',
            }}
          />
        )}
      </div>
    </div>
  );
}
