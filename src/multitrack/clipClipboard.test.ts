import { createDocument, type AudioDocument } from '../audio/AudioDocument';
import { makeInitialState, useAppStore } from '../stores/appStore';
import { clearClipboard, getClipClipboard, getClipboardKind, setClipboard } from '../services/clipboard';
import { createClip, createTrack, type Clip, type Session } from './session';
import { useSessionStore } from './sessionStore';
import { _resetSessionUndo, redoSession, undoSession } from './sessionUndo';
import {
  PASTE_CLOSED_SOURCE_REASON,
  PASTE_EMPTY_REASON,
  PASTE_HOLDS_AUDIO_REASON,
  PASTE_NO_TRACK_REASON,
  clipsToClipboardEntries,
  copySelectedClips,
  pasteBlockReason,
  pasteClipsAtCursor,
  pastedClipGeometry,
} from './clipClipboard';

// The brief's own shared fixture (X3 — no identity values): session rate
// 48_000, four tracks T0..T3. `c1` on T1 `{ startSample: 96_000,
// offsetSample: 12_000, lengthSample: 72_000, gainDb: -4.5, fadeInSample:
// 4_800 }`; `c2` on T2 `{ startSample: 120_000, offsetSample: 5_000,
// lengthSample: 36_000, gainDb: 2.0 }`. No clip starts at 0, no gain is 0, no
// track index is 0, the rate is not the default.
const SESSION_RATE = 48_000;

function buildSession(documentId: string): { session: Session; c1: Clip; c2: Clip } {
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
  const session: Session = { name: 'Clipboard Fixture', sampleRate: SESSION_RATE, tracks: [t0, t1, t2, t3] };
  return { session, c1, c2 };
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

const clipsOn = (i: number) => useSessionStore.getState().session.tracks[i].clips;
const allClips = () => useSessionStore.getState().session.tracks.flatMap((t) => t.clips);

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  _resetSessionUndo();
  clearClipboard();
});

describe('clipsToClipboardEntries — reading order and geometry (L, process 2)', () => {
  it('two entries in reading order (c1 first), with track/start offsets and fade keys copied only when present', () => {
    const doc = addSourceDoc();
    const { session, c1, c2 } = buildSession(doc.id);

    const entries = clipsToClipboardEntries(session, [c2.id, c1.id]);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      documentId: doc.id,
      trackOffset: 0,
      startOffsetSample: 0,
      offsetSample: 12_000,
      gainDb: -4.5,
      fadeInSample: 4_800,
    });
    expect(entries[0]).not.toHaveProperty('fadeOutSample');
    expect(entries[1]).toMatchObject({
      documentId: doc.id,
      trackOffset: 1,
      startOffsetSample: 24_000,
      offsetSample: 5_000,
      gainDb: 2.0,
    });
  });

  it('sorts by startSample WITHIN one track — storage order is not reading order', () => {
    // Deletion check (R26/coverage discipline): the test above resolves two
    // clips that each live ALONE on their own track, so `Array.forEach` over
    // `session.tracks` already visits them in reading order with no sort at
    // all — deleting `clipsToClipboardEntries`'s own `hits.sort(...)` left
    // that test green. This fixture puts two clips on the SAME track, stored
    // in the track's `clips` array in DESCENDING start order (never sorted —
    // `Track.clips`'s own docblock says storage order is not an invariant a
    // caller may assume), so only the explicit sort can produce reading
    // order here.
    const doc = addSourceDoc();
    const t0 = createTrack('T0');
    const late = createClip({ documentId: doc.id, startSample: 200_000, offsetSample: 0, lengthSample: 10_000 });
    const early = createClip({ documentId: doc.id, startSample: 50_000, offsetSample: 0, lengthSample: 10_000 });
    t0.clips = [late, early]; // storage order: late first
    const session: Session = { name: 'Same-track order', sampleRate: SESSION_RATE, tracks: [t0] };

    const entries = clipsToClipboardEntries(session, [late.id, early.id]);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ startOffsetSample: 0, lengthSample: 10_000 }); // "early", reading-order first
    expect(entries[1]).toMatchObject({ startOffsetSample: 150_000, lengthSample: 10_000 }); // "late"
  });
});

describe('pastedClipGeometry — the one place the rate rule exists (L4b)', () => {
  it('ratio 1 returns the stored values verbatim', () => {
    const doc = addSourceDoc();
    const { session, c1 } = buildSession(doc.id);
    const [entry0] = clipsToClipboardEntries(session, [c1.id]);

    expect(pastedClipGeometry(entry0, 240_000, 1)).toEqual({
      startSample: 240_000,
      offsetSample: 12_000,
      lengthSample: 72_000,
      fadeInSample: 4_800,
    });
  });

  it('rate conversion at ratio 44_100/48_000: length and fades scale, offsetSample does not', () => {
    const doc = addSourceDoc();
    const { session, c1, c2 } = buildSession(doc.id);
    const [entry0, entry1] = clipsToClipboardEntries(session, [c1.id, c2.id]);
    const ratio = 44_100 / 48_000;

    const geo0 = pastedClipGeometry(entry0, 100_000, ratio);
    expect(geo0.startSample).toBe(100_000);
    expect(geo0.lengthSample).toBe(66_150);
    expect(geo0.fadeInSample).toBe(4_410);
    expect(geo0.offsetSample).toBe(12_000); // unconverted — DOCUMENT samples

    const geo1 = pastedClipGeometry(entry1, 100_000, ratio);
    expect(geo1.startSample).toBe(122_050);
    expect(geo1.lengthSample).toBe(33_075);
  });
});

