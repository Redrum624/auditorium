/**
 * K1/K4/K5/K6/X6 — the marquee, WIRED: a real press+drag over the real
 * `MultitrackView`, against a real multi-track, multi-clip session.
 *
 * Fixture (the brief's own, X3 — no identity values): SR = 44_100,
 * samplesPerPixel = 100, scrollSample = 0; three tracks — `A` with
 * `a1 [40 000, 60 000)`, `B` with `b1 [100 000, 130 000)` and
 * `b2 [200 000, 210 000)`, `C` with `c1 [45 000, 60 000)`. Client x is
 * `MT_HEADER_W + laneX` (the `atLaneX` idiom of
 * `MultitrackView.cursorHandle.test.tsx:70`); row rects are stubbed per row
 * div (`TrackLane.gaps.test.tsx:113-128`'s technique, applied to the ROW
 * elements `MultitrackView` renders, not the lane) at real layout numbers —
 * `LANE_H = 96`, a 10 px inter-row gutter: A [0, 96), B [106, 202),
 * C [212, 308).
 */
import { act, render, screen } from '@testing-library/react';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { createClip, createTrack, type Session } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
import { _resetSessionUndo } from '../../multitrack/sessionUndo';
import { MT_HEADER_W } from '../../multitrack/sessionViewport';
import { makeInitialState, useAppStore } from '../../stores/appStore';
import MultitrackView from './MultitrackView';

const SR = 44_100;
const SPP = 100;

const store = () => useSessionStore.getState();

/** jsdom has no window.PointerEvent; a real MouseEvent (which carries
 * clientX/Y and the modifier keys) stands in, exactly as
 * `MultitrackView.cursorHandle.test.tsx`'s own `firePointer` does. */
function firePointer(
  element: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  init: { clientX: number; clientY: number; ctrlKey?: boolean; shiftKey?: boolean }
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY,
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
    button: 0,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    element.dispatchEvent(event);
  });
}

function fireDblClick(element: Element, clientX: number, clientY: number): void {
  const event = new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX, clientY, button: 0 });
  act(() => {
    element.dispatchEvent(event);
  });
}

/** The wrapper's rect is all zeros in jsdom, so a lane-relative x maps to
 * clientX by the same header offset the component adds — the idiom
 * `MultitrackView.cursorHandle.test.tsx:69` establishes. */
const atLaneX = (x: number): number => MT_HEADER_W + x;

let doc: AudioDocument;
let aId: string, bId: string, cId: string; // track ids, in session order
let a1: string, b1: string, b2: string, c1: string; // clip ids

/** Gives each ROW div (`MultitrackView`'s own `data-track-id` wrapper, NOT
 * the lane nested inside it) a real border box in SCROLLER CONTENT Y — jsdom
 * answers 0 for everything otherwise, which is exactly the identity C5/X3
 * flags. Real layout numbers: `LANE_H = 96`, a 10 px inter-row gutter. */
function placeRows(container: HTMLElement): void {
  const rows = Array.from(container.querySelectorAll('.glass-track-row'));
  const bands = [
    { top: 0, bottom: 96 },
    { top: 106, bottom: 202 },
    { top: 212, bottom: 308 },
  ];
  rows.forEach((row, i) => {
    const b = bands[i];
    (row as HTMLElement).getBoundingClientRect = () =>
      ({
        left: 0,
        x: 0,
        right: 1600,
        top: b.top,
        y: b.top,
        bottom: b.bottom,
        width: 1600,
        height: b.bottom - b.top,
        toJSON: () => ({}),
      }) as DOMRect;
  });
}

/** `TrackLane`'s own `laneSample` (D3's press-inside-the-gap-band exception)
 * measures `clientX - e.currentTarget.getBoundingClientRect().left` on the
 * LANE element itself — a SEPARATE geometry read from the marquee's own
 * `laneXAtClientX` (overlay rect minus `HEADER_W`). In the real app the two
 * agree because the lane's rect naturally starts after the header column; in
 * jsdom, where every unstubbed rect is all-zero, they would silently
 * disagree unless the lane is ALSO given a real left edge here. */
function placeLanes(lanes: HTMLElement[]): void {
  for (const lane of lanes) {
    lane.getBoundingClientRect = () =>
      ({
        left: MT_HEADER_W,
        x: MT_HEADER_W,
        right: MT_HEADER_W + 1600,
        top: 0,
        y: 0,
        bottom: 96,
        width: 1600,
        height: 96,
        toJSON: () => ({}),
      }) as DOMRect;
  }
}

