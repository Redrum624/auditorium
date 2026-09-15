import { commandReason, isCommandEnabled, registerEffectCommands } from './menuActions';
import { registerAllEffects } from '../effects/registerAll';
import { clipPassReason, clipPassTarget } from './clipPass';
import { useAppStore, makeInitialState } from '../stores/appStore';
import { useSessionStore } from '../multitrack/sessionStore';
import { createClip } from '../multitrack/session';
import { createDocument, type AudioDocument } from '../audio/AudioDocument';
import { _resetSessionUndo } from '../multitrack/sessionUndo';
import { _resetPassLock, acquirePass } from './passLock';

/**
 * Lot D (item 4), acceptance 8-9 — the registry-level refusals (D2/D2-a, D3,
 * D4, orphan) and the Risk-4 pin: the ACTIVE VIEW decides the target, never
 * whichever selection was set last (D1).
 */

registerAllEffects();
registerEffectCommands();

const SR = 44_100;

/** The eight in-place rows D2/D2-a name (Process §3's list). */
const EIGHT_ROWS = [
  'effect.amplify',
  'noise.capture',
  'tempo.detect',
  'tempo.match',
  'timing.align',
  'effects.vocalChain',
  'effects.podcastChain',
  'lyrics.align',
];

function openDoc(name = 'a', length = 8192): AudioDocument {
  const doc = createDocument({ name, sampleRate: SR, channels: [new Float32Array(length)] });
  useAppStore.getState().addDocument(doc);
  return doc;
}

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  useSessionStore.getState().newSession(SR);
  useSessionStore.getState().setProjectPath(null);
  _resetSessionUndo();
  _resetPassLock();
});

describe('acceptance 8 — multitrack refusals, registry level', () => {
  it('0 clips selected: the eight rows are disabled with the D2 reason (both escapes named)', () => {
    openDoc();
    useAppStore.getState().setView('multitrack');
    useSessionStore.getState().addTrack();
    // No clip added at all — selectedClipIds is empty.

    expect(isCommandEnabled('effects.vocalChain')).toBe(false);
    expect(commandReason('effects.vocalChain')).toBe(
      'Select a clip to run this on it, or switch to Waveform to run it on the whole file.'
    );
  });

  it('a standing selectedGap (D4): the same D2 reason — a gap is never a pipeline target', () => {
    openDoc();
    useAppStore.getState().setView('multitrack');
    useSessionStore.getState().addTrack();
    const trackId = useSessionStore.getState().session.tracks[0].id;
    useSessionStore.getState().setSelectedGap({ trackId, startSample: 0, endSample: 1000 });

    expect(isCommandEnabled('effects.vocalChain')).toBe(false);
    expect(commandReason('effects.vocalChain')).toBe(
      'Select a clip to run this on it, or switch to Waveform to run it on the whole file.'
    );
  });

  it('2 clips selected (D3): the "select a single clip" reason', () => {
    const doc = openDoc();
    useAppStore.getState().setView('multitrack');
    useSessionStore.getState().addTrack();
    const trackId = useSessionStore.getState().session.tracks[0].id;
    const a = createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 100 });
    const b = createClip({ documentId: doc.id, startSample: 200, offsetSample: 0, lengthSample: 100 });
    useSessionStore.getState().addClip(trackId, a);
    useSessionStore.getState().addClip(trackId, b);
    useSessionStore.getState().setSelectedClips([a.id, b.id]);

    expect(isCommandEnabled('effects.vocalChain')).toBe(false);
    expect(commandReason('effects.vocalChain')).toBe(
      'Select a single clip — a pass runs on one clip at a time.'
    );
  });

  it('a clip whose source document was closed: the orphan reason', () => {
    const doc = openDoc();
    useAppStore.getState().setView('multitrack');
    useSessionStore.getState().addTrack();
    const trackId = useSessionStore.getState().session.tracks[0].id;
    const clip = createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 100 });
    useSessionStore.getState().addClip(trackId, clip);
    useSessionStore.getState().setSelectedClips([clip.id]);

    useAppStore.getState().closeDocument(doc.id);

    expect(isCommandEnabled('effects.vocalChain')).toBe(false);
    expect(commandReason('effects.vocalChain')).toBe(
      "This clip's source file is closed. Reopen it to run this."
    );
  });

  it('effects.coverChain: disabled in multitrack outright, with its own reason', () => {
    const doc = openDoc();
    useAppStore.getState().setView('multitrack');
    useSessionStore.getState().addTrack();
    const trackId = useSessionStore.getState().session.tracks[0].id;
    const clip = createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 100 });
    useSessionStore.getState().addClip(trackId, clip);
    useSessionStore.getState().setSelectedClips([clip.id]);

    expect(isCommandEnabled('effects.coverChain')).toBe(false);
    expect(commandReason('effects.coverChain')).toBe(
      'Cover Chain builds a session of its own — switch to Waveform to run it.'
    );
  });

  it('one valid clip: all eight in-place rows are enabled', () => {
    const doc = openDoc();
    useAppStore.getState().setView('multitrack');
    useSessionStore.getState().addTrack();
    const trackId = useSessionStore.getState().session.tracks[0].id;
    const clip = createClip({ documentId: doc.id, startSample: 0, offsetSample: 0, lengthSample: 4096 });
    useSessionStore.getState().addClip(trackId, clip);
    useSessionStore.getState().setSelectedClips([clip.id]);

    for (const id of EIGHT_ROWS) {
      expect(isCommandEnabled(id)).toBe(true);
    }
  });
});

