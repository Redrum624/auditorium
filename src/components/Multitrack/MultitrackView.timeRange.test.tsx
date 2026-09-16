/**
 * Lot J (item 10) — the multitrack TIME RANGE, WIRED: a real `Shift`+drag over
 * the real `MultitrackView`, conforming to lot K's pointer contract row 9
 * (`.superpowers\sdd\2026-09-14-editor-feedback\lot-k-report.md`).
 *
 * Fixture (X3 — non-identity): SR = 48_000, samplesPerPixel = 200,
 * scrollSample = 0, `mtCursorSample` seeded at 17_000 (never 0). Track `T`
 * carries one clip far out on the timeline — `edge [900_900, 1_000_900)` —
 * used ONLY by the Alt-suppression test; every other test's coordinates stay
 * hundreds of thousands of samples clear of it, well outside the 8 px (here,
 * 1_600-sample) snap tolerance. Track `U` carries two small clips,
 * `u1 [50_000, 60_000)` and `u2 [70_000, 80_000)`, selected together for the
 * deferred-clear test. Client x is `MT_HEADER_W + laneX` (the `atLaneX` idiom
 * of `MultitrackView.cursorHandle.test.tsx:69`, reused verbatim by
 * `MultitrackView.marquee.test.tsx`).
 */
import { act, render, screen } from '@testing-library/react';
import { createClip, createTrack, type Session } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
import { _resetSessionUndo } from '../../multitrack/sessionUndo';
import { MT_HEADER_W, _resetSessionLaneWidth } from '../../multitrack/sessionViewport';
import { makeInitialState, useAppStore } from '../../stores/appStore';
import MultitrackView from './MultitrackView';

const SR = 48_000;
const SPP = 200;
const CURSOR_SEED = 17_000;

const store = () => useSessionStore.getState();

/** jsdom has no window.PointerEvent; a real MouseEvent (which carries
 * clientX/Y, the modifier keys, and can be told its own pointerId) stands in,
 * exactly as `MultitrackView.marquee.test.tsx`'s own `firePointer` does —
 * extended with `altKey`, which lot J's snap-suspend needs and lot K's own
 * helper never had to carry. */
function firePointer(
  element: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  init: { clientX: number; clientY: number; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean }
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY,
    shiftKey: init.shiftKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    button: 0,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    element.dispatchEvent(event);
  });
}

/** The wrapper's rect is all zeros in jsdom, so a lane-relative x maps to
 * clientX by the same header offset the component adds. */
const atLaneX = (x: number): number => MT_HEADER_W + x;

let tId: string, uId: string;
let u1: string, u2: string;

function renderView(): {
  container: HTMLElement;
  lanes: HTMLElement[];
  overlay: HTMLElement;
  scroller: HTMLElement;
} {
  const { container } = render(<MultitrackView />);
  const lanes = Array.from(container.querySelectorAll('[data-testid="track-lane"]')) as HTMLElement[];
  const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
  const overlay = scroller.parentElement as HTMLElement;
  return { container, lanes, overlay, scroller };
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  _resetSessionUndo();
  _resetSessionLaneWidth();

  const t = createTrack('T');
  const u = createTrack('U');
  const edgeClip = createClip({ documentId: 'doc-1', startSample: 900_900, offsetSample: 0, lengthSample: 100_000 });
  const clipU1 = createClip({ documentId: 'doc-1', startSample: 50_000, offsetSample: 0, lengthSample: 10_000 });
  const clipU2 = createClip({ documentId: 'doc-1', startSample: 70_000, offsetSample: 0, lengthSample: 10_000 });
  t.clips = [edgeClip];
  u.clips = [clipU1, clipU2];
  const session: Session = { name: 'Range Sweep Fixture', sampleRate: SR, tracks: [t, u] };
  useSessionStore.setState({
    session,
    selectedClipId: null,
    selectedClipIds: [],
    selectedGap: null,
    currentTrackId: null,
    lastSplit: null,
    mtCursorSample: CURSOR_SEED,
    mtTimeRange: null,
    mtZoom: { samplesPerPixel: SPP, scrollSample: 0 },
    mtPlayState: 'stopped',
    mtPlayheadSample: 0,
    mtEnvelope: null,
  });
  tId = t.id;
  uId = u.id;
  u1 = clipU1.id;
  u2 = clipU2.id;
  void uId;
});

describe('the sweep (J7) — FAILS TODAY: no range gesture exists before this lot', () => {
  it('Shift+press at lane x 200, move to lane x 700, release: writes the range those x resolve to', () => {
    const { overlay, lanes } = renderView();

    firePointer(lanes[0], 'pointerdown', { clientX: atLaneX(200), clientY: 50, shiftKey: true });
    firePointer(overlay, 'pointermove', { clientX: atLaneX(700), clientY: 50, shiftKey: true });
    firePointer(overlay, 'pointerup', { clientX: atLaneX(700), clientY: 50, shiftKey: true });

    expect(store().mtTimeRange).toEqual({ startSample: 40_000, endSample: 140_000 });
    const band = screen.getByTestId('mt-time-range');
    expect(band.style.width).not.toBe('0px');
    expect(parseFloat(band.style.width)).toBeGreaterThan(0);
  });
});