function renderView(): {
  container: HTMLElement;
  lanes: HTMLElement[];
  overlay: HTMLElement;
  scroller: HTMLElement;
} {
  const { container } = render(<MultitrackView />);
  placeRows(container);
  const lanes = Array.from(container.querySelectorAll('[data-testid="track-lane"]')) as HTMLElement[];
  placeLanes(lanes);
  const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
  const overlay = scroller.parentElement as HTMLElement;
  return { container, lanes, overlay, scroller };
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  _resetSessionUndo();
  doc = createDocument({ name: 'src.wav', sampleRate: SR, channels: [new Float32Array(400_000)] });
  useAppStore.getState().addDocument(doc);

  const tA = createTrack('A');
  const tB = createTrack('B');
  const tC = createTrack('C');
  const clipA1 = createClip({ documentId: doc.id, startSample: 40_000, offsetSample: 0, lengthSample: 20_000 });
  const clipB1 = createClip({ documentId: doc.id, startSample: 100_000, offsetSample: 0, lengthSample: 30_000 });
  const clipB2 = createClip({ documentId: doc.id, startSample: 200_000, offsetSample: 0, lengthSample: 10_000 });
  const clipC1 = createClip({ documentId: doc.id, startSample: 45_000, offsetSample: 0, lengthSample: 15_000 });
  tA.clips = [clipA1];
  tB.clips = [clipB1, clipB2];
  tC.clips = [clipC1];
  const session: Session = { name: 'Marquee Fixture', sampleRate: SR, tracks: [tA, tB, tC] };
  useSessionStore.setState({
    session,
    selectedClipId: null,
    selectedClipIds: [],
    selectedGap: null,
    currentTrackId: null,
    lastSplit: null,
    mtCursorSample: 0,
    mtZoom: { samplesPerPixel: SPP, scrollSample: 0 },
    mtPlayState: 'stopped',
    mtPlayheadSample: 0,
    mtEnvelope: null,
  });
  aId = tA.id;
  bId = tB.id;
  cId = tC.id;
  a1 = clipA1.id;
  b1 = clipB1.id;
  b2 = clipB2.id;
  c1 = clipC1.id;
  void aId; // kept for symmetry with b/c; no test names track A's own id
});

describe('the marquee (K1) — FAILS TODAY: nothing happens at all before this lot', () => {
  it('sweeps rows B and C and selects every clip they touch, seating the topmost/earliest as primary', () => {
    const { overlay, lanes } = renderView();

    // Row B, inside c1's horizontal span but past a1's end (39_998 samples
    // past it — a1 must be excluded on the VERTICAL test, not by coincidence
    // of the horizontal one).
    firePointer(lanes[1], 'pointerdown', { clientX: atLaneX(470), clientY: 150 }); // sample 47_000, row B
    firePointer(overlay, 'pointermove', { clientX: atLaneX(2050), clientY: 250 }); // sample 205_000, row C
    firePointer(overlay, 'pointerup', { clientX: atLaneX(2050), clientY: 250 });

    expect(new Set(store().selectedClipIds)).toEqual(new Set([b1, b2, c1]));
    expect(store().selectedClipIds).toHaveLength(3);
    expect(store().selectedClipId).toBe(b1); // topmost track (B), earliest start
  });
});