describe('pasteClipsAtCursor — the paste target (L2, K2/K3)', () => {
  it('lands c1 on the current track (T2, index 2) at the bar, c2 on index 3; track 1 is untouched', () => {
    const doc = addSourceDoc();
    const { session, c1, c2 } = buildSession(doc.id);
    installSession(session, { currentTrackId: session.tracks[2].id, mtCursorSample: 240_000 });
    useSessionStore.getState().setSelectedClips([c1.id, c2.id]);
    expect(copySelectedClips()).toBe(true);

    const placed = pasteClipsAtCursor();

    expect(placed).toHaveLength(2);
    // Track 2 (index 2) already held the ORIGINAL c2 — the pasted c1' lands
    // there ALONGSIDE it, not instead of it.
    expect(clipsOn(2)).toHaveLength(2);
    const pastedC1 = clipsOn(2).find((c) => c.id !== c2.id);
    expect(pastedC1).toMatchObject({ startSample: 240_000, lengthSample: 72_000 });
    expect(clipsOn(3)).toHaveLength(1);
    expect(clipsOn(3)[0]).toMatchObject({ startSample: 264_000, lengthSample: 36_000 });
    // Track 1 still holds exactly the ORIGINAL c1 — paste never mutates a
    // source clip, and never touches a track it was not asked to.
    expect(clipsOn(1)).toEqual([c1]);
  });

  it('track clamp: with currentTrackId T3 (the last track), both entries land on index 3 and the track count is unchanged', () => {
    const doc = addSourceDoc();
    const { session, c1, c2 } = buildSession(doc.id);
    installSession(session, { currentTrackId: session.tracks[3].id, mtCursorSample: 240_000 });
    useSessionStore.getState().setSelectedClips([c1.id, c2.id]);
    copySelectedClips();

    pasteClipsAtCursor();

    expect(useSessionStore.getState().session.tracks).toHaveLength(4);
    expect(clipsOn(3)).toHaveLength(2); // the two pasted clips overlap here, verbatim
  });

  it('one undo entry: 4 clips after the paste, one Ctrl+Z back to 2, one Ctrl+Y back to 4', () => {
    const doc = addSourceDoc();
    const { session, c1, c2 } = buildSession(doc.id);
    installSession(session, { currentTrackId: session.tracks[2].id, mtCursorSample: 240_000 });
    useSessionStore.getState().setSelectedClips([c1.id, c2.id]);
    copySelectedClips();

    pasteClipsAtCursor();
    expect(allClips()).toHaveLength(4);

    undoSession();
    expect(allClips()).toHaveLength(2);

    redoSession();
    expect(allClips()).toHaveLength(4);
  });

  // Fix round 1 (addendum item 3) — `pastedClipGeometry` is unit-tested at a
  // rate ratio elsewhere, but that test hands `ratio` in as a bare number;
  // nothing before this test exercised `pasteClipsAtCursor`'s OWN wiring of
  // `ratio = session.sampleRate / payload.sampleRate` (`clipClipboard.ts`),
  // so inverting that line (`payload.sampleRate / session.sampleRate`) would
  // have passed the whole suite. This copies in a 48_000 Hz session and
  // pastes into a DIFFERENT, LIVE 44_100 Hz session — the clipboard is a
  // module slot that survives a session swap, exactly like it survives
  // `newSession` in the app.
  it('cross-rate paste: the ratio is session.sampleRate / payload.sampleRate, not the inverse', () => {
    const doc = addSourceDoc();
    const { session: sourceSession, c1 } = buildSession(doc.id);
    installSession(sourceSession, { currentTrackId: sourceSession.tracks[2].id });
    useSessionStore.getState().setSelectedClips([c1.id]);
    copySelectedClips(); // clipClipboard.sampleRate = 48_000 (SESSION_RATE)

    const u0 = createTrack('U0');
    const targetSession: Session = { name: 'Target session', sampleRate: 44_100, tracks: [u0] };
    installSession(targetSession, { currentTrackId: u0.id, mtCursorSample: 100_000 });

    const placed = pasteClipsAtCursor();

    expect(placed).toHaveLength(1);
    const pasted = clipsOn(0)[0];
    expect(pasted.startSample).toBe(100_000);
    // ratio = 44_100 / 48_000 = 0.91875, so lengthSample = round(72_000 *
    // 0.91875) = 66_150. The inverted wiring (48_000 / 44_100 = 1.0884…)
    // would instead produce 78_367 — a clearly different, non-coincidental
    // value, which is what makes this test a real discriminator between the
    // two directions rather than one that happens to agree with both.
    expect(pasted.lengthSample).toBe(66_150);
    expect(pasted.offsetSample).toBe(12_000); // unconverted — DOCUMENT samples
  });

  it('primary: selectedClipId is the topmost track/earliest pasted clip; a second paste does not consume the clipboard', () => {
    const doc = addSourceDoc();
    const { session, c1, c2 } = buildSession(doc.id);
    installSession(session, { currentTrackId: session.tracks[2].id, mtCursorSample: 240_000 });
    useSessionStore.getState().setSelectedClips([c1.id, c2.id]);
    copySelectedClips();

    const [pastedC1, pastedC2] = pasteClipsAtCursor();
    const { selectedClipId, selectedClipIds } = useSessionStore.getState();
    // Set-equality, not array-order: the primary-selection trick (reversed
    // against setSelectedClips's last-id-wins rule, matching lot K's
    // marquee) puts the reading-order-FIRST id LAST in the array so it wins
    // as primary — the array's own order is an implementation detail of that
    // trick, not a claim this test pins.
    expect(new Set(selectedClipIds)).toEqual(new Set([pastedC1, pastedC2]));
    expect(selectedClipId).toBe(pastedC1); // topmost track (index 2), earliest start

    const placedAgain = pasteClipsAtCursor();
    expect(placedAgain).toHaveLength(2);
    expect(allClips()).toHaveLength(6); // paste never consumes the clipboard
    expect(getClipboardKind()).toBe('clips');
  });
});

