/**
 * A5/A1-A3 — THE page-flip follow: while playing, once the playhead leaves the
 * visible window the viewport pages over so the playhead lands at the left
 * edge and playback keeps going, on both surfaces.
 *
 * Deliberately store-free and surface-free, like `zoomAnchor.ts`: it is given
 * a position, a viewport and a lane width, and it hands back either nothing or
 * a scroll request. Neither the app store nor the session store is imported
 * here, so the editor's `Zoom` and the session's `SessionZoom` share one copy
 * of the rule instead of drifting into two (X2).
 *
 * **Why a page-flip and not a per-frame scroll.** A flip costs one FFT
 * re-slice on the spectral surface (`SpectrogramView.tsx:232,281`) and a full
 * re-raster of every visible clip's waveform + tic canvas on the multitrack
 * surface (`ClipView.tsx:312,508-523`, `clipBeatTics.ts:123-135`). Scrolling by
 * a pixel a frame would pay that cost 60 times a second instead of once per
 * page; no variant that scrolls every frame may be substituted for this.
 */

/**
 * How far outside the drawn lane, in CSS px, the playhead must sit before the
 * follow flips. Half a pixel — below the 2 px playhead line's own width.
 *
 * Needed because the visibility test below is otherwise an EXACT float
 * equality at Fit: `fitSessionSamplesPerPixel` sets
 * `spp = sessionTimelineLength / laneWidth` (`sessionZoom.ts:123-128`), so the
 * window's right edge is `laneWidth * (length / laneWidth)`, which IEEE-754
 * does not guarantee is `<= laneWidth` (e.g. `3 / (3 / 7) === 7.000000000000001`
 * in double precision). Without slack, the inclusive test alone would still
 * fire once per session on some lengths, right as playback reaches the end.
 */
export const FOLLOW_EDGE_EPSILON_PX = 0.5;

/** The part of a viewport this needs: the pair every zoom in the app is —
 * structurally the editor's `Zoom` (`appStore.ts:109-112`) and the session's
 * `SessionZoom` (`sessionZoom.ts:58-61`), named once so neither store need be
 * imported here. */
export interface FollowViewport {
  samplesPerPixel: number;
  scrollSample: number;
}

/**
 * Whether `positionSample` is drawn inside `viewport` at `laneWidth`.
 *
 * The edge test is the renderers' own cull, copied rather than re-derived:
 * `px >= 0 && px <= width` (`waveformRender.ts:270`,
 * `MultitrackView.tsx:134-137`), widened by {@link FOLLOW_EDGE_EPSILON_PX} on
 * both sides.
 *
 * **Guard first.** A non-finite or `<= 0` `laneWidth` or `samplesPerPixel`, or
 * a non-finite `positionSample`, returns `true` ("visible" — do nothing), so no
 * NaN can ever reach a store through this path. This is stricter than
 * `anchoredZoom` (`zoomAnchor.ts:69-81`), which leans on `resolveZoom`'s own
 * NaN arm (`appStore.ts:204`) instead of guarding itself; the follow guards
 * itself because it is the one deciding WHETHER to write at all, not just what
 * to write.
 */
export function playheadVisible(args: {
  positionSample: number;
  viewport: FollowViewport;
  laneWidth: number;
}): boolean {
  const { positionSample, viewport, laneWidth } = args;
  if (
    !Number.isFinite(laneWidth) ||
    laneWidth <= 0 ||
    !Number.isFinite(viewport.samplesPerPixel) ||
    viewport.samplesPerPixel <= 0 ||
    !Number.isFinite(positionSample)
  ) {
    return true;
  }
  const px = (positionSample - viewport.scrollSample) / viewport.samplesPerPixel;
  return px >= -FOLLOW_EDGE_EPSILON_PX && px <= laneWidth + FOLLOW_EDGE_EPSILON_PX;
}

export interface PlayheadFollow {
  /**
   * Called once a frame. Returns the sample to scroll to (A1: the new left
   * edge, no lead) or `null` when the follow should write nothing this frame —
   * because the playhead is already visible, a gesture is in flight, or the
   * user moved the viewport out from under it (A5).
   */
  next(args: {
    positionSample: number;
    viewport: FollowViewport;
    laneWidth: number;
    pointerBusy: boolean;
  }): number | null;
  /** Records the viewport the surface actually stored after its own clamp, so
   * the next frame's "did the user move it" check compares against what is
   * really on screen rather than what the follow asked for. */
  committed(viewport: FollowViewport): void;
}

