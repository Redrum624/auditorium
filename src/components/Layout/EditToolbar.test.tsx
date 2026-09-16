import { act, render, screen, fireEvent } from '@testing-library/react';
import EditToolbar, { EDIT_TOOLBAR_ITEMS } from './EditToolbar';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { useSessionStore } from '../../multitrack/sessionStore';
import { createClip } from '../../multitrack/session';
import { createDocument, type AudioDocument } from '../../audio/AudioDocument';
import { runCommand } from '../../services/menuActions';
import { setClipboard, clearClipboard } from '../../services/clipboard';
import { cutSelection } from '../../services/editOps';
import { clearHistory, undo } from '../../services/undoHistory';

// The real registry (so every predicate under test is the MENU's own) with
// only the runner spied — a click has to reach `runCommand(id)`, and running
// the real edit for a click assertion would test editOps, not this pill.
jest.mock('../../services/menuActions', () => {
  const actual = jest.requireActual('../../services/menuActions');
  return { ...actual, runCommand: jest.fn(async () => {}) };
});
const mockRunCommand = runCommand as jest.MockedFunction<typeof runCommand>;

function addDoc(): AudioDocument {
  const doc = createDocument({
    name: 'a.wav',
    sampleRate: 44100,
    channels: [new Float32Array(44100)],
  });
  act(() => useAppStore.getState().addDocument(doc));
  return doc;
}

function btn(label: string): HTMLButtonElement {
  return screen.getByRole('button', { name: label }) as HTMLButtonElement;
}

/** The pill re-reads the registry after a command settles (the in-app
 * clipboard has no subscribers), so a click's effects land one microtask
 * later — flush it inside act rather than asserting on a half-committed
 * render. */
async function click(label: string): Promise<void> {
  await act(async () => {
    fireEvent.click(btn(label));
  });
}

let lastDocId: string | null = null;

beforeEach(() => {
  if (lastDocId) clearHistory(lastDocId);
  lastDocId = null;
  useAppStore.setState(makeInitialState());
  useSessionStore.getState().newSession(44100);
  clearClipboard();
  mockRunCommand.mockClear();
});

describe('EditToolbar — the E2 visibility rule', () => {
  it('is absent in the empty app, in every view', () => {
    for (const view of ['waveform', 'spectral', 'multitrack'] as const) {
      act(() => useAppStore.getState().setView(view));
      const { unmount } = render(<EditToolbar />);
      expect(screen.queryByTestId('edit-pill')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('is present in Waveform, Spectral AND Multitrack once one file is loaded', () => {
    lastDocId = addDoc().id;
    for (const view of ['waveform', 'spectral', 'multitrack'] as const) {
      act(() => useAppStore.getState().setView(view));
      const { unmount } = render(<EditToolbar />);
      expect(screen.getByTestId('edit-pill')).toBeInTheDocument();
      unmount();
    }
  });

  it('disappears again when the last document is closed', () => {
    const doc = addDoc();
    lastDocId = doc.id;
    render(<EditToolbar />);
    expect(screen.getByTestId('edit-pill')).toBeInTheDocument();

    act(() => useAppStore.getState().closeDocument(doc.id));
    expect(screen.queryByTestId('edit-pill')).not.toBeInTheDocument();
  });
});

describe('EditToolbar — the ten icon buttons', () => {
  // Acceptance #6 (lot H): 9 -> 10. Select All leads (H8's own group), and
  // Merge is renamed Join (H1) but keeps its D6 position directly after Split.
  it('renders exactly the ten commands, in the mockup order, icons only', () => {
    lastDocId = addDoc().id;
    const { container } = render(<EditToolbar />);
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid="edit-pill"] button')
    );
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Select All', // H4/H8 (lot H): new, leads its own group
      'Split', // item 8 (M1): the Scissors button is Split at Cursor
      'Join', // D6: Split's inverse, directly after it; H1: renamed from Merge
      'Copy',
      'Paste',
      'Delete',
      'Trim',
      'Silence',
      'Undo',
      'Redo',
    ]);
    expect(EDIT_TOOLBAR_ITEMS).toHaveLength(10);
    // Icons only: every button's visible content is an SVG glyph, no text.
    for (const b of buttons) {
      expect(b.querySelector('svg')).not.toBeNull();
      expect(b.textContent).toBe('');
    }
  });

  it('is a glass chrome pill', () => {
    lastDocId = addDoc().id;
    render(<EditToolbar />);
    expect(screen.getByTestId('edit-pill').className).toContain('glass-chrome');
  });
});

