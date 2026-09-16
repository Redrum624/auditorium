/**
 * K1 R2 — CLICKING EMPTY LANE SPACE CLEARS THE SELECTION, wired.
 *
 * The K1 review confirmed the behaviour was already right and that only the
 * WIRING was untested: `TrackLane` calls `setSelectedClip(null)` on a left
 * press, `setSelectedClip(null)` empties the extended set (pinned in
 * `sessionStore.selection.test.ts`), and `ClipView.onPointerDown` calls
 * `stopPropagation` so a press on a clip never reaches the lane. Three facts,
 * each held somewhere else, with nothing holding them TOGETHER — so a lane that
 * stopped calling the action, or a clip that stopped stopping the event, would
 * have taken the whole "click away to deselect" gesture with it silently.
 *
 * This is the join: a real press on the real lane element, against a real
 * multi-clip selection in the store.
 */
import { act, render } from '@testing-library/react';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { createClip, createTrack, type Session, type Track } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
import TrackLane from './TrackLane';

const SR = 44_100;
const SPP = 100;

const store = () => useSessionStore.getState();

function press(element: Element, button = 0): void {
  const event = new MouseEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    clientX: 40,
    clientY: 10,
    button,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    element.dispatchEvent(event);
  });
}

let doc: AudioDocument;
let track: Track;
let ids: [string, string];

beforeEach(() => {
  doc = createDocument({ name: 'src.wav', sampleRate: SR, channels: [new Float32Array(200_000)] });
  const t = createTrack('Track 1');
  t.clips = [
    createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 20_000 }),
    createClip({ documentId: doc.id, startSample: 40_000, offsetSample: 0, lengthSample: 20_000 }),
  ];
  const session: Session = { name: 'Lane Fixture', sampleRate: SR, tracks: [t] };
  useSessionStore.setState({
    session,
    selectedClipId: null,
    selectedClipIds: [],
    mtCursorSample: 0,
    mtPlayState: 'stopped',
    mtPlayheadSample: 0,
    mtEnvelope: null,
  });
  track = t;
  ids = [t.clips[0].id, t.clips[1].id];
});

/** The lane, holding both clips, with a two-clip selection standing. */
function renderLane(): { lane: HTMLElement; clip: HTMLElement } {
  const { container } = render(
    <TrackLane
      track={track}
      docs={new Map([[doc.id, doc]])}
      zoom={{ samplesPerPixel: SPP, scrollSample: 0 }}
      sessionRate={SR}
      laneHeight={96}
      selectedClipId={store().selectedClipId}
      isDragTarget={false}
      resolveTrackAt={() => track.id}
      onDragOverTrack={() => {}}
    />
  );
  return {
    lane: container.querySelector('[data-testid="track-lane"]') as HTMLElement,
    clip: container.querySelector('[data-testid="clip"]') as HTMLElement,
  };
}

function selectBoth(): void {
  act(() => {
    store().setSelectedClip(ids[0]);
    store().toggleSelectedClip(ids[1]);
  });
  expect(store().selectedClipIds).toEqual([ids[0], ids[1]]);
}

describe('a press on empty lane space', () => {
  it('clears the WHOLE selection, not only the primary', () => {
    const { lane } = renderLane();
    selectBoth();

    press(lane);

    expect(store().selectedClipId).toBeNull();
    expect(store().selectedClipIds).toEqual([]);
  });

  it('changes nothing when the press lands on a clip — the clip stops the event', () => {
    const { clip } = renderLane();
    selectBoth();

    // A press on a clip already IN the selection commits nothing of its own
    // (that press is how a group drag starts), so anything that moved here
    // would have come from the lane handler underneath.
    press(clip);

    expect(store().selectedClipIds).toEqual([ids[0], ids[1]]);
    expect(store().selectedClipId).toBe(ids[1]);
  });

  it('ignores a non-left button, so a context-menu press keeps the selection', () => {
    const { lane } = renderLane();
    selectBoth();

    press(lane, 2);

    expect(store().selectedClipIds).toEqual([ids[0], ids[1]]);
  });

  // Fix round 1 (lot K, K2) — this used to be a plain no-op: an empty-lane
  // press on a session with nothing selected touched nothing at all. K2 makes
  // that premise obsolete BY DESIGN: the press now also names the CURRENT
  // track, which is a real, deliberate change the user asked for (item 12),
  // so the state object is no longer expected to survive a FIRST press
  // untouched. The invariant this test used to protect — an empty-lane press
  // must not mint a fresh `[]`/`selectedClipIds` for every clip's subscription
  // to repaint over — is still real and is re-pinned below, on the SECOND
  // press, once the track is already current.
  it('a press on empty lane space sets the current track — a real, deliberate change (K2)', () => {
    const { lane } = renderLane();
    expect(store().currentTrackId).toBeNull();

    press(lane);

    expect(store().currentTrackId).toBe(track.id);
    // The clip-selection half of the gesture is still the untouched no-op:
    // nothing was selected before, and nothing is selected after.
    expect(store().selectedClipId).toBeNull();
    expect(store().selectedClipIds).toEqual([]);
  });

  it('a SECOND press on the same, already-current lane is a true no-op — the same state object comes back', () => {
    const { lane } = renderLane();
    press(lane); // first press: currentTrackId null -> track.id, a real change
    expect(store().currentTrackId).toBe(track.id);
    const held = useSessionStore.getState();

    press(lane); // second press: the track is ALREADY current

    // `setCurrentTrack`'s own no-op guard (`sessionStore.ts`) must bail when
    // the id is unchanged, or every press on an already-current lane would
    // mint a fresh state object for every clip's subscription to see — the
    // exact repaint-on-every-press cost this test originally existed to rule
    // out, now guarded one layer down instead of by the gesture doing nothing
    // at all.
    expect(useSessionStore.getState()).toBe(held);
  });
});