describe('the drag threshold (X3, MARQUEE_DRAG_THRESHOLD_PX = 4)', () => {
  it('a 3 px drag writes no selection and leaves a standing gap alone', () => {
    const { overlay, lanes } = renderView();
    // Track C's own LEADING gap, [0, 45_000) — before c1. The press below
    // lands INSIDE this gap's own span, on its own lane, which is the D3
    // exception (`TrackLane.tsx`'s own onPointerDown) that keeps a plain
    // press from clearing the very band it might be the first half of
    // re-selecting; a standing gap on some OTHER track/span would be cleared
    // by that unrelated, pre-existing rule regardless of what the marquee
    // does, which would make this assertion pass for the wrong reason.
    act(() => {
      store().setSelectedGap({ trackId: cId, startSample: 0, endSample: 45_000 });
    });

    firePointer(lanes[2], 'pointerdown', { clientX: atLaneX(300), clientY: 250 }); // sample 30_000, inside the gap
    firePointer(overlay, 'pointermove', { clientX: atLaneX(303), clientY: 250 }); // 3 px
    firePointer(overlay, 'pointerup', { clientX: atLaneX(303), clientY: 250 });

    expect(store().selectedClipIds).toEqual([]);
    expect(store().selectedGap).toEqual({ trackId: cId, startSample: 0, endSample: 45_000 });
  });

  it('a 5 px drag commits', () => {
    const { overlay, lanes } = renderView();

    firePointer(lanes[2], 'pointerdown', { clientX: atLaneX(450), clientY: 250 }); // sample 45_000, row C, inside c1
    firePointer(overlay, 'pointermove', { clientX: atLaneX(455), clientY: 250 }); // 5 px
    firePointer(overlay, 'pointerup', { clientX: atLaneX(455), clientY: 250 });

    expect(store().selectedClipIds).toEqual([c1]);
    expect(store().selectedClipId).toBe(c1);
  });
});

describe('K5 — Ctrl unions with the standing set', () => {
  it("with b2 selected, Ctrl-drag over a1 makes the set ['b2', 'a1'] and keeps b2 primary", () => {
    const { overlay, lanes } = renderView();
    act(() => {
      store().setSelectedClip(b2);
    });

    firePointer(lanes[0], 'pointerdown', {
      clientX: atLaneX(410), // sample 41_000, row A
      clientY: 50,
      ctrlKey: true,
    });
    firePointer(overlay, 'pointermove', { clientX: atLaneX(590), clientY: 50, ctrlKey: true }); // sample 59_000
    firePointer(overlay, 'pointerup', { clientX: atLaneX(590), clientY: 50, ctrlKey: true });

    expect(store().selectedClipIds).toEqual([b2, a1]);
    expect(store().selectedClipId).toBe(b2); // the standing primary survives
  });
});

describe('X6 — the deferred clear, committed on release (TrackLane defers it at pointerdown)', () => {
  it('a Ctrl press-and-release with NO movement still clears the whole selection', () => {
    const { overlay, lanes } = renderView();
    act(() => {
      store().setSelectedClip(b1);
      store().toggleSelectedClip(b2);
    });
    expect(store().selectedClipIds).toEqual([b1, b2]);

    // Empty background on track B, left of b1 — not a click on any clip.
    firePointer(lanes[1], 'pointerdown', { clientX: atLaneX(300), clientY: 150, ctrlKey: true });
    firePointer(overlay, 'pointerup', { clientX: atLaneX(300), clientY: 150, ctrlKey: true });

    expect(store().selectedClipIds).toEqual([]);
    expect(store().selectedClipId).toBeNull();
  });

  // Fix round 2 (BLOCKER 1/2) — this is the exact regression the coordinator
  // found: `onOverlayPointerDownCapture` used to bail on `mode === 'range'`
  // BEFORE writing any record at all, so `onOverlayPointerUp`'s deferred
  // clear never ran for Shift, even though `TrackLane.tsx` skips ITS OWN
  // clear under Shift too — nothing was left to do the clearing.
  // `USER_GUIDE.md:1720` was false for exactly this gesture.
  it('a Shift press-and-release with NO movement still clears the whole selection', () => {
    const { overlay, lanes } = renderView();
    act(() => {
      store().setSelectedClip(b1);
      store().toggleSelectedClip(b2);
    });
    expect(store().selectedClipIds).toEqual([b1, b2]);

    firePointer(lanes[1], 'pointerdown', { clientX: atLaneX(300), clientY: 150, shiftKey: true });
    firePointer(overlay, 'pointerup', { clientX: atLaneX(300), clientY: 150, shiftKey: true });

    expect(store().selectedClipIds).toEqual([]);
    expect(store().selectedClipId).toBeNull();
  });

  it('a Ctrl+Shift press-and-release with NO movement still clears the whole selection', () => {
    const { overlay, lanes } = renderView();
    act(() => {
      store().setSelectedClip(b1);
      store().toggleSelectedClip(b2);
    });
    expect(store().selectedClipIds).toEqual([b1, b2]);

    firePointer(lanes[1], 'pointerdown', {
      clientX: atLaneX(300),
      clientY: 150,
      ctrlKey: true,
      shiftKey: true,
    });
    firePointer(overlay, 'pointerup', {
      clientX: atLaneX(300),
      clientY: 150,
      ctrlKey: true,
      shiftKey: true,
    });

    expect(store().selectedClipIds).toEqual([]);
    expect(store().selectedClipId).toBeNull();
  });
});

