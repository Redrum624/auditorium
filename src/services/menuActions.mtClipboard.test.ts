import { commandReason, getMenuSections, isCommandEnabled, runCommand, type MenuCommand } from './menuActions';
import { makeInitialState, useAppStore } from '../stores/appStore';
import { createDocument, type AudioDocument } from '../audio/AudioDocument';
import { createClip, createTrack, type Session } from '../multitrack/session';
import { useSessionStore } from '../multitrack/sessionStore';
import { _resetSessionUndo } from '../multitrack/sessionUndo';
import { clearClipboard, getClipboardKind, setClipboard } from './clipboard';
import { PASTE_HOLDS_CLIPS_REASON, PASTE_NO_TRACK_REASON } from '../multitrack/clipClipboard';

/**
 * Lot L (items 11/12) — `edit.copy`/`edit.paste`'s MULTITRACK arm: routed
 * (the `edit.split`/`edit.trim` shape) rather than unconditionally refused
 * (the old F1/M7 gate). `edit.cut` is deliberately NOT re-tested here beyond
 * the one pin below — it stays on `isDocumentEditView` (M7, unchanged); L1
 * names Copy and Paste only.
 */

// The shared X3 fixture (non-identity): 48_000 Hz, four tracks T0..T3, `c1`
// on T1, `c2` on T2, cursor 240_000, current track T2 (index 2).
const SESSION_RATE = 48_000;

function buildSession(documentId: string): { session: Session; c1Id: string; c2Id: string } {
  const t0 = createTrack('T0');
  const t1 = createTrack('T1');
  const t2 = createTrack('T2');
  const t3 = createTrack('T3');
  const c1 = createClip({
    documentId,
    startSample: 96_000,
    offsetSample: 12_000,
    lengthSample: 72_000,
    gainDb: -4.5,
    fadeInSample: 4_800,
  });
  const c2 = createClip({
    documentId,
    startSample: 120_000,
    offsetSample: 5_000,
    lengthSample: 36_000,
    gainDb: 2.0,
  });
  t1.clips = [c1];
  t2.clips = [c2];
  return {
    session: { name: 'Menu Clipboard Fixture', sampleRate: SESSION_RATE, tracks: [t0, t1, t2, t3] },
    c1Id: c1.id,
    c2Id: c2.id,
  };
}

function installSession(session: Session, opts?: { currentTrackId?: string | null; mtCursorSample?: number }): void {
  useSessionStore.setState({
    session,
    selectedClipId: null,
    selectedClipIds: [],
    selectedGap: null,
    currentTrackId: opts?.currentTrackId ?? null,
    lastSplit: null,
    mtCursorSample: opts?.mtCursorSample ?? 0,
    mtTimeRange: null,
    mtPlayState: 'stopped',
    mtPlayheadSample: 0,
    mtEnvelope: null,
    groupDragPreview: null,
    projectPath: null,
  });
}

function addSourceDoc(): AudioDocument {
  const doc = createDocument({ name: 'source.wav', sampleRate: 48_000, channels: [new Float32Array(200_000)] });
  useAppStore.getState().addDocument(doc);
  return doc;
}

function findEditCmd(id: string): MenuCommand {
  const edit = getMenuSections().find((s) => s.title === 'Edit')!;
  return edit.items.find((item): item is MenuCommand => item !== 'separator' && item.id === id)!;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  _resetSessionUndo();
  clearClipboard();
});

describe('edit.copy in the Multitrack view (L1) — FAILS TODAY', () => {
  it('is enabled with clips selected', () => {
    const doc = addSourceDoc();
    const { session, c1Id, c2Id } = buildSession(doc.id);
    installSession(session, { currentTrackId: session.tracks[2].id, mtCursorSample: 240_000 });
    useAppStore.getState().setView('multitrack');
    useSessionStore.getState().setSelectedClips([c1Id, c2Id]);

    expect(isCommandEnabled('edit.copy')).toBe(true);
  });
});

