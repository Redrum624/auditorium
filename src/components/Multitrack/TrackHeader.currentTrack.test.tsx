/**
 * K2, fix round 2 (item 5, coordinator ruling) — a press on the HEADER's own
 * background also names its track current. `MultitrackView.tsx`'s own row
 * comment already rules "THE WHOLE ROW IS THE TRACK, header included" for
 * drop resolution, and the user's words for item 12 ("click anywhere on a
 * visible part of the background of the track") name no exception for the
 * header half of the row. Excludes an actual CONTROL — an `<input>` (rename
 * box, Vol/Pan sliders) or a `<button>` (Mute/Solo/Record, Remove, the
 * envelope toggle) — which already has its own meaning.
 */
import { act, render } from '@testing-library/react';
import type { Track } from '../../multitrack/session';
import { useSessionStore } from '../../multitrack/sessionStore';
import TrackHeader from './TrackHeader';

const store = () => useSessionStore.getState();

function press(element: Element): void {
  const event = new MouseEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    clientX: 10,
    clientY: 10,
    button: 0,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    element.dispatchEvent(event);
  });
}

let trackB: Track;

beforeEach(() => {
  store().newSession(44_100); // 'Untitled Session', 4 empty tracks
  useSessionStore.setState({ currentTrackId: null });
  trackB = store().session.tracks[1]; // index 1, not 0 (X3)
});

describe('a press on the header background sets the current track', () => {
  it('a press on the header ROOT sets currentTrackId', () => {
    const { container } = render(<TrackHeader track={trackB} />);
    const header = container.querySelector('[data-testid="track-header"]') as HTMLElement;

    press(header);

    expect(store().currentTrackId).toBe(trackB.id);
  });

  it('a press on the track NAME label (not an interactive control) also sets it', () => {
    const { getByTitle } = render(<TrackHeader track={trackB} />);
    const name = getByTitle('Double-click to rename');

    press(name);

    expect(store().currentTrackId).toBe(trackB.id);
  });
});

describe('a press on an actual control does not set it via the header handler', () => {
  it('the Mute button', () => {
    const { getByLabelText } = render(<TrackHeader track={trackB} />);
    press(getByLabelText('Mute'));

    expect(store().currentTrackId).toBeNull();
  });

  it('the Volume slider', () => {
    const { getByLabelText } = render(<TrackHeader track={trackB} />);
    press(getByLabelText('Volume (dB)'));

    expect(store().currentTrackId).toBeNull();
  });

  it('the Pan slider', () => {
    const { getByLabelText } = render(<TrackHeader track={trackB} />);
    press(getByLabelText('Pan'));

    expect(store().currentTrackId).toBeNull();
  });

  it('the Remove-track button', () => {
    const { getByLabelText } = render(<TrackHeader track={trackB} />);
    press(getByLabelText('Remove track'));

    expect(store().currentTrackId).toBeNull();
  });
});