// Fix round 2 (item 6, MINOR — the gutter asymmetry). On a LANE, plain and
// Ctrl/Shift click-away both end up clearing (TrackLane clears immediately
// for plain; the marquee's own deferred clear covers Ctrl/Shift), so the
// outcome looks modifier-independent from the outside. On the SCROLLER
// gutter there is no `TrackLane` at all, so the marquee's own `deferredClear`
// is the ONLY thing that can ever clear a gutter press — and it must
// therefore take the OPPOSITE condition from the lane's: plain clears
// (matching "click empty space to deselect"), Ctrl/Shift does not (Ctrl is
// the ADD modifier and must not destroy a selection it was never asked to
// touch).
describe('the gutter (scroller background) is consistent with the lane, by an inverted rule', () => {
  it('a PLAIN gutter click clears the whole selection', () => {
    const { overlay, scroller } = renderView();
    act(() => {
      store().setSelectedClip(b1);
      store().toggleSelectedClip(b2);
    });
    expect(store().selectedClipIds).toEqual([b1, b2]);

    firePointer(scroller, 'pointerdown', { clientX: atLaneX(300), clientY: 150 });
    firePointer(overlay, 'pointerup', { clientX: atLaneX(300), clientY: 150 });

    expect(store().selectedClipIds).toEqual([]);
    expect(store().selectedClipId).toBeNull();
  });

  it('a Ctrl gutter click does NOT clear', () => {
    const { overlay, scroller } = renderView();
    act(() => {
      store().setSelectedClip(b1);
      store().toggleSelectedClip(b2);
    });
    expect(store().selectedClipIds).toEqual([b1, b2]);

    firePointer(scroller, 'pointerdown', { clientX: atLaneX(300), clientY: 150, ctrlKey: true });
    firePointer(overlay, 'pointerup', { clientX: atLaneX(300), clientY: 150, ctrlKey: true });

    expect(store().selectedClipIds).toEqual([b1, b2]);
  });

  // Fix round 3, item 4(b) — honesty label. This is a PIN, not evidence: the
  // PRE-fix-round-2 code (which bailed on `mode === 'range'` before writing
  // any record at all) also left `[b1, b2]` untouched here, for an unrelated
  // reason (nothing ran, full stop) that happens to coincide with the rule
  // this test names ("Shift-gutter specifically does not clear"). A revert
  // of THIS test's own production line (the gutter's inverted `deferredClear`
  // formula) would not turn it red on its own — only reverting fix round 2's
  // Shift-record fix together with it would. Kept anyway because the OUTCOME
  // it states is still a real, load-bearing fact about the shipped behaviour.
  it('a Shift gutter click does NOT clear either (PIN — see the comment above; not independently discriminating)', () => {
    const { overlay, scroller } = renderView();
    act(() => {
      store().setSelectedClip(b1);
      store().toggleSelectedClip(b2);
    });
    expect(store().selectedClipIds).toEqual([b1, b2]);

    firePointer(scroller, 'pointerdown', { clientX: atLaneX(300), clientY: 150, shiftKey: true });
    firePointer(overlay, 'pointerup', { clientX: atLaneX(300), clientY: 150, shiftKey: true });

    expect(store().selectedClipIds).toEqual([b1, b2]);
  });

  // Fix round 3, item 3 — the gutter has no `TrackLane` to run its own
  // unconditional gap-clear (`TrackLane.tsx`'s D3 block), so before this fix
  // a plain gutter click dropped the clip selection but left a selected gap
  // painted: two click-away surfaces, two different outcomes, exactly the
  // asymmetry item 6 existed to remove.
  it('a PLAIN gutter click also clears a standing gap band', () => {
    const { overlay, scroller } = renderView();
    act(() => {
      store().setSelectedGap({ trackId: bId, startSample: 130_000, endSample: 200_000 });
    });

    firePointer(scroller, 'pointerdown', { clientX: atLaneX(300), clientY: 150 });
    firePointer(overlay, 'pointerup', { clientX: atLaneX(300), clientY: 150 });

    expect(store().selectedGap).toBeNull();
  });
});

