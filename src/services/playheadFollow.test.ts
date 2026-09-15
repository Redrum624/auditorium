import {
  FOLLOW_EDGE_EPSILON_PX,
  createPlayheadFollow,
  playheadVisible,
  watchPointerActivity,
  type FollowViewport,
} from './playheadFollow';

/**
 * A1-A6 — the page-flip follow, exercised pure (no store, no React, no rAF).
 *
 * Fixture is deliberately off-identity throughout (X3): 256 samples/px, a
 * 900 px lane, scrolled to 441000 (10 s @ 44.1 kHz) -> window
 * [441000, 671400). No assertion here sits on 0, a default or a fit.
 */
const VIEWPORT: FollowViewport = { samplesPerPixel: 256, scrollSample: 441000 };
const LANE_WIDTH = 900;

function next(follow: ReturnType<typeof createPlayheadFollow>, args: Partial<{
  positionSample: number;
  viewport: FollowViewport;
  laneWidth: number;
  pointerBusy: boolean;
}> = {}) {
  return follow.next({
    positionSample: args.positionSample ?? 0,
    viewport: args.viewport ?? VIEWPORT,
    laneWidth: args.laneWidth ?? LANE_WIDTH,
    pointerBusy: args.pointerBusy ?? false,
  });
}

describe('playheadVisible / createPlayheadFollow', () => {
  it('inside the window writes nothing', () => {
    const follow = createPlayheadFollow();
    expect(next(follow, { positionSample: 500000 })).toBeNull();
  });

  it('past the right edge lands at the left edge (A1) — the exact value, no lead', () => {
    const follow = createPlayheadFollow();
    expect(next(follow, { positionSample: 700000 })).toBe(700000);
  });

  it('behind the left edge flips too (A3)', () => {
    const follow = createPlayheadFollow();
    expect(next(follow, { positionSample: 220500 })).toBe(220500);
  });

  it('the epsilon applies from both sides (X3)', () => {
    expect(FOLLOW_EDGE_EPSILON_PX).toBe(0.5);

    // Right edge at px = 900 exactly.
    expect(next(createPlayheadFollow(), { positionSample: 671400 })).toBeNull();
    // px = 900.25 — inside the 0.5 px slack.
    expect(next(createPlayheadFollow(), { positionSample: 671464 })).toBeNull();
    // px = 900.75 — outside the slack, flips.
    expect(next(createPlayheadFollow(), { positionSample: 671592 })).toBe(671592);
  });

  it('a manual scroll suspends the follow, and re-entry re-arms it (A5)', () => {
    const follow = createPlayheadFollow();
    expect(next(follow, { viewport: { samplesPerPixel: 256, scrollSample: 441000 }, positionSample: 500000 })).toBeNull();

    // User scrolled +100000 while playing.
    expect(
      next(follow, { viewport: { samplesPerPixel: 256, scrollSample: 541000 }, positionSample: 700000 })
    ).toBeNull();

    // Same (moved) viewport, playhead now inside [541000, 771400) — re-armed.
    expect(
      next(follow, { viewport: { samplesPerPixel: 256, scrollSample: 541000 }, positionSample: 600000 })
    ).toBeNull();

    // Same viewport, playhead now past the edge — flips.
    expect(
      next(follow, { viewport: { samplesPerPixel: 256, scrollSample: 541000 }, positionSample: 800000 })
    ).toBe(800000);
  });

  it('a zoom suspends even with an unchanged scroll — FAILS against the literal A5 text', () => {
    const follow = createPlayheadFollow();
    expect(next(follow, { viewport: { samplesPerPixel: 256, scrollSample: 0 }, positionSample: 100000 })).toBeNull();

    // Zoomed in 4x; the clamp leaves scrollSample at the same value (0).
    expect(
      next(follow, { viewport: { samplesPerPixel: 64, scrollSample: 0 }, positionSample: 100000 })
    ).toBeNull();

    expect(
      next(follow, { viewport: { samplesPerPixel: 64, scrollSample: 0 }, positionSample: 30000 })
    ).toBeNull();

    expect(
      next(follow, { viewport: { samplesPerPixel: 64, scrollSample: 0 }, positionSample: 90000 })
    ).toBe(90000);
  });

  it('pointerBusy defers without suspending', () => {
    const follow = createPlayheadFollow();
    expect(next(follow, { positionSample: 700000, pointerBusy: true })).toBeNull();
    // Identical viewport and position, pointer released — a suspension would
    // have kept returning null here; a defer does not.
    expect(next(follow, { positionSample: 700000, pointerBusy: false })).toBe(700000);
  });

  it('guards a non-finite or non-positive laneWidth, samplesPerPixel or positionSample', () => {
    expect(playheadVisible({ positionSample: 500000, viewport: VIEWPORT, laneWidth: 0 })).toBe(true);
    expect(
      playheadVisible({ positionSample: 500000, viewport: VIEWPORT, laneWidth: Number.NaN })
    ).toBe(true);
    expect(
      playheadVisible({
        positionSample: 500000,
        viewport: { samplesPerPixel: 0, scrollSample: 441000 },
        laneWidth: LANE_WIDTH,
      })
    ).toBe(true);
    expect(
      playheadVisible({ positionSample: Number.NaN, viewport: VIEWPORT, laneWidth: LANE_WIDTH })
    ).toBe(true);

    expect(next(createPlayheadFollow(), { positionSample: 700000, laneWidth: 0 })).toBeNull();
    expect(next(createPlayheadFollow(), { positionSample: 700000, laneWidth: Number.NaN })).toBeNull();
    expect(
      next(createPlayheadFollow(), {
        positionSample: 700000,
        viewport: { samplesPerPixel: 0, scrollSample: 441000 },
      })
    ).toBeNull();
    expect(next(createPlayheadFollow(), { positionSample: Number.NaN })).toBeNull();
  });

  it('watchPointerActivity cleans up its own listeners on dispose', () => {
    const pointer = watchPointerActivity();
    expect(pointer.isDown()).toBe(false);

    window.dispatchEvent(new Event('pointerdown'));
    expect(pointer.isDown()).toBe(true);
    window.dispatchEvent(new Event('pointerup'));
    expect(pointer.isDown()).toBe(false);

    pointer.dispose();
    window.dispatchEvent(new Event('pointerdown'));
    expect(pointer.isDown()).toBe(false);
  });
});