/**
 * A5 (extended by amendment A5-a — see `decisions.md`'s "RULING CHALLENGED"
 * note): the follow remembers the WHOLE `{ samplesPerPixel, scrollSample }`
 * pair it last saw, not just the scroll. A zoom alone can leave `scrollSample`
 * bit-identical (anchored at sample 0, already scrolled to 0 — `resolveZoom`
 * clamps a negative request to 0 either side of the zoom, `appStore.ts:201-205`),
 * so scroll-only detection would miss it and keep flipping a view the user is
 * actively zooming.
 */
export function createPlayheadFollow(): PlayheadFollow {
  let baseline: FollowViewport | null = null;
  let suspended = false;

  return {
    next(args) {
      const { positionSample, viewport, laneWidth, pointerBusy } = args;
      if (
        baseline !== null &&
        (viewport.samplesPerPixel !== baseline.samplesPerPixel ||
          viewport.scrollSample !== baseline.scrollSample)
      ) {
        // Written by someone other than this follow — a manual scroll or zoom.
        suspended = true;
      }
      baseline = { samplesPerPixel: viewport.samplesPerPixel, scrollSample: viewport.scrollSample };

      const visible = playheadVisible({ positionSample, viewport, laneWidth });
      if (visible) suspended = false;

      if (pointerBusy || suspended || visible) return null;
      return positionSample;
    },
    committed(viewport) {
      baseline = { samplesPerPixel: viewport.samplesPerPixel, scrollSample: viewport.scrollSample };
    },
  };
}

/**
 * The ONE copy of the gesture-defer rule: while any pointer button is down
 * anywhere in the app, a flip lands mid-gesture and corrupts it. Three
 * gestures map pointer x -> sample through the LIVE `scrollSample` while their
 * anchor stays frozen, so a flip between two `pointermove` events would move
 * the moving edge by a whole page while the anchor stays put:
 * `useEditorGestures.ts:165-171` (selection drag, anchor frozen at
 * `:275`/`:278`), `MultitrackView.tsx:184` (cursor-handle drag) and
 * `EnvelopeLane.tsx:152` (automation key drag). Clip move/trim drags are
 * delta-based (`ClipView.tsx:603`) and are immune, but the watcher does not
 * distinguish — it defers on ANY pointer down, which is safe for them too
 * (they just never need the deferral).
 *
 * The three pointer events are capture-phase so no listener anywhere in the
 * tree can stop this one from seeing them. `blur` is the release-outside-the-
 * window escape: without it, a `pointerup` that fires while focus has left
 * the window (e.g. a native file dialog, or the OS window losing focus
 * mid-drag) would never arrive and the follow would stay deferred for the
 * rest of the playback run.
 *
 * **`blur` is deliberately NOT capture-phase — fix round 1.** `blur` does not
 * bubble, but a capture-phase listener still fires for it (capture traverses
 * every ancestor down to the target regardless of bubbling), so
 * `addEventListener('blur', h, true)` on `window` fires on ANY element in the
 * app losing focus, not just the window itself. Measured in jsdom: a
 * `pointerdown` on a canvas is followed by the browser's default focus move
 * (`useEditorGestures.onPointerDown` never calls `preventDefault` — only the
 * wheel handler does), which blurs whatever control had focus (e.g. the Play
 * button just clicked to start playback) and, at capture phase, that blur was
 * reaching this handler and clearing `down` before the drag even started —
 * exactly the corruption this watcher exists to prevent. Registered WITHOUT
 * capture, `blur` only fires when `window` itself is the event's target
 * (there is no bubble path to it otherwise), which is precisely "the window
 * itself lost focus" and nothing else.
 */
export function watchPointerActivity(): { isDown(): boolean; dispose(): void } {
  if (typeof window === 'undefined') {
    return { isDown: () => false, dispose: () => {} };
  }
  let down = false;
  const onDown = () => {
    down = true;
  };
  const onUp = () => {
    down = false;
  };
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onUp, true);
  window.addEventListener('blur', onUp, false);
  return {
    isDown: () => down,
    dispose: () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      window.removeEventListener('blur', onUp, false);
    },
  };
}
