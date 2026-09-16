/**
 * F2/F3 (item 6) — "give more precision to the bar when trying to put it near
 * it's last position", cause A's OTHER gesture. `MultitrackView.cursorHandle
 * .test.tsx` pins the handle drag; this file pins the multitrack ruler seek,
 * the sibling gesture `mtSnapTargets` (`MultitrackView.tsx:31-32`) also feeds
 * — both pass through the SAME function, so both are fixed by the same
 * `{ includeCursor: false }` edit (X2: one surface, one rule — here the two
 * gestures of ONE surface share one target-builder, so there is no sibling
 * copy to drift).
 *
 * Before this lot, `mtCursorSample` sat in the ruler's own target set, so a
 * seek near the bar's current position snapped straight back to it — the
 * literal complaint, "near its last position".
 */
import { act, render, screen } from '@testing-library/react';
import MultitrackView from './MultitrackView';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { createClip } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
import { _resetSessionUndo } from '../../multitrack/sessionUndo';
import { _resetSessionLaneWidth } from '../../multitrack/sessionViewport';
import { _resetSnapPreference } from '../../services/snapPreference';
import { makeInitialState, useAppStore } from '../../stores/appStore';

const SR = 44_100;
const SPP = 100; // samples per pixel
/** A clip edge at x = 220.5 — off any whole pixel, so a snap onto it is
 * unmistakably the magnet and never the pointer's own arithmetic. */
const EDGE = 22_050;

const store = () => useSessionStore.getState();

/** jsdom has no window.PointerEvent; a MouseEvent carries clientX/Y and stands
 * in, with pointerId attached — same technique as the cursor-handle suite. */
function firePointer(
  element: Element,
  type: 'pointerdown' | 'pointermove',
  init: { clientX: number; altKey?: boolean }
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: 3,
    altKey: init.altKey ?? false,
    button: 0,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    element.dispatchEvent(event);
  });
}

let doc: AudioDocument;

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  store().newSession(SR);
  _resetSessionUndo();
  _resetSnapPreference();
  _resetSessionLaneWidth();
  useSessionStore.setState({ mtZoom: { samplesPerPixel: SPP, scrollSample: 0 } });
  doc = createDocument({ name: 'src.wav', sampleRate: SR, channels: [new Float32Array(400_000)] });
  useAppStore.getState().addDocument(doc);
});

function mountRuler(): HTMLElement {
  render(<MultitrackView />);
  return screen.getByTestId('timeline-ruler');
}

describe('the multitrack ruler seek does not snap back to the bar’s own position (F2/F3)', () => {
  // Acceptance 7 — FAILS TODAY. The ruler's rect is all zeros in jsdom, so a
  // clientX maps to the SAME lane x the cursor line itself paints at (no
  // header offset — this surface, unlike the DOM handle overlay, is not
  // shifted by HEADER_W).
  it('seeks 3px past the bar’s last position instead of snapping back to it', () => {
    store().setMtCursor(30_000); // lane x = 300
    const ruler = mountRuler();

    firePointer(ruler, 'pointerdown', { clientX: 303 });

    expect(store().mtCursorSample).toBe(30_300);
  });

  it('still snaps to a clip edge — only the bar’s own position was withheld', () => {
    const clip = createClip({ documentId: doc.id, startSample: EDGE, offsetSample: 0, lengthSample: 20_000 });
    store().addClip(store().session.tracks[0].id, clip);
    useSessionStore.setState({ mtZoom: { samplesPerPixel: SPP, scrollSample: 0 } });
    store().setMtCursor(30_000); // non-identity starting position (X3)
    const ruler = mountRuler();

    firePointer(ruler, 'pointerdown', { clientX: 224 });

    expect(store().mtCursorSample).toBe(EDGE);
  });
});
