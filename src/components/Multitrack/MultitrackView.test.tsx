import { act, render, screen } from '@testing-library/react';
import MultitrackView from './MultitrackView';
import { useSessionStore } from '../../multitrack/sessionStore';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { createDocument, docLength } from '../../audio/AudioDocument';
import { _resetPassLock, acquirePass } from '../../services/passLock';

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  useSessionStore.getState().newSession(44100);
  _resetPassLock();
});

afterEach(() => {
  _resetPassLock();
});

describe('MultitrackView G6: floating track cards on the stage', () => {
  it('renders each track row (header + lane) as one glass card row', () => {
    render(<MultitrackView />);
    const headers = screen.getAllByTestId('track-header');
    const lanes = screen.getAllByTestId('track-lane');
    expect(headers).toHaveLength(4); // newSession seeds Track 1..Track 4
    expect(lanes).toHaveLength(4);
    headers.forEach((header, i) => {
      const row = header.parentElement!;
      expect(row).toHaveClass('glass-track-row');
      expect(row.contains(lanes[i])).toBe(true);
    });
  });

  it('keeps the stage insets on the view root and the multitrack contracts intact', () => {
    render(<MultitrackView />);
    expect(screen.getByTestId('multitrack-view')).toHaveClass('stage-inset');
    expect(screen.getByTestId('timeline-ruler')).toBeInTheDocument();
    // Buttons keep their accessible names + enablement: no active doc, no clips.
    expect(screen.getByRole('button', { name: /insert active file/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /mix down/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /add track/i })).toBeEnabled();
    expect(screen.getByText(/empty session/i)).toBeInTheDocument();
  });
});

// Lot M, acceptance 11 — Mix Down reads the app-wide pass lock through
// `multitrack.mixdown`'s own `enabled`; Insert Active File is a different
// command (`multitrack.insertDoc`, not gated by M1 — it places existing
// material, it starts no pass) and must stay enabled beside it.
describe('MultitrackView — a running pass disables Mix Down only (lot M, acceptance 11)', () => {
  it('greys Mix Down with a title naming the pass, while Insert Active File stays enabled', () => {
    const doc = createDocument({
      name: 'take.wav',
      sampleRate: 44100,
      channels: [new Float32Array(2000)],
    });
    act(() => {
      useAppStore.getState().addDocument(doc);
      // `multitrack.mixdown`'s own `enabled` requires the multitrack view.
      useAppStore.getState().setView('multitrack');
    });
    const trackId = useSessionStore.getState().session.tracks[0].id;
    act(() => {
      useSessionStore.getState().addClip(trackId, {
        id: 'clip-1',
        documentId: doc.id,
        startSample: 0,
        offsetSample: 0,
        lengthSample: docLength(doc),
        gainDb: 0,
      });
    });
    render(<MultitrackView />);
    expect(screen.getByRole('button', { name: /mix down/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /insert active file/i })).toBeEnabled();

    act(() => {
      acquirePass({ id: 'edit.remix', label: 'Auto-Remix', kind: 'pipeline' });
    });

    const mixDown = screen.getByRole('button', { name: /mix down/i });
    expect(mixDown).toBeDisabled();
    expect(mixDown).toHaveAttribute('title', expect.stringContaining('Auto-Remix'));
    expect(screen.getByRole('button', { name: /insert active file/i })).toBeEnabled();
  });
});