describe('edit.paste in the Multitrack view (L2/L3)', () => {
  function armedAndCopied() {
    const doc = addSourceDoc();
    const { session, c1Id, c2Id } = buildSession(doc.id);
    installSession(session, { currentTrackId: session.tracks[2].id, mtCursorSample: 240_000 });
    useAppStore.getState().setView('multitrack');
    useSessionStore.getState().setSelectedClips([c1Id, c2Id]);
    return { doc, session, c1Id, c2Id };
  }

  it('is enabled once clips are copied with a current track, and runCommand places one on that track at the bar', async () => {
    const { c2Id } = armedAndCopied(); // track 2 (index 2, current) already holds c2
    await runCommand('edit.copy');

    expect(isCommandEnabled('edit.paste')).toBe(true);

    await runCommand('edit.paste');

    const pastedC1 = useSessionStore
      .getState()
      .session.tracks[2].clips.find((c) => c.id !== c2Id);
    expect(pastedC1).toMatchObject({ startSample: 240_000 });
  });

  it('is disabled with no current track, and commandReason names L3; the clipboard still holds the clips afterwards', async () => {
    armedAndCopied();
    await runCommand('edit.copy');
    useSessionStore.getState().setCurrentTrack(null);

    expect(isCommandEnabled('edit.paste')).toBe(false);
    expect(commandReason('edit.paste')).toBe(PASTE_NO_TRACK_REASON);

    await runCommand('edit.paste'); // a disabled command does not run at all (runCommand re-checks)
    expect(getClipboardKind()).toBe('clips');
  });

  it('edit.cut stays disabled in this same armed state (M7 unchanged), and the Edit MENU rows agree with isCommandEnabled', async () => {
    armedAndCopied();
    await runCommand('edit.copy');

    expect(isCommandEnabled('edit.cut')).toBe(false);

    const state = useAppStore.getState();
    expect(findEditCmd('edit.copy').enabled(state)).toBe(isCommandEnabled('edit.copy'));
    expect(findEditCmd('edit.paste').enabled(state)).toBe(isCommandEnabled('edit.paste'));
  });
});

describe('the editor arm, both directions (L4a)', () => {
  function openDoc(): AudioDocument {
    const doc = createDocument({
      name: 'a.wav',
      sampleRate: 44_100,
      channels: [Float32Array.from({ length: 1_000 }, (_, i) => i + 1)],
    });
    useAppStore.getState().addDocument(doc);
    return doc;
  }

  it('edit.copy/edit.paste stay live in the waveform view with a selection and an audio clipboard, and pasteAtCursor still runs', async () => {
    const doc = openDoc();
    useAppStore.getState().setSelection({ start: 0, end: 10 });
    setClipboard({ channels: [new Float32Array(5)], sampleRate: 44_100 });

    expect(isCommandEnabled('edit.copy')).toBe(true);
    expect(isCommandEnabled('edit.paste')).toBe(true);

    const before = doc.channels[0].length;
    await runCommand('edit.paste');
    // The selection [0, 10) is REPLACED by the 5-sample clipboard payload.
    expect(useAppStore.getState().documents[0].channels[0].length).toBe(before - 10 + 5);
  });

  it('after a multitrack edit.copy, edit.paste in the waveform view is refused with PASTE_HOLDS_CLIPS_REASON', async () => {
    openDoc();
    const srcDoc = addSourceDoc();
    const { session, c1Id } = buildSession(srcDoc.id);
    installSession(session, { currentTrackId: session.tracks[2].id });
    useAppStore.getState().setView('multitrack');
    useSessionStore.getState().setSelectedClips([c1Id]);
    await runCommand('edit.copy');

    useAppStore.getState().setView('waveform');
    useAppStore.getState().setSelection({ start: 0, end: 10 });

    expect(isCommandEnabled('edit.paste')).toBe(false);
    expect(commandReason('edit.paste')).toBe(PASTE_HOLDS_CLIPS_REASON);
  });
});