describe('EditToolbar — per-button enablement, each predicate both ways', () => {
  it('greys Copy / Delete / Trim / Silence without a selection, and lights them with one; Split needs only a document', () => {
    const doc = addDoc();
    lastDocId = doc.id;
    render(<EditToolbar />);
    for (const label of ['Copy', 'Delete', 'Trim', 'Silence']) {
      expect(btn(label)).toBeDisabled();
    }
    expect(btn('Split')).toBeEnabled();

    act(() => useAppStore.getState().setSelection({ start: 0, end: 1000 }));
    for (const label of ['Copy', 'Delete', 'Trim', 'Silence']) {
      expect(btn(label)).toBeEnabled();
    }
    expect(btn('Split')).toBeEnabled();
  });

  it('greys Paste on an empty clipboard and lights it once something is on it', () => {
    lastDocId = addDoc().id;
    render(<EditToolbar />);
    expect(btn('Paste')).toBeDisabled();

    setClipboard({ channels: [new Float32Array(100)], sampleRate: 44100 });
    // A store touch re-reads the registry, exactly as the Edit menu does.
    act(() => useAppStore.getState().setCursor(1));
    expect(btn('Paste')).toBeEnabled();
  });

  it('greys Undo until the document has history, and Redo until an undo happened', () => {
    const doc = addDoc();
    lastDocId = doc.id;
    render(<EditToolbar />);
    expect(btn('Undo')).toBeDisabled();
    expect(btn('Redo')).toBeDisabled();

    act(() => {
      useAppStore.getState().setSelection({ start: 0, end: 1000 });
      cutSelection();
    });
    expect(btn('Undo')).toBeEnabled();
    expect(btn('Redo')).toBeDisabled();

    act(() => undo(doc.id));
    expect(btn('Undo')).toBeDisabled();
    expect(btn('Redo')).toBeEnabled();
  });

  // F1 (M1 fix round): this used to cover Cut/Copy/Paste ONLY, and Trim and
  // Silence stayed lit in exactly this state — a click destroyed everything
  // outside the selection in a document the multitrack view does not show,
  // while the Undo button one divider away routed to the session's history and
  // could not undo it. All five region verbs are now gated on the COMMAND, so
  // this pill inherits the rule instead of restating a subset of it.
  // Item 8: Cut left the pill (the Scissors button is Split now), so the
  // region verbs it draws are the four below. Item 10 (M7): each of the four
  // now says its OWN reason instead of sharing one paragraph, because the two
  // pairs are blocked for different reasons and only one of them could ever be
  // lifted by selecting something.
  // Lot J (item 10) — Trim/Silence DROP OUT of the blocked set here: they are
  // now view-routed (`edit.trim`/`edit.silence`), not gated on
  // `multitrackReason` at all, so their title is `multitrackTitle` in this
  // view regardless of whether the command is currently enabled. Copy/Paste
  // stay blocked (lot L's clip clipboard has not landed).
  it('4a greys Copy / Paste in Multitrack, each with its own reason, and re-titles Trim / Silence', () => {
    lastDocId = addDoc().id;
    act(() => {
      useAppStore.getState().setSelection({ start: 0, end: 1000 });
      useAppStore.getState().setView('multitrack');
    });
    setClipboard({ channels: [new Float32Array(100)], sampleRate: 44100 });
    render(<EditToolbar />);

    for (const label of ['Copy', 'Paste']) {
      expect(btn(label)).toBeDisabled();
      const title = btn(label).title.toLowerCase();
      expect(title).toContain('multitrack');
      // Honest about the remedy, not just the refusal.
      expect(title).toContain('waveform or spectral');
    }
    expect(btn('Copy').title).toContain('needs a clip clipboard');
    expect(btn('Paste').title).toContain('needs a clip clipboard');

    // No multitrack time range is standing, so the command is still refused —
    // but for the NEW reason, and the title names the GESTURE rather than a
    // blocked-view sentence (J9's discoverability compensation).
    expect(btn('Trim')).toBeDisabled();
    expect(btn('Silence')).toBeDisabled();
    expect(btn('Trim').title).toBe(
      'Trim to Selection — keeps only the swept time range on the selected clips’ tracks (all tracks with nothing selected). Shift+drag a lane to sweep a range.'
    );
    expect(btn('Silence').title).toBe(
      'Silence Selection — clears the swept time range on those tracks and leaves the hole; nothing else moves. Shift+drag a lane to sweep a range.'
    );
    expect(btn('Trim').title.toLowerCase()).not.toContain('not available');
    expect(btn('Silence').title.toLowerCase()).not.toContain('not available');

    // The rows that were NEVER blocked by the view say nothing of the sort —
    // Delete and Split route to a session act there, Undo/Redo to the session's
    // history.
    for (const label of ['Delete', 'Undo', 'Redo']) {
      expect(btn(label).title).not.toContain('not available');
    }
  });

  it('4a-j Trim/Silence LIGHT UP in Multitrack once a time range is swept', () => {
    lastDocId = addDoc().id;
    act(() => useAppStore.getState().setView('multitrack'));
    render(<EditToolbar />);
    expect(btn('Trim')).toBeDisabled();
    expect(btn('Silence')).toBeDisabled();

    act(() => {
      useSessionStore.getState().addTrack();
      const trackId = useSessionStore.getState().session.tracks[0].id;
      const clip = createClip({ documentId: 'x', startSample: 1_000, offsetSample: 0, lengthSample: 3_000 });
      useSessionStore.getState().addClip(trackId, clip);
      useSessionStore.getState().setMtTimeRange({ startSample: 500, endSample: 2_000 });
    });

    expect(btn('Trim')).toBeEnabled();
    expect(btn('Silence')).toBeEnabled();
  });

  it('4b lights Copy / Paste / Trim / Silence again on the way back to Waveform, so the gate is the VIEW', () => {
    lastDocId = addDoc().id;
    act(() => {
      useAppStore.getState().setSelection({ start: 0, end: 1000 });
      useAppStore.getState().setView('multitrack');
    });
    setClipboard({ channels: [new Float32Array(100)], sampleRate: 44100 });
    render(<EditToolbar />);
    expect(btn('Trim')).toBeDisabled();

    act(() => useAppStore.getState().setView('waveform'));

    for (const label of ['Copy', 'Paste', 'Trim', 'Silence']) {
      expect(btn(label)).toBeEnabled();
    }
  });

  /** Seeds one clip `[1000, 3000)` (end 4000) on a fresh track and selects it. */
  function seedSelectedClip(): void {
    act(() => {
      useSessionStore.getState().addTrack();
      const trackId = useSessionStore.getState().session.tracks[0].id;
      const clip = createClip({
        documentId: 'x',
        startSample: 1000,
        offsetSample: 0,
        lengthSample: 3000,
      });
      useSessionStore.getState().addClip(trackId, clip);
      useSessionStore.getState().setSelectedClip(clip.id);
    });
  }

  // Item 10: `edit.split`'s multitrack predicate reads the SESSION store, whose
  // cursor and selection writers record nothing and touch no appStore field.
  // Without this pill's own session subscriptions the button would grey and
  // un-grey one unrelated render late — so every assertion below is made
  // straight after the session write that should have changed it, with no app
  // store touch in between.
  it('4c lights Split in Multitrack exactly when a selected clip is cut, and follows the SESSION store', () => {
    lastDocId = addDoc().id;
    act(() => useAppStore.getState().setView('multitrack'));
    render(<EditToolbar />);
    expect(btn('Split')).toBeDisabled();

    seedSelectedClip();
    act(() => useSessionStore.getState().setMtCursor(3000));
    expect(btn('Split')).toBeEnabled();
    expect(btn('Split').title).toContain('Split at Cursor');
    expect(btn('Split').title).toContain('selected clips’ tracks');

    act(() => useSessionStore.getState().setMtCursor(1000)); // the clip's edge
    expect(btn('Split')).toBeDisabled();

    act(() => useSessionStore.getState().setMtCursor(3000));
    expect(btn('Split')).toBeEnabled();
    act(() => useSessionStore.getState().setSelectedClip(null));
    expect(btn('Split')).toBeDisabled();
  });

  it('4c tells the editors apart: back in Waveform the Split tooltip is the marker one', () => {
    lastDocId = addDoc().id;
    act(() => useAppStore.getState().setView('multitrack'));
    render(<EditToolbar />);
    expect(btn('Split').title).toContain('selected clips’ tracks');

    act(() => useAppStore.getState().setView('waveform'));
    expect(btn('Split').title).toContain('a marker at the cursor');
    expect(btn('Split').title).not.toContain('selected clips’ tracks');
  });

  it('4d sends a Multitrack Split click through edit.split', async () => {
    lastDocId = addDoc().id;
    act(() => useAppStore.getState().setView('multitrack'));
    render(<EditToolbar />);
    seedSelectedClip();
    act(() => useSessionStore.getState().setMtCursor(3000));
    expect(btn('Split')).toBeEnabled();

    await click('Split');

    expect(mockRunCommand).toHaveBeenCalledWith('edit.split');
  });

  /** Two clips on one track — `[1000, 3000)` and `[5000, 8000)` — both
   * selected: the smallest selection `multitrack.joinClips` accepts. */
  function seedTwoSelectedClips(): string[] {
    const ids: string[] = [];
    act(() => {
      useSessionStore.getState().addTrack();
      const trackId = useSessionStore.getState().session.tracks[0].id;
      for (const [startSample, lengthSample] of [
        [1000, 2000],
        [5000, 3000],
      ]) {
        const clip = createClip({ documentId: 'x', startSample, offsetSample: 0, lengthSample });
        useSessionStore.getState().addClip(trackId, clip);
        ids.push(clip.id);
      }
      useSessionStore.getState().setSelectedClips(ids);
    });
    return ids;
  }

  // D6 — Join is the M7 rule pointing the other way: it exists ONLY in the
  // Multitrack view, so the tooltip that names the view that CAN do it is the
  // EDITOR one. Its predicate reads the same session store Split's does, which
  // is why the last act below is a session write with no app-store touch after
  // it: without this pill's session subscriptions the button would grey one
  // unrelated render late.
  it('4e greys Join in the editors, lights it for two clips on one track, and greys it again at one', () => {
    lastDocId = addDoc().id;
    render(<EditToolbar />);
    expect(btn('Join')).toBeDisabled();
    expect(btn('Join').title).toContain('not available in the Waveform and Spectral views');
    expect(btn('Join').title).toContain('Switch to Multitrack');

    act(() => useAppStore.getState().setView('multitrack'));
    expect(btn('Join')).toBeDisabled(); // in the right view, nothing selected

    const ids = seedTwoSelectedClips();
    expect(btn('Join')).toBeEnabled();
    expect(btn('Join').title).toContain('joins the selected clips');
    expect(btn('Join').title).not.toContain('not available');

    act(() => useSessionStore.getState().setSelectedClip(ids[0]));
    expect(btn('Join')).toBeDisabled();
  });

  it('4f sends a Join click through multitrack.joinClips', async () => {
    lastDocId = addDoc().id;
    act(() => useAppStore.getState().setView('multitrack'));
    render(<EditToolbar />);
    seedTwoSelectedClips();
    expect(btn('Join')).toBeEnabled();

    await click('Join');

    expect(mockRunCommand).toHaveBeenCalledWith('multitrack.joinClips');
  });

  // Acceptance #7 (lot H) — H8's routing: one command, two meanings. X3: a
  // 130000-sample document and a non-zero standing selection (12000..71000),
  // never the identity `start: 0` — Select All's enablement does not read the
  // selection at all (only `activeDoc`/`hasAnyClip`), which is itself worth
  // pinning so a later change that made it selection-dependent would be
  // caught here rather than only in menuActions.test.ts.
  describe('4g Select All (H4/H8, new)', () => {
    function addLongDoc(): AudioDocument {
      const doc = createDocument({
        name: 'long.wav',
        sampleRate: 44100,
        channels: [new Float32Array(130000)],
      });
      act(() => useAppStore.getState().addDocument(doc));
      act(() => useAppStore.getState().setSelection({ start: 12000, end: 71000 }));
      return doc;
    }

    it('is enabled in the waveform view and its title names the whole file', () => {
      lastDocId = addLongDoc().id;
      render(<EditToolbar />);

      expect(btn('Select All')).toBeEnabled();
      expect(btn('Select All').title).toContain('the whole file');
    });

    it('sends a click through edit.selectAll', async () => {
      lastDocId = addLongDoc().id;
      render(<EditToolbar />);

      await click('Select All');

      expect(mockRunCommand).toHaveBeenCalledWith('edit.selectAll');
    });

    it('stays enabled in Multitrack with three clips on two tracks, and its title names every clip on every track', () => {
      lastDocId = addLongDoc().id;
      act(() => {
        // `newSession` (beforeEach) already mints 4 empty tracks — no need to
        // add more.
        const [track1, track2] = useSessionStore.getState().session.tracks;
        useSessionStore
          .getState()
          .addClip(
            track1.id,
            createClip({ documentId: 'x', startSample: 22050, offsetSample: 0, lengthSample: 2000 })
          );
        useSessionStore
          .getState()
          .addClip(
            track1.id,
            createClip({ documentId: 'x', startSample: 50000, offsetSample: 0, lengthSample: 1500 })
          );
        useSessionStore
          .getState()
          .addClip(
            track2.id,
            createClip({ documentId: 'x', startSample: 88200, offsetSample: 0, lengthSample: 1000 })
          );
        useAppStore.getState().setView('multitrack');
      });
      render(<EditToolbar />);

      const button = btn('Select All');
      expect(button).toBeEnabled();
      expect(button.title).toContain('every clip on every track');
      expect(button.title).not.toContain('not available');
    });

    it('is disabled in Multitrack with a session that has no clips', () => {
      lastDocId = addLongDoc().id;
      act(() => useAppStore.getState().setView('multitrack'));
      render(<EditToolbar />);

      expect(btn('Select All')).toBeDisabled();
    });
  });

  it('D3 — Delete lights up for a selected GAP alone, and says what it will do', () => {
    lastDocId = addDoc().id;
    act(() => useAppStore.getState().setView('multitrack'));
    // The clips are placed BEFORE the render, so the only thing that changes
    // afterwards is `selectedGap` — which is the point: a double-click on empty
    // lane space writes that field and nothing else, so the pill must subscribe
    // to it or the button stays grey until some unrelated state moves.
    let trackId = '';
    act(() => {
      useSessionStore.getState().addTrack();
      trackId = useSessionStore.getState().session.tracks[0].id;
      for (const startSample of [1000, 2000]) {
        useSessionStore.getState().addClip(
          trackId,
          createClip({ documentId: 'x', startSample, offsetSample: 64, lengthSample: 500 })
        );
      }
    });
    render(<EditToolbar />);
    expect(btn('Delete')).toBeDisabled();

    act(() => {
      useSessionStore.getState().setSelectedGap({ trackId, startSample: 1500, endSample: 2000 });
    });

    expect(btn('Delete')).toBeEnabled();
    expect(btn('Delete').title).toContain('closes the selected gap');
  });

  it('D3 — the editor views keep the plain Delete tooltip, with no gap in it', () => {
    lastDocId = addDoc().id;
    act(() => useAppStore.getState().setView('waveform'));
    render(<EditToolbar />);

    // H5 (lot H): Delete now advertises its bare-letter combo too.
    expect(btn('Delete').title).toBe('Delete (D or Del)');
    expect(btn('Delete').title).not.toContain('gap');
  });

  it('routes Delete to the clip selection in Multitrack (both ways)', () => {
    lastDocId = addDoc().id;
    act(() => useAppStore.getState().setView('multitrack'));
    render(<EditToolbar />);
    expect(btn('Delete')).toBeDisabled();

    act(() => {
      useSessionStore.getState().addTrack();
      const trackId = useSessionStore.getState().session.tracks[0].id;
      const clip = createClip({
        documentId: 'x',
        startSample: 0,
        offsetSample: 0,
        lengthSample: 100,
      });
      useSessionStore.getState().addClip(trackId, clip);
      useSessionStore.getState().setSelectedClip(clip.id);
    });
    expect(btn('Delete')).toBeEnabled();
  });
});

