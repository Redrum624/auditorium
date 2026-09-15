import { commandReason, isCommandEnabled, runCommand } from './menuActions';
import { registerEffectCommands } from './menuActions';
import { registerAllEffects } from '../effects/registerAll';
import { acquirePass, isPassRunning, runExclusivePass, _resetPassLock } from './passLock';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { useSessionStore } from '../multitrack/sessionStore';
import { createDocument, docLength } from '../audio/AudioDocument';
import { pushUndo } from './undoHistory';
import { _resetSessionUndo } from '../multitrack/sessionUndo';
import * as sessionFileModule from '../multitrack/sessionFile';

// Fix round 1 (MED, #3) — `runExclusivePass` is wrapped as a spy over the
// REAL implementation, so every test above still exercises the genuine
// acquire/release, but `mixdownToNewFile`/`runProjectSave`/`tempo.detect`'s
// own wraps can be pinned by asserting the CALL itself, not just an outcome
// the outer `enabled` gate would already produce on its own (the review's
// finding: the outer `&& passFree()` gate short-circuits `runCommand` before
// `mixdownToNewFile` is ever entered, so a document-count assertion alone
// proves nothing about the wrap inside it).
jest.mock('./passLock', () => {
  const actual = jest.requireActual('./passLock');
  return { ...actual, runExclusivePass: jest.fn(actual.runExclusivePass) };
});
const mockRunExclusivePass = runExclusivePass as jest.MockedFunction<typeof runExclusivePass>;

// `file.save` -> `runProjectSave` -> `saveProject` (sessionFile.ts); auto-
// mocked exactly as `menuActions.test.ts` does, so Save never touches real
// file I/O — this file only cares whether the WRAP around it was taken.
jest.mock('../multitrack/sessionFile');
const mockSaveProject = sessionFileModule.saveProject as jest.MockedFunction<
  typeof sessionFileModule.saveProject
>;

// `tempo.detect` -> `runTempoAnalysis` (tempoAnalysis.ts); mocked exactly as
// `menuActions.test.ts` does, so Detect Tempo never runs real DSP here.
jest.mock('./tempoAnalysis', () => ({
  runTempoAnalysis: jest.fn(async () => null),
}));

// Risk (lot-m-brief.md): `registerEffectCommands` is the 20th registrar and
// runs from `App.tsx`, not at module scope — any test asserting `effect.<id>`
// gating must seed it explicitly, as `menuActions.test.ts` already does.
registerAllEffects();
registerEffectCommands();

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  useSessionStore.getState().newSession(44100);
  useSessionStore.getState().setProjectPath(null);
  _resetSessionUndo();
  _resetPassLock();
  mockRunExclusivePass.mockClear();
  mockSaveProject.mockReset();
  mockSaveProject.mockResolvedValue(true);
});

afterEach(() => {
  _resetPassLock();
});

function openDoc(name = 'a') {
  const doc = createDocument({ name, sampleRate: 44100, channels: [new Float32Array(1000)] });
  useAppStore.getState().addDocument(doc);
  return doc;
}

// Acceptance 4 / 5 — FAILS TODAY. With a document open and a pipeline pass
// holding the lock: the command registry is the ONE surface that knows about
// it, and every OTHER pass-start command reads it — while the commands that
// merely act on the live document (undo, transport, markers) do not.
describe('the lock gates every pass-start command (acceptance 4/5)', () => {
  it('disables tempo.detect, edit.separateStems and file.export, naming the running pass', () => {
    const doc = openDoc();
    expect(isCommandEnabled('tempo.detect')).toBe(true);
    expect(isCommandEnabled('edit.separateStems')).toBe(true);
    expect(isCommandEnabled('file.export')).toBe(true);

    const release = acquirePass({ id: 'effects.vocalChain', label: 'Vocal Chain', kind: 'pipeline' });
    expect(release).not.toBeNull();

    expect(isCommandEnabled('tempo.detect')).toBe(false);
    expect(isCommandEnabled('edit.separateStems')).toBe(false);
    expect(isCommandEnabled('file.export')).toBe(false);
    expect(commandReason('tempo.detect')).toContain('Vocal Chain');
    expect(commandReason('edit.separateStems')).toContain('Vocal Chain');
    expect(commandReason('file.export')).toContain('Vocal Chain');

    release!();
    expect(isCommandEnabled('tempo.detect')).toBe(true);
    void doc;
  });

  it('disables the effect.<id> door too — the registry bypass EffectsPanel closed', () => {
    openDoc();
    expect(isCommandEnabled('effect.amplify')).toBe(true);

    const release = acquirePass({ id: 'effects.vocalChain', label: 'Vocal Chain', kind: 'pipeline' });
    expect(isCommandEnabled('effect.amplify')).toBe(false);
    expect(commandReason('effect.amplify')).toContain('Vocal Chain');
    release!();
  });

  it('M-c: disables file.open, file.new, file.close and session.open, naming the running pass', () => {
    openDoc();
    const release = acquirePass({ id: 'effects.vocalChain', label: 'Vocal Chain', kind: 'pipeline' });

    for (const id of ['file.open', 'file.new', 'file.close', 'session.open']) {
      expect(isCommandEnabled(id)).toBe(false);
      expect(commandReason(id)).toContain('Vocal Chain');
    }

    release!();
    for (const id of ['file.open', 'file.new', 'file.close', 'session.open']) {
      expect(isCommandEnabled(id)).toBe(true);
    }
  });

  it('M6: undo, play/pause and add marker all stay enabled — the app is not mutely dead', () => {
    const doc = openDoc();
    pushUndo({ label: 'Amplify', docId: doc.id, undo() {}, redo() {} });

    const release = acquirePass({ id: 'effects.vocalChain', label: 'Vocal Chain', kind: 'pipeline' });

    expect(isCommandEnabled('edit.undo')).toBe(true);
    expect(isCommandEnabled('transport.playPause')).toBe(true);
    expect(isCommandEnabled('marker.add')).toBe(true);

    release!();
  });

  // Fix round 1 (item 5b) — overturns M-d's original exclusion, and the test
  // that used to pin `transport.record` as staying enabled here. A recording
  // ends with `addDocument`, minting a new ACTIVE document exactly like
  // `file.new`/`file.open` do — the same hazard M-c's four gated commands
  // exist to close, and the user's own words name a "process" too.
  it('transport.record is gated too — a recording mints a new active document, same as file.new', () => {
    openDoc();
    expect(isCommandEnabled('transport.record')).toBe(true);

    const release = acquirePass({ id: 'effects.vocalChain', label: 'Vocal Chain', kind: 'pipeline' });

    expect(isCommandEnabled('transport.record')).toBe(false);
    expect(commandReason('transport.record')).toContain('Vocal Chain');

    release!();
    expect(isCommandEnabled('transport.record')).toBe(true);
  });
});