describe('copySelectedClips — an empty selection leaves the clipboard alone (L1)', () => {
  it('returns false and does not disturb a standing audio clipboard', () => {
    const doc = addSourceDoc();
    const { session } = buildSession(doc.id);
    installSession(session);
    setClipboard({ channels: [new Float32Array(10)], sampleRate: 22_050 });

    expect(useSessionStore.getState().selectedClipIds).toEqual([]);
    expect(copySelectedClips()).toBe(false);

    expect(getClipboardKind()).toBe('audio');
  });
});

describe('pasteBlockReason (L3, L4a, Risk 4)', () => {
  // Fix round 1 (addendum item 4) — Risk 10's cold-store case had zero
  // references: `PASTE_EMPTY_REASON` was reachable from every other test's
  // fixture (they all copy something first) but never asserted on its own.
  // Deleting the `if (kind === null) return PASTE_EMPTY_REASON;` line makes
  // `pasteBlockReason()` fall through to `undefined` here — Paste would
  // light up over a genuinely empty clipboard and do nothing on a press.
  it('PASTE_EMPTY_REASON with a live current track but nothing ever copied', () => {
    const doc = addSourceDoc();
    const { session } = buildSession(doc.id);
    installSession(session, { currentTrackId: session.tracks[2].id });

    expect(getClipboardKind()).toBeNull();
    expect(pasteBlockReason()).toBe(PASTE_EMPTY_REASON);
  });

  it('PASTE_NO_TRACK_REASON with a clip clipboard but no current track', () => {
    const doc = addSourceDoc();
    const { session, c1 } = buildSession(doc.id);
    installSession(session, { currentTrackId: null });
    useSessionStore.getState().setSelectedClips([c1.id]);
    copySelectedClips();

    expect(pasteBlockReason()).toBe(PASTE_NO_TRACK_REASON);
  });

  it('PASTE_HOLDS_AUDIO_REASON once an audio copy retires the clip clipboard', () => {
    const doc = addSourceDoc();
    const { session, c1 } = buildSession(doc.id);
    installSession(session, { currentTrackId: session.tracks[2].id });
    useSessionStore.getState().setSelectedClips([c1.id]);
    copySelectedClips();

    setClipboard({ channels: [new Float32Array(10)], sampleRate: 22_050 });

    expect(pasteBlockReason()).toBe(PASTE_HOLDS_AUDIO_REASON);
  });

  it('PASTE_CLOSED_SOURCE_REASON once the source document is removed from appStore, and Paste places nothing', () => {
    const doc = addSourceDoc();
    const { session, c1 } = buildSession(doc.id);
    installSession(session, { currentTrackId: session.tracks[2].id, mtCursorSample: 240_000 });
    useSessionStore.getState().setSelectedClips([c1.id]);
    copySelectedClips();
    expect(getClipClipboard()).not.toBeNull();

    useAppStore.setState((s) => ({ documents: s.documents.filter((d) => d.id !== doc.id) }));

    expect(pasteBlockReason()).toBe(PASTE_CLOSED_SOURCE_REASON);

    const before = allClips().length;
    const placed = pasteClipsAtCursor();
    expect(placed).toEqual([]);
    expect(allClips()).toHaveLength(before);
  });
});