describe('the drag threshold (X3, same MARQUEE_DRAG_THRESHOLD_PX = 4 lot K uses)', () => {
  it('a 3 px move writes nothing (a standing range survives); continuing to 5 px replaces it', () => {
    const { overlay, lanes } = renderView();
    act(() => store().setMtTimeRange({ startSample: 40_000, endSample: 130_000 }));

    firePointer(lanes[0], 'pointerdown', { clientX: atLaneX(1000), clientY: 50, shiftKey: true });
    firePointer(overlay, 'pointermove', { clientX: atLaneX(1000) + 3, clientY: 50, shiftKey: true }); // 3 px
    expect(store().mtTimeRange).toEqual({ startSample: 40_000, endSample: 130_000 }); // untouched

    firePointer(overlay, 'pointermove', { clientX: atLaneX(1000) + 5, clientY: 50, shiftKey: true }); // 5 px total
    expect(store().mtTimeRange).toEqual({ startSample: 200_000, endSample: 201_000 }); // replaced
  });
});

describe('Shift press-and-release with NO movement (row 9 — J owns the click-away commit)', () => {
  it('clears a standing range AND a standing two-clip selection', () => {
    const { overlay, lanes } = renderView();
    act(() => {
      store().setMtTimeRange({ startSample: 10_000, endSample: 20_000 });
      store().setSelectedClips([u1, u2]);
    });
    expect(store().selectedClipIds).toEqual([u1, u2]);

    firePointer(lanes[0], 'pointerdown', { clientX: atLaneX(300), clientY: 50, shiftKey: true });
    firePointer(overlay, 'pointerup', { clientX: atLaneX(300), clientY: 50, shiftKey: true });

    expect(store().mtTimeRange).toBeNull();
    expect(store().selectedClipIds).toEqual([]);
  });
});

describe('a plain (no-modifier) drag is lot K’s marquee, not a sweep', () => {
  it('writes no range', () => {
    const { overlay, lanes } = renderView();
    act(() => store().setMtTimeRange({ startSample: 5_000, endSample: 6_000 }));

    firePointer(lanes[0], 'pointerdown', { clientX: atLaneX(300), clientY: 50 });
    firePointer(overlay, 'pointermove', { clientX: atLaneX(800), clientY: 50 });
    firePointer(overlay, 'pointerup', { clientX: atLaneX(800), clientY: 50 });

    expect(store().mtTimeRange).toEqual({ startSample: 5_000, endSample: 6_000 }); // untouched
  });
});

describe('Alt suspends the magnet mid-drag', () => {
  it('the committed endSample is the raw pointer sample, not the clip edge 900 samples away', () => {
    const { overlay, lanes } = renderView();

    // Anchor at sample 200_000 (lane x 1000) — nowhere near any snap target.
    firePointer(lanes[0], 'pointerdown', {
      clientX: atLaneX(1000),
      clientY: 50,
      shiftKey: true,
      altKey: true,
    });
    // Moving edge at raw sample 900_000 (lane x 4_500) — 900 samples short of
    // the seeded clip's own start edge (900_900), well inside the 1_600-
    // sample tolerance at this zoom, so WITHOUT Alt this would snap onto it.
    firePointer(overlay, 'pointermove', {
      clientX: atLaneX(4_500),
      clientY: 50,
      shiftKey: true,
      altKey: true,
    });

    expect(store().mtTimeRange).toEqual({ startSample: 200_000, endSample: 900_000 });
  });
});

describe('the sweep never writes mtCursorSample', () => {
  it('leaves the seeded cursor exactly where it was', () => {
    const { overlay, lanes } = renderView();

    firePointer(lanes[0], 'pointerdown', { clientX: atLaneX(200), clientY: 50, shiftKey: true });
    firePointer(overlay, 'pointermove', { clientX: atLaneX(700), clientY: 50, shiftKey: true });
    firePointer(overlay, 'pointerup', { clientX: atLaneX(700), clientY: 50, shiftKey: true });

    expect(store().mtCursorSample).toBe(CURSOR_SEED);
  });
});

describe('pointercancel mid-drag', () => {
  it('leaves the last-moved range standing and paints no marquee rectangle', () => {
    const { overlay, lanes } = renderView();

    firePointer(lanes[0], 'pointerdown', { clientX: atLaneX(200), clientY: 50, shiftKey: true });
    firePointer(overlay, 'pointermove', { clientX: atLaneX(700), clientY: 50, shiftKey: true });
    expect(store().mtTimeRange).toEqual({ startSample: 40_000, endSample: 140_000 });
    expect(screen.queryByTestId('mt-marquee')).toBeNull();

    firePointer(overlay, 'pointercancel', { clientX: atLaneX(700), clientY: 50, shiftKey: true });

    expect(store().mtTimeRange).toEqual({ startSample: 40_000, endSample: 140_000 }); // unchanged by the cancel
    expect(screen.queryByTestId('mt-marquee')).toBeNull();
    expect(screen.getByTestId('mt-time-range')).not.toBeNull(); // the band stays painted
  });
});

// F1 fix round 1 — CONFIRMED BUG: `onScrollerScroll` was not gated on
// `rec.mode`, so a plain-wheel vertical scroll mid-sweep (past the threshold)
// repainted lot K's own rubber-band rectangle from `rec.anchorSample` and left
// it standing until pointerup, violating contract row 9's "Shift draws no
// rubber-band" rule.
describe('a plain scroll mid-sweep (F1 fix round 1)', () => {
  it('does not paint the marquee rectangle', () => {
    const { overlay, lanes, scroller } = renderView();

    firePointer(lanes[0], 'pointerdown', { clientX: atLaneX(200), clientY: 50, shiftKey: true });
    firePointer(overlay, 'pointermove', { clientX: atLaneX(700), clientY: 50, shiftKey: true });
    expect(store().mtTimeRange).toEqual({ startSample: 40_000, endSample: 140_000 });
    expect(screen.queryByTestId('mt-marquee')).toBeNull();

    act(() => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    expect(screen.queryByTestId('mt-marquee')).toBeNull(); // still no rubber-band
    expect(screen.getByTestId('mt-time-range')).not.toBeNull(); // the band is unaffected
  });
});