// Fix round 3, item 4(c) — renamed. K DOES write a record under Shift now
// (fix round 2, X6): the stale title claimed K "starts no gesture under it"
// at all, which stopped being true the moment the Shift blocker was fixed.
// What is still true, and what this block actually pins, is narrower: Shift
// draws no RUBBER-BAND rectangle and commits no CLIP SELECTION — the sweep
// itself (whatever lot J draws and selects) is not K's to build.
describe('J7 — Shift draws no rubber-band and commits no clip selection; the sweep itself is lot J’s', () => {
  it('a Shift-drag across a1 and c1 selects nothing and leaves the standing selection alone', () => {
    const { overlay, lanes } = renderView();
    act(() => {
      store().setSelectedClip(b2);
    });

    firePointer(lanes[0], 'pointerdown', { clientX: atLaneX(410), clientY: 50, shiftKey: true }); // row A
    firePointer(overlay, 'pointermove', { clientX: atLaneX(590), clientY: 250, shiftKey: true }); // row C
    expect(screen.queryByTestId('mt-marquee')).toBeNull();
    firePointer(overlay, 'pointerup', { clientX: atLaneX(590), clientY: 250, shiftKey: true });

    expect(store().selectedClipIds).toEqual([b2]);
    expect(store().selectedClipId).toBe(b2);
  });
});

describe('pointercancel (T1’s written precedent — a cancelled gesture commits nothing)', () => {
  it('a cancel mid-drag writes no selection and removes the drawn rectangle', () => {
    const { overlay, lanes } = renderView();
    act(() => {
      store().setSelectedClip(b2);
    });

    // Ctrl held throughout: TrackLane's own pointerdown DEFERS its clear
    // under Ctrl/Shift (X6), so the standing [b2] selection survives the
    // PRESS itself — isolating this assertion to what the CANCELLED drag
    // does (nothing) rather than conflating it with the unrelated, always-on
    // "a plain press clears the selection" rule.
    firePointer(lanes[1], 'pointerdown', { clientX: atLaneX(470), clientY: 150, ctrlKey: true });
    firePointer(overlay, 'pointermove', { clientX: atLaneX(2050), clientY: 250, ctrlKey: true });
    expect(screen.queryByTestId('mt-marquee')).not.toBeNull();

    firePointer(overlay, 'pointercancel', { clientX: atLaneX(2050), clientY: 250, ctrlKey: true });

    expect(screen.queryByTestId('mt-marquee')).toBeNull();
    expect(store().selectedClipIds).toEqual([b2]);
  });
});

// Fix round 2 (item 8, LOW) — a captured element that UNMOUNTS mid-drag (a
// track removed by shortcut) can never deliver `pointercancel` to
// `onOverlayPointerCancel`: a detached element has no ancestor chain left to
// bubble through. `MultitrackView`'s own `useEffect` watching `session`
// (keyed off `rec.targetEl.isConnected`) is the only thing that can catch
// this.
describe('the captured lane unmounting mid-drag (fix round 2, item 8)', () => {
  it('a track removed while its lane holds pointer capture tears the gesture down', () => {
    const { overlay, lanes } = renderView();

    firePointer(lanes[1], 'pointerdown', { clientX: atLaneX(470), clientY: 150 }); // row B
    firePointer(overlay, 'pointermove', { clientX: atLaneX(2050), clientY: 250 }); // row C — exceeds
    expect(screen.queryByTestId('mt-marquee')).not.toBeNull();

    // Simulates the track being deleted mid-drag: the lane that holds
    // capture is unmounted. No `pointercancel` can reach the overlay for it.
    act(() => {
      store().removeTrack(bId);
    });

    expect(screen.queryByTestId('mt-marquee')).toBeNull();

    // The torn-down gesture leaves no stale record: a fresh press elsewhere
    // behaves exactly like the very first press of the test would have.
    firePointer(lanes[0], 'pointerdown', { clientX: atLaneX(410), clientY: 50 });
    firePointer(overlay, 'pointerup', { clientX: atLaneX(410), clientY: 50 });
    expect(store().currentTrackId).toBe(aId);
  });
});

describe('the drawn rectangle (mt-marquee)', () => {
  it('is absent below the threshold and present once it is exceeded', () => {
    const { overlay, lanes } = renderView();

    firePointer(lanes[1], 'pointerdown', { clientX: atLaneX(470), clientY: 150 });
    firePointer(overlay, 'pointermove', { clientX: atLaneX(473), clientY: 150 }); // 3 px
    expect(screen.queryByTestId('mt-marquee')).toBeNull();

    firePointer(overlay, 'pointermove', { clientX: atLaneX(475), clientY: 150 }); // 5 px total
    expect(screen.queryByTestId('mt-marquee')).not.toBeNull();
  });
});

