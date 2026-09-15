import { act, render } from '@testing-library/react';
import Toolbar from './Toolbar';
import { createDocument } from '../../audio/AudioDocument';
import { playbackEngine } from '../../audio/PlaybackEngine';
import { multitrackPlayer } from '../../multitrack/MultitrackPlayer';
import { applyEditorZoom, makeInitialState, useAppStore } from '../../stores/appStore';
import { applySessionZoom, useSessionStore } from '../../multitrack/sessionStore';
import {
  _resetEditorLaneWidth,
  setEditorLaneWidth,
} from '../../services/editorViewport';
import {
  _resetSessionLaneWidth,
  setSessionLaneWidth,
} from '../../multitrack/sessionViewport';

/**
 * A1-A6 — the wiring: both rAF pumps in `Toolbar.tsx` consult
 * `playheadFollow.ts` and write the viewport when the playhead leaves it.
 *
 * The rAF callback is CAPTURED, not stubbed to a no-op, so a test can invoke
 * exactly one tick inside `act` and inspect what it wrote — the pattern
 * `Toolbar.test.tsx:204-237` uses a no-op stub for is insufficient here
 * because these tests need the tick's own body to run.
 */

/** A 20 s / 44.1 kHz stereo document — long enough that a 900 px lane at
 * spp 256 (230400 samples wide) sits well inside it, on both sides. */
function make20sDoc() {
  const length = 20 * 44100; // 882000
  return createDocument({
    name: 'twenty.wav',
    sampleRate: 44100,
    channels: [new Float32Array(length), new Float32Array(length)],
  });
}

type Tick = (time: number) => void;

/** Stubs requestAnimationFrame to CAPTURE the latest callback registered
 * instead of running it, and cancelAnimationFrame to a no-op. Returns a
 * getter for the captured callback and a restore function. */
function captureRaf(): { getTick: () => Tick | null; restore: () => void } {
  const origRaf = globalThis.requestAnimationFrame;
  const origCaf = globalThis.cancelAnimationFrame;
  let captured: Tick | null = null;
  let id = 0;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    captured = cb as Tick;
    return ++id;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;
  return {
    getTick: () => captured,
    restore: () => {
      globalThis.requestAnimationFrame = origRaf;
      globalThis.cancelAnimationFrame = origCaf;
    },
  };
}

describe('Toolbar — playhead follow wiring (both pumps)', () => {
  beforeEach(() => {
    useAppStore.setState(makeInitialState());
    useSessionStore.getState().newSession(44100);
    _resetEditorLaneWidth();
    _resetSessionLaneWidth();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    useAppStore.setState(makeInitialState());
    useSessionStore.getState().newSession(44100);
    _resetEditorLaneWidth();
    _resetSessionLaneWidth();
  });

  it('editor: a playhead past the right edge pages the view over, and leaves the cursor alone (A1/A6) — FAILS TODAY', () => {
    setEditorLaneWidth(900);
    const doc = make20sDoc();
    useAppStore.getState().addDocument(doc);
    applyEditorZoom({ samplesPerPixel: 256, scrollSample: 100000 });
    useAppStore.getState().setPlayback({ state: 'playing' });
    useAppStore.setState({ cursorSample: 123456 });

    const posSpy = jest.spyOn(playbackEngine, 'getPositionSample').mockReturnValue(400000);
    const raf = captureRaf();

    const { unmount } = render(<Toolbar />);
    const tick = raf.getTick();
    expect(tick).not.toBeNull();

    act(() => tick!(0));

    const zoom = useAppStore.getState().zoom;
    expect(zoom.scrollSample).toBe(400000);
    expect(zoom.samplesPerPixel).toBe(256);
    expect(useAppStore.getState().cursorSample).toBe(123456);

    unmount();
    raf.restore();
    posSpy.mockRestore();
  });

  it('editor: the last page clamps instead of scrolling past the end of the document', () => {
    setEditorLaneWidth(900);
    const doc = make20sDoc();
    useAppStore.getState().addDocument(doc);
    applyEditorZoom({ samplesPerPixel: 256, scrollSample: 100000 });
    useAppStore.getState().setPlayback({ state: 'playing' });
    useAppStore.setState({ cursorSample: 123456 });

    const posSpy = jest.spyOn(playbackEngine, 'getPositionSample').mockReturnValue(800000);
    const raf = captureRaf();

    const { unmount } = render(<Toolbar />);
    const tick = raf.getTick();
    expect(tick).not.toBeNull();

    act(() => tick!(0));

    // 882000 (doc length) - 900 * 256 (the lane at this zoom) = 651600: the
    // playhead lands mid-lane, not teleported past the document's own end.
    expect(useAppStore.getState().zoom.scrollSample).toBe(651600);

    unmount();
    raf.restore();
    posSpy.mockRestore();
  });

  it('multitrack: a playhead past the right edge pages the view over, and leaves the cursor alone (A1/A6) — FAILS TODAY', () => {
    setSessionLaneWidth(900);
    applySessionZoom({ samplesPerPixel: 256, scrollSample: 100000 });
    useAppStore.getState().setView('multitrack');
    useSessionStore.getState().setMtPlayState('playing');
    useSessionStore.setState({ mtCursorSample: 123456 });

    const posSpy = jest.spyOn(multitrackPlayer, 'getPositionSample').mockReturnValue(400000);
    const raf = captureRaf();

    const { unmount } = render(<Toolbar />);
    const tick = raf.getTick();
    expect(tick).not.toBeNull();

    act(() => tick!(0));

    const mtZoom = useSessionStore.getState().mtZoom;
    expect(mtZoom.scrollSample).toBe(400000);
    expect(useSessionStore.getState().mtCursorSample).toBe(123456);

    unmount();
    raf.restore();
    posSpy.mockRestore();
  });

  it('removes the pointer-activity listeners on unmount (4 add/remove pairs, same function references)', () => {
    setEditorLaneWidth(900);
    const doc = make20sDoc();
    useAppStore.getState().addDocument(doc);
    applyEditorZoom({ samplesPerPixel: 256, scrollSample: 100000 });
    useAppStore.getState().setPlayback({ state: 'playing' });

    const raf = captureRaf();
    const addSpy = jest.spyOn(window, 'addEventListener');
    const removeSpy = jest.spyOn(window, 'removeEventListener');

    const { unmount } = render(<Toolbar />);

    const pointerEvents = ['pointerdown', 'pointerup', 'pointercancel', 'blur'];
    const added = addSpy.mock.calls.filter(([type]) => pointerEvents.includes(type as string));
    expect(added).toHaveLength(4);

    unmount();

    const removed = removeSpy.mock.calls.filter(([type]) => pointerEvents.includes(type as string));
    expect(removed).toHaveLength(4);
    for (const [type, handler] of added) {
      expect(
        removed.some(([rType, rHandler]) => rType === type && rHandler === handler)
      ).toBe(true);
    }

    raf.restore();
  });
});