describe('EditToolbar — click-through to the real commands', () => {
  it('runs each command id, and only when the button is live', async () => {
    lastDocId = addDoc().id;
    act(() => useAppStore.getState().setSelection({ start: 0, end: 1000 }));
    setClipboard({ channels: [new Float32Array(100)], sampleRate: 44100 });
    render(<EditToolbar />);

    for (const { label, commandId } of EDIT_TOOLBAR_ITEMS) {
      mockRunCommand.mockClear();
      const wasDisabled = btn(label).disabled;
      // eslint-disable-next-line no-await-in-loop -- one click at a time is the point
      await click(label);
      if (wasDisabled) {
        expect(mockRunCommand).not.toHaveBeenCalled();
      } else {
        expect(mockRunCommand).toHaveBeenCalledWith(commandId);
      }
    }
    // The loop is only meaningful if it exercised both arms.
    expect(btn('Redo').disabled).toBe(true);
    expect(btn('Split').disabled).toBe(false);
  });

  it('sends Split through edit.split and Trim through edit.trim', async () => {
    lastDocId = addDoc().id;
    act(() => useAppStore.getState().setSelection({ start: 0, end: 1000 }));
    render(<EditToolbar />);

    await click('Split');
    expect(mockRunCommand).toHaveBeenCalledWith('edit.split');

    await click('Trim');
    expect(mockRunCommand).toHaveBeenCalledWith('edit.trim');
  });
});