describe('the zero-hit sweep and a standing gap', () => {
  it('a committed sweep that hits nothing still clears a standing gap', () => {
    const { overlay, lanes } = renderView();
    act(() => {
      store().setSelectedGap({ trackId: bId, startSample: 130_000, endSample: 200_000 });
    });

    // Row A, sample 70_000..80_000 — well clear of a1 [40_000, 60_000).
    firePointer(lanes[0], 'pointerdown', { clientX: atLaneX(700), clientY: 50 });
    firePointer(overlay, 'pointermove', { clientX: atLaneX(800), clientY: 50 });
    firePointer(overlay, 'pointerup', { clientX: atLaneX(800), clientY: 50 });

    expect(store().selectedClipIds).toEqual([]);
    expect(store().selectedGap).toBeNull();
  });
});

describe('risk 4 — a header control press starts no marquee (the positive target test)', () => {
  it('pressing the volume slider, then moving past the threshold over the lanes, draws nothing', () => {
    const { container, overlay } = renderView();
    const volumeInput = container.querySelector('input[aria-label="Volume (dB)"]') as HTMLElement;
    expect(volumeInput).not.toBeNull();

    firePointer(volumeInput, 'pointerdown', { clientX: atLaneX(0) - 50, clientY: 20 });
    firePointer(overlay, 'pointermove', { clientX: atLaneX(500), clientY: 20 });

    expect(screen.queryByTestId('mt-marquee')).toBeNull();
  });
});

describe('risk 1 — the capture-phase gate does not disturb the gap double-click', () => {
  // Fix round 2 (item 4) — the ORIGINAL version of this test fired a bare
  // `dblclick` with no preceding `pointerdown` at all, so
  // `onOverlayPointerDownCapture` never ran. This version dispatches the
  // REAL sequence a double-click is — two full sub-threshold press/release
  // cycles, THEN the native `dblclick` — so the capture-phase gate genuinely
  // takes and releases pointer capture on the lane twice before the
  // double-click resolves, exercising the actual code path.
  //
  // Fix round 3, item 4(a) — HONESTY CORRECTION on what this proves. It does
  // NOT and CANNOT prove the retargeting hazard is safe: jsdom implements no
  // event retargeting under pointer capture, so this test would pass
  // identically even if capture were taken on `overlayRef` instead of
  // `e.target` — there is no jsdom mechanism that could turn it red for that
  // regression. What it DOES prove is narrower and real: that installing the
  // capture-phase gate (`onOverlayPointerDownCapture`, taking and releasing
  // capture on the lane twice) does not itself disturb `TrackLane`'s
  // `onDoubleClick` resolution — no swallowed event, no `e.target` corrupted
  // by THIS code's own doing.
  //
  // The retargeting hazard itself is SETTLED, by two independent facts, not
  // by this test: (1) capture is taken on `e.target`, which for a gap
  // double-click IS the lane element carrying `onDoubleClick` — retargeting
  // to "the element capture was taken on" is an identity operation for this
  // specific gesture, whichever way Blink implements it; (2) the packaged
  // Playwright smoke (run against real Chromium, not jsdom) exercised the
  // full D3 gap flow — select, Escape, Delete, Ctrl+Z — and passed. Do not
  // re-open this as a jsdom problem; it structurally cannot be one.
  it('two real sub-threshold press/release cycles, then the native dblclick, still select the gap', () => {
    const { lanes } = renderView();
    // Track B's leading gap: [0, 100_000) — before b1.
    const x = atLaneX(500); // sample 50_000, inside the leading gap
    const y = 150;

    firePointer(lanes[1], 'pointerdown', { clientX: x, clientY: y });
    firePointer(lanes[1], 'pointerup', { clientX: x, clientY: y });
    firePointer(lanes[1], 'pointerdown', { clientX: x, clientY: y });
    firePointer(lanes[1], 'pointerup', { clientX: x, clientY: y });
    fireDblClick(lanes[1], x, y);

    expect(store().selectedGap).toEqual({ trackId: bId, startSample: 0, endSample: 100_000 });
  });
});
