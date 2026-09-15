/**
 * K2/K3 — a plain press on ANY visible part of a track's background makes
 * that track the CURRENT track, and the current track wears a lighter lane
 * background. Rendered standalone (as `TrackLane.gaps.test.tsx` and
 * `TrackLane.selection.test.tsx` already do), against a multi-track session
 * so "index 1, not 0" cannot pass by coincidence (X3).
 */
import { act, render } from '@testing-library/react';
import { createClip, createTrack, type Session, type Track } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
import TrackLane from './TrackLane';

const SR = 44_100;
const SPP = 100;

const store = () => useSessionStore.getState();

function press(element: Element, opts: { ctrlKey?: boolean; shiftKey?: boolean } = {}): void {
  const event = new MouseEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    clientX: 40,
    clientY: 10,
    button: 0,
    ctrlKey: opts.ctrlKey ?? false,
    shiftKey: opts.shiftKey ?? false,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    element.dispatchEvent(event);
  });
}

let trackA: Track;
let trackB: Track;
let ids: [string, string];

/** Three tracks — A, B (index 1, non-zero clip starts, X3), C — mirroring the
 * brief's own fixture shape. Every test below presses track B specifically. */
beforeEach(() => {
  trackA = createTrack('Track A');
  trackA.clips = [
    createClip({ documentId: 'doc-1', startSample: 40_000, offsetSample: 0, lengthSample: 20_000 }),
  ];
  trackB = createTrack('Track B');
  trackB.clips = [
    createClip({ documentId: 'doc-1', startSample: 100_000, offsetSample: 0, lengthSample: 30_000 }),
    createClip({ documentId: 'doc-1', startSample: 200_000, offsetSample: 0, lengthSample: 10_000 }),
  ];
  const trackC = createTrack('Track C');
  const session: Session = { name: 'Current Track Lane Fixture', sampleRate: SR, tracks: [trackA, trackB, trackC] };
  useSessionStore.setState({
    session,
    selectedClipId: null,
    selectedClipIds: [],
    selectedGap: null,
    currentTrackId: null,
    mtCursorSample: 0,
    mtPlayState: 'stopped',
    mtPlayheadSample: 0,
    mtEnvelope: null,
  });
  ids = [trackB.clips[0].id, trackB.clips[1].id];
});

function renderLaneB(isCurrent = false, isDragTarget = false): { lane: HTMLElement } {
  const { container } = render(
    <TrackLane
      track={trackB}
      docs={new Map()}
      zoom={{ samplesPerPixel: SPP, scrollSample: 0 }}
      sessionRate={SR}
      laneHeight={96}
      selectedClipId={store().selectedClipId}
      isDragTarget={isDragTarget}
      isCurrent={isCurrent}
      resolveTrackAt={() => trackB.id}
      onDragOverTrack={() => {}}
    />
  );
  return { lane: container.querySelector('[data-testid="track-lane"]') as HTMLElement };
}

describe('a press on the lane background sets the current track (K2)', () => {
  it('sets currentTrackId to the PRESSED track — index 1, not 0', () => {
    const { lane } = renderLaneB();

    press(lane);

    expect(store().currentTrackId).toBe(trackB.id);
    expect(store().currentTrackId).not.toBe(trackA.id);
  });

  it('also fires on a Ctrl press, which is otherwise a deferred-clear press', () => {
    const { lane } = renderLaneB();

    press(lane, { ctrlKey: true });

    expect(store().currentTrackId).toBe(trackB.id);
  });
});

describe('the lane background reflects isCurrent (K3)', () => {
  it('is var(--lane-current) when isCurrent, transparent when not', () => {
    const current = renderLaneB(true);
    expect(current.lane.style.backgroundColor).toBe('var(--lane-current)');

    const notCurrent = renderLaneB(false);
    expect(notCurrent.lane.style.backgroundColor).toBe('transparent');
  });

  it('the drag-target wash wins over the current-track mark, even while current', () => {
    const { lane } = renderLaneB(true, true);
    expect(lane.style.backgroundColor).toBe('var(--accent-soft)');
  });
});

describe('X6 — the deferred clear (this lot ships it, not lot J)', () => {
  it('a Ctrl press does NOT clear a standing two-clip selection at pointerdown', () => {
    const { lane } = renderLaneB();
    act(() => {
      store().setSelectedClip(ids[0]);
      store().toggleSelectedClip(ids[1]);
    });

    press(lane, { ctrlKey: true });

    expect(store().selectedClipIds).toEqual([ids[0], ids[1]]);
  });

  it('a Shift press does NOT clear a standing two-clip selection at pointerdown either', () => {
    const { lane } = renderLaneB();
    act(() => {
      store().setSelectedClip(ids[0]);
      store().toggleSelectedClip(ids[1]);
    });

    press(lane, { shiftKey: true });

    expect(store().selectedClipIds).toEqual([ids[0], ids[1]]);
  });

  it('a plain press still clears it, unchanged from before this lot', () => {
    const { lane } = renderLaneB();
    act(() => {
      store().setSelectedClip(ids[0]);
      store().toggleSelectedClip(ids[1]);
    });

    press(lane);

    expect(store().selectedClipIds).toEqual([]);
    expect(store().selectedClipId).toBeNull();
  });
});