// Acceptance 9 — Risk 4's pin: the VIEW decides, never a standing clip
// selection left over from a prior visit to multitrack.
describe('acceptance 9 — the view decides, not the clip selection', () => {
  it('waveform view with a clip selection still standing in the session store: effect.amplify reads the active document', () => {
    openDoc();
    useSessionStore.getState().addTrack();
    const trackId = useSessionStore.getState().session.tracks[0].id;
    const otherDoc = createDocument({ name: 'b', sampleRate: SR, channels: [new Float32Array(100)] });
    const clip = createClip({ documentId: otherDoc.id, startSample: 0, offsetSample: 0, lengthSample: 50 });
    useSessionStore.getState().addClip(trackId, clip);
    useSessionStore.getState().setSelectedClips([clip.id]);

    // view is 'waveform' (makeInitialState's default) — never switched to
    // multitrack — and a real selection stands on the active document too.
    useAppStore.getState().setSelection({ start: 12_000, end: 60_000 });

    expect(useAppStore.getState().view).toBe('waveform');
    expect(isCommandEnabled('effect.amplify')).toBe(true);
    expect(clipPassTarget()).toBe('not-multitrack');
  });
});

// `clipPassReason` itself — every refusal string, verbatim (X3).
describe('clipPassReason — the exact strings', () => {
  it('matches decisions.md/the brief verbatim', () => {
    expect(clipPassReason('no-clip')).toBe(
      'Select a clip to run this on it, or switch to Waveform to run it on the whole file.'
    );
    expect(clipPassReason('multi-clip')).toBe(
      'Select a single clip — a pass runs on one clip at a time.'
    );
    expect(clipPassReason('orphan-clip')).toBe(
      "This clip's source file is closed. Reopen it to run this."
    );
    expect(clipPassReason('empty-window')).toBe('This clip reads nothing from its source file.');
    expect(clipPassReason('not-multitrack')).toBeUndefined();
  });
});

// Fix round 1 (finding 9) — the reason PRECEDENCE (`pipelineReason` composing
// `passReason() ?? passTargetReason(s)`) had no test naming both conditions
// at once. In multitrack with NO clip selected (a real target reason exists)
// AND a different pass already holding the lock (a real busy reason exists
// too), the busy reason must win — it is the more urgent, app-wide fact.
describe('reason precedence (fix round 1, finding 9): a running pass outranks a missing target', () => {
  beforeEach(() => {
    useAppStore.setState(makeInitialState());
    useSessionStore.getState().newSession(SR);
    useSessionStore.getState().setProjectPath(null);
    _resetSessionUndo();
    _resetPassLock();
  });

  it('shows the busy reason, not the D2 target reason, when both conditions hold', () => {
    openDoc();
    useAppStore.getState().setView('multitrack');
    useSessionStore.getState().addTrack();
    // No clip selected — passTargetReason() alone would name D2's string.

    const release = acquirePass({ id: 'edit.remix', label: 'Auto-Remix', kind: 'pipeline' });
    expect(release).not.toBeNull();

    expect(isCommandEnabled('effects.vocalChain')).toBe(false);
    const reason = commandReason('effects.vocalChain');
    expect(reason).toContain('Auto-Remix');
    expect(reason).not.toContain('Select a clip');

    release!();
  });

  // `noise.capture` is the one row this lot deliberately EXCLUDES from the
  // composition (M-d: never gated on the pass lock) — its reason must stay
  // the pure target reason even while an unrelated pass runs, or the row
  // would misattribute its OWN (unrelated) disablement to the lock.
  it('noise.capture keeps the pure target reason even while a different pass runs', () => {
    openDoc();
    useAppStore.getState().setView('multitrack');
    useSessionStore.getState().addTrack();

    const release = acquirePass({ id: 'edit.remix', label: 'Auto-Remix', kind: 'pipeline' });

    // noise.capture is not gated on the lock at all — still enabled/disabled
    // purely by whether it has a target, unaffected by the running pass.
    expect(isCommandEnabled('noise.capture')).toBe(false);
    expect(commandReason('noise.capture')).toBe(
      'Select a clip to run this on it, or switch to Waveform to run it on the whole file.'
    );

    release!();
  });
});

// Fix round 1 (finding 9) — pins the deliberate deviation from the brief's
// literal `effects.coverChain` predicate (report §7): `passFree()` is KEPT,
// so a running pass still refuses Cover Chain even outside multitrack, where
// D1's own multitrack refusal does not apply.
describe('effects.coverChain keeps the pass-lock gate (fix round 1, finding 9)', () => {
  beforeEach(() => {
    useAppStore.setState(makeInitialState());
    _resetPassLock();
  });

  it('is disabled and names the running pass, in waveform, with an active document', () => {
    openDoc();
    expect(isCommandEnabled('effects.coverChain')).toBe(true);

    const release = acquirePass({ id: 'tempo.detect', label: 'Detect Tempo', kind: 'pipeline' });

    expect(isCommandEnabled('effects.coverChain')).toBe(false);
    expect(commandReason('effects.coverChain')).toContain('Detect Tempo');

    release!();
    expect(isCommandEnabled('effects.coverChain')).toBe(true);
  });
});
