import { isCommandEnabled, runCommand } from './menuActions';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { createDocument, docLength } from '../audio/AudioDocument';
import { createClip, createTrack, type Session } from '../multitrack/session';
import { useSessionStore } from '../multitrack/sessionStore';
import { _resetSessionUndo } from '../multitrack/sessionUndo';
import type { TimeRange } from '../multitrack/timeRange';

/**
 * Lot J (item 10) — `edit.trim`/`edit.silence`'s MULTITRACK arm: view-routed
 * enablement, the `mtRangeScopeTrackIds` scope rule (J2/J2-a), `edit.deselect`
 * clearing the range, J9 (Ctrl+A does not also set one), and the editor arm
 * left intact (F1's argument still applies to Cut/Copy/Paste and still
 * applies to Trim/Silence in the DOCUMENT views).
 *
 * Shared fixture (X3 — non-identity): session rate 48 000; `T1` = `c1
 * {start: 20_000, len: 30_000, offsetSample: 5_000}`; `T2` = `c2 {start:
 * 60_000, len: 40_000}`, `c3 {start: 120_000, len: 25_000}`; `T3` = `c4
 * {start: 10_000, len: 200_000}`. Range `R = {startSample: 40_000, endSample:
 * 130_000}`.
 */

const store = () => useSessionStore.getState();
const R: TimeRange = { startSample: 40_000, endSample: 130_000 };

function seed(): { session: Session; t1: string; t2: string; t3: string; c1: string; c4: string } {
  const t1 = createTrack('T1');
  const t2 = createTrack('T2');
  const t3 = createTrack('T3');
  const c1 = createClip({ documentId: 'doc-1', startSample: 20_000, offsetSample: 5_000, lengthSample: 30_000 });
  const c2 = createClip({ documentId: 'doc-1', startSample: 60_000, offsetSample: 0, lengthSample: 40_000 });
  const c3 = createClip({ documentId: 'doc-1', startSample: 120_000, offsetSample: 0, lengthSample: 25_000 });
  const c4 = createClip({ documentId: 'doc-1', startSample: 10_000, offsetSample: 0, lengthSample: 200_000 });
  t1.clips = [c1];
  t2.clips = [c2, c3];
  t3.clips = [c4];
  const session: Session = { name: 'Range Fixture', sampleRate: 48_000, tracks: [t1, t2, t3] };
  useSessionStore.setState({
    session,
    selectedClipId: null,
    selectedClipIds: [],
    selectedGap: null,
    currentTrackId: null,
    lastSplit: null,
    mtCursorSample: 0,
    mtTimeRange: null,
    mtZoom: { samplesPerPixel: 500, scrollSample: 0 },
    mtPlayState: 'stopped',
    mtPlayheadSample: 0,
    mtEnvelope: null,
  });
  return { session, t1: t1.id, t2: t2.id, t3: t3.id, c1: c1.id, c4: c4.id };
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  _resetSessionUndo();
});

describe('edit.trim / edit.silence — multitrack enablement (J1-J9)', () => {
  it('FAILS TODAY: a standing range with NOTHING selected enables both', () => {
    seed();
    useAppStore.getState().setView('multitrack');
    store().setMtTimeRange(R);
    expect(store().selectedClipIds).toEqual([]);
    expect(isCommandEnabled('edit.trim')).toBe(true);
    expect(isCommandEnabled('edit.silence')).toBe(true);
  });

  it('both are false with mtTimeRange === null', () => {
    seed();
    useAppStore.getState().setView('multitrack');
    expect(store().mtTimeRange).toBeNull();
    expect(isCommandEnabled('edit.trim')).toBe(false);
    expect(isCommandEnabled('edit.silence')).toBe(false);
  });

  it('in waveform, a document selection still lights both and the run edits the document (F1 editor arm intact)', async () => {
    const doc = createDocument({
      name: 'a.wav',
      sampleRate: 44100,
      channels: [new Float32Array(1000)],
    });
    useAppStore.getState().addDocument(doc);
    useAppStore.getState().setSelection({ start: 100, end: 400 });
    useAppStore.getState().setView('waveform');

    expect(isCommandEnabled('edit.trim')).toBe(true);
    expect(isCommandEnabled('edit.silence')).toBe(true);

    await runCommand('edit.trim');
    const after = useAppStore.getState().documents.find((d) => d.id === doc.id)!;
    expect(docLength(after)).toBe(300); // 400 - 100: the document was actually trimmed
  });
});

describe('edit.trim scope (J2/J2-a)', () => {
  it('with only c1 selected, Trim reaches c1 alone; c4 is untouched', async () => {
    const { c1, c4 } = seed();
    useAppStore.getState().setView('multitrack');
    store().setMtTimeRange(R);
    store().setSelectedClip(c1);

    await runCommand('edit.trim');

    const byId = (id: string) => store().session.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
    expect(byId(c1)).toMatchObject({ startSample: 40_000, lengthSample: 10_000 });
    expect(byId(c4)).toMatchObject({ startSample: 10_000, lengthSample: 200_000 }); // c4's OWN track was not scoped
  });

  it('with nothing selected, Trim reaches every track (mtRangeScopeTrackIds falls back to all)', async () => {
    const { c1, c4 } = seed();
    useAppStore.getState().setView('multitrack');
    store().setMtTimeRange(R);
    expect(store().selectedClipIds).toEqual([]);

    await runCommand('edit.trim');

    const byId = (id: string) => store().session.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
    expect(byId(c1)).toMatchObject({ startSample: 40_000, lengthSample: 10_000 });
    expect(byId(c4)).toMatchObject({ startSample: 40_000, lengthSample: 90_000 }); // now reached too
  });
});

describe('edit.deselect clears the range (J5/J6)', () => {
  it('is enabled with a range and no clip selection, and clears mtTimeRange to null', () => {
    seed();
    useAppStore.getState().setView('multitrack');
    store().setMtTimeRange(R);
    expect(store().selectedClipId).toBeNull();

    expect(isCommandEnabled('edit.deselect')).toBe(true);
    void runCommand('edit.deselect');
    expect(store().mtTimeRange).toBeNull();
  });
});

describe('J9 — Ctrl+A does not also set the range', () => {
  it('Select All in multitrack leaves mtTimeRange null', async () => {
    seed();
    useAppStore.getState().setView('multitrack');
    await runCommand('edit.selectAll');
    expect(store().mtTimeRange).toBeNull();
  });

  it('a whole-timeline range greys Trim (trimTargets emits no target — not a silent no-op button)', () => {
    seed();
    useAppStore.getState().setView('multitrack');
    // Covers every clip on every track: nothing would change.
    store().setMtTimeRange({ startSample: 0, endSample: 1_000_000 });
    expect(isCommandEnabled('edit.trim')).toBe(false);
  });
});

describe('edit.rippleDeleteTime stays disabled with a range standing', () => {
  it('is disabled in multitrack even with mtTimeRange set', () => {
    seed();
    useAppStore.getState().setView('multitrack');
    store().setMtTimeRange(R);
    expect(isCommandEnabled('edit.rippleDeleteTime')).toBe(false);
  });
});