// Acceptance 6 — the run wrapper: `multitrack.mixdown` actually acquires and
// releases the lock around its own work, and a lock held by ANOTHER pass
// blocks the command from producing a document at all.
describe('multitrack.mixdown holds the lock around its own run (acceptance 6)', () => {
  function seedTwoClipSession(): void {
    const a = openDoc('a');
    const b = openDoc('b');
    useAppStore.getState().setView('multitrack');
    useSessionStore.getState().addTrack();
    useSessionStore.getState().addTrack();
    const [trackA, trackB] = useSessionStore.getState().session.tracks;
    useSessionStore.getState().addClip(trackA.id, {
      id: 'clip-a',
      documentId: a.id,
      startSample: 0,
      offsetSample: 0,
      lengthSample: docLength(a),
      gainDb: 0,
    });
    useSessionStore.getState().addClip(trackB.id, {
      id: 'clip-b',
      documentId: b.id,
      startSample: 0,
      offsetSample: 0,
      lengthSample: docLength(b),
      gainDb: 0,
    });
  }

  it('produces Mixdown 1 and releases the lock once the promise resolves', async () => {
    seedTwoClipSession();

    await runCommand('multitrack.mixdown');

    const mix = useAppStore.getState().documents.find((d) => d.name === 'Mixdown 1');
    expect(mix).toBeDefined();
    expect(isPassRunning()).toBe(false);
    // The seeded set for the refusal case below: the two sources plus this
    // mixdown.
    expect(useAppStore.getState().documents).toHaveLength(3);
  });

  it('adds no document when a different pass already holds the lock', async () => {
    seedTwoClipSession();
    await runCommand('multitrack.mixdown'); // documents.length -> 3 (seeded)
    expect(useAppStore.getState().documents).toHaveLength(3);

    const release = acquirePass({ id: 'edit.transcribe', label: 'Transcribe', kind: 'pipeline' });

    await runCommand('multitrack.mixdown');

    expect(useAppStore.getState().documents).toHaveLength(3);
    release!();
  });
});

// Fix round 1 (MED, #3) — the three bodies with no hosted dialog behind them
// (M-b: "the START seam") take the lock THEMSELVES via `runExclusivePass`.
// Pinned here by asserting the call itself, with its exact descriptor —
// deleting any of the three `runExclusivePass(...)` wraps in `menuActions.ts`
// fails the matching test below, independent of the outer `enabled` gate.
describe('the three runExclusivePass wraps — pinned by the call itself (fix round 1)', () => {
  it('multitrack.mixdown wraps mixdownToNewFile in runExclusivePass with the documented descriptor', async () => {
    const a = openDoc('a');
    const b = openDoc('b');
    useAppStore.getState().setView('multitrack');
    useSessionStore.getState().addTrack();
    useSessionStore.getState().addTrack();
    const [trackA, trackB] = useSessionStore.getState().session.tracks;
    useSessionStore.getState().addClip(trackA.id, {
      id: 'clip-a',
      documentId: a.id,
      startSample: 0,
      offsetSample: 0,
      lengthSample: docLength(a),
      gainDb: 0,
    });
    useSessionStore.getState().addClip(trackB.id, {
      id: 'clip-b',
      documentId: b.id,
      startSample: 0,
      offsetSample: 0,
      lengthSample: docLength(b),
      gainDb: 0,
    });

    await runCommand('multitrack.mixdown');

    expect(mockRunExclusivePass).toHaveBeenCalledWith(
      { id: 'multitrack.mixdown', label: 'Mix Down', kind: 'mixdown' },
      expect.any(Function)
    );
  });

  it('file.save wraps runProjectSave in runExclusivePass with the documented descriptor', async () => {
    openDoc(); // content + never-written project -> projectHasUnsavedWork() true
    expect(isCommandEnabled('file.save')).toBe(true);

    await runCommand('file.save');

    expect(mockSaveProject).toHaveBeenCalledWith({ as: false });
    expect(mockRunExclusivePass).toHaveBeenCalledWith(
      { id: 'file.save', label: 'Save Project', kind: 'save' },
      expect.any(Function)
    );
  });

  it('tempo.detect wraps runTempoAnalysis in runExclusivePass with the documented descriptor', async () => {
    openDoc();

    await runCommand('tempo.detect');

    expect(mockRunExclusivePass).toHaveBeenCalledWith(
      { id: 'tempo.detect', label: 'Detect Tempo', kind: 'pipeline' },
      expect.any(Function)
    );
  });
});
