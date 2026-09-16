/**
 * Fix round 3 (item 2) — a table-driven test that drives EVERY hosted
 * dialog's own start control through the same question: with a FOREIGN pass
 * already holding `passLock.ts`'s app-wide lock, is the button that launches
 * this dialog's OWN pass disabled?
 *
 * Before this file, only `EffectDialog` had any coverage of its fix-round-1
 * gate (`EffectDialog.test.tsx`). The other ten dialogs' `&& runningPass ===
 * null` clauses (added in fix round 1) had ZERO tests — deleting any one of
 * them left every existing suite green. This is the fifth time in this batch
 * a ruled behaviour turned out to have no real coverage; a table beats ten
 * hand-written tests here specifically because the next hosted dialog someone
 * adds joins the table by adding one row, not by remembering to write a new
 * test file.
 *
 * Each row's `setup()` reaches the SAME state each dialog's own test file
 * already reaches to prove its button enabled absent the lock — the recipes
 * are ported from (not shared with) `TempoDialog.test.tsx`,
 * `AlignTimingDialog.test.tsx`, `RemixDialog.test.tsx`,
 * `SeparateDialog.test.tsx`, `TranscribeDialog.test.tsx`,
 * `VoiceChangerDialog.test.tsx`, `AlignLyricsDialog.test.tsx`,
 * `VocalChainDialog.test.tsx`, `PodcastChainDialog.test.tsx` and
 * `CoverChainDialog.test.tsx`, so a change to one of those recipes (a gate
 * that now needs one more field filled) is a change here too — deliberate,
 * not a coincidence: if this file drifts out of sync with a dialog's real
 * gate, its own row starts asserting an already-enabled button and never
 * observes the lock at all, which is exactly why each row's `setup()` ends
 * by asserting the button is enabled BEFORE the lock is acquired.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import EffectDialog from './EffectDialog';
import TempoDialog from './TempoDialog';
import AlignTimingDialog from './AlignTimingDialog';
import RemixDialog from './RemixDialog';
import SeparateDialog from './SeparateDialog';
import TranscribeDialog from './TranscribeDialog';
import VoiceChangerDialog from './VoiceChangerDialog';
import AlignLyricsDialog from './AlignLyricsDialog';
import VocalChainDialog from './VocalChainDialog';
import PodcastChainDialog from './PodcastChainDialog';
import CoverChainDialog from './CoverChainDialog';
import { registerAllEffects } from '../../effects/registerAll';
import { createDocument } from '../../audio/AudioDocument';
import { useAppStore, makeInitialState } from '../../stores/appStore';
import { registerDialogSetters } from '../../services/dialogBus';
import { _resetPassLock, acquirePass } from '../../services/passLock';
import { installTranscribeBackend } from '../../__mocks__/transcribeBackend';

import {
  getTempo,
  regridTempo,
  runTempoAnalysis,
  runRemixAnalysis,
  setRemixAnalysis,
  type TempoEntry,
} from '../../services/tempoAnalysis';
import { applyTempoChange, detectRegionTempo } from '../../services/tempoService';
import { getBeatGrid, type BeatGrid } from '../../services/beatGrid';
import { applyTimingAlignment, suggestSyllableMarkers } from '../../services/timingAlignService';
import { createRemixDocument } from '../../services/remixService';
import { planRemix, type PlanRemixResult } from '../../dsp/remixPlan';
import { deriveRemixFeatures } from '../../dsp/remixFeatures';
import {
  getStemModelState,
  ensureStemModel,
  separateStems,
  cancelStemSeparation,
} from '../../services/stemService';
import { landStems, landVoice, landSpeakers } from '../../services/stemLanding';
import {
  getDiarizeModelState,
  ensureDiarizeModels,
  diarizeChannels,
  cancelDiarization,
} from '../../services/diarizeService';
import { runVocalChain } from '../../services/vocalChain';
import { runPodcastChain } from '../../services/podcastChain';
import { runCoverJourney } from '../../services/coverJourney';
import { applyMeasuredOffset } from '../../services/coverPlacement';

// ---------------------------------------------------------------------------
// Mocks — one factory per module path, MERGED across every dialog below that
// needs it (`tempoAnalysis` is shared by three). Everything pure stays real
// via `requireActual`; only the effectful/worker-backed entry points each
// dialog's OWN test file already mocks are swapped here.
// ---------------------------------------------------------------------------

jest.mock('../../services/tempoAnalysis', () => ({
  ...jest.requireActual('../../services/tempoAnalysis'),
  getTempo: jest.fn(),
  regridTempo: jest.fn(),
  runTempoAnalysis: jest.fn(),
  runRemixAnalysis: jest.fn(),
  setRemixAnalysis: jest.fn(),
}));
jest.mock('../../services/tempoService', () => ({
  ...jest.requireActual('../../services/tempoService'),
  applyTempoChange: jest.fn(),
  detectRegionTempo: jest.fn(),
}));
jest.mock('../../services/beatGrid', () => ({
  ...jest.requireActual('../../services/beatGrid'),
  getBeatGrid: jest.fn(),
}));
jest.mock('../../services/timingAlignService', () => ({
  ...jest.requireActual('../../services/timingAlignService'),
  applyTimingAlignment: jest.fn(),
  suggestSyllableMarkers: jest.fn(),
}));
jest.mock('../../services/remixService', () => ({
  ...jest.requireActual('../../services/remixService'),
  createRemixDocument: jest.fn(),
}));
jest.mock('../../dsp/remixPlan', () => ({
  ...jest.requireActual('../../dsp/remixPlan'),
  planRemix: jest.fn(),
}));
jest.mock('../../dsp/remixFeatures', () => ({
  ...jest.requireActual('../../dsp/remixFeatures'),
  deriveRemixFeatures: jest.fn(),
}));
jest.mock('../../services/stemService', () => ({
  ...jest.requireActual('../../services/stemService'),
  getStemModelState: jest.fn(),
  ensureStemModel: jest.fn(),
  separateStems: jest.fn(),
  cancelStemSeparation: jest.fn(),
}));
jest.mock('../../services/stemLanding', () => ({
  ...jest.requireActual('../../services/stemLanding'),
  landStems: jest.fn(),
  landVoice: jest.fn(),
  landSpeakers: jest.fn(),
}));
jest.mock('../../services/diarizeService', () => ({
  ...jest.requireActual('../../services/diarizeService'),
  getDiarizeModelState: jest.fn(),
  ensureDiarizeModels: jest.fn(),
  diarizeChannels: jest.fn(),
  cancelDiarization: jest.fn(),
}));
jest.mock('../../services/vocalChain', () => ({
  ...jest.requireActual('../../services/vocalChain'),
  runVocalChain: jest.fn(),
}));
jest.mock('../../services/podcastChain', () => ({
  ...jest.requireActual('../../services/podcastChain'),
  runPodcastChain: jest.fn(),
}));
jest.mock('../../services/coverJourney', () => ({
  ...jest.requireActual('../../services/coverJourney'),
  runCoverJourney: jest.fn(),
}));
jest.mock('../../services/coverPlacement', () => ({
  ...jest.requireActual('../../services/coverPlacement'),
  applyMeasuredOffset: jest.fn(),
}));
jest.mock('../../services/voiceService', () => ({
  ...jest.requireActual('../../services/voiceService'),
  getVoiceModelState: jest.fn(),
  ensureVoiceModels: jest.fn(),
  convertDocumentVoice: jest.fn(),
  createVoiceProfile: jest.fn(),
  deleteVoiceProfile: jest.fn(),
  cancelVoiceRun: jest.fn(),
  ensureVoiceProfilesLoaded: jest.fn(),
  getVoiceProfiles: jest.fn(),
  getVoiceProfilesLoadError: jest.fn(),
  useVoiceVersion: jest.fn(),
}));

import {
  getVoiceModelState,
  ensureVoiceProfilesLoaded,
  getVoiceProfiles,
  getVoiceProfilesLoadError,
  useVoiceVersion,
  VOICE_MODEL_BYTES,
  TONE_EMBEDDING_SIZE,
  type VoiceProfile,
} from '../../services/voiceService';

const mockGetTempo = getTempo as jest.MockedFunction<typeof getTempo>;
const mockRegridTempo = regridTempo as jest.MockedFunction<typeof regridTempo>;
const mockRunTempoAnalysis = runTempoAnalysis as jest.MockedFunction<typeof runTempoAnalysis>;
const mockRunRemixAnalysis = runRemixAnalysis as jest.MockedFunction<typeof runRemixAnalysis>;
const mockSetRemixAnalysis = setRemixAnalysis as jest.MockedFunction<typeof setRemixAnalysis>;
const mockApplyTempoChange = applyTempoChange as jest.MockedFunction<typeof applyTempoChange>;
const mockDetectRegionTempo = detectRegionTempo as jest.MockedFunction<typeof detectRegionTempo>;
const mockGetBeatGrid = getBeatGrid as jest.MockedFunction<typeof getBeatGrid>;
const mockApplyTimingAlignment = applyTimingAlignment as jest.MockedFunction<typeof applyTimingAlignment>;
const mockSuggestSyllableMarkers = suggestSyllableMarkers as jest.MockedFunction<typeof suggestSyllableMarkers>;
const mockCreateRemixDocument = createRemixDocument as jest.MockedFunction<typeof createRemixDocument>;
const mockPlanRemix = planRemix as jest.MockedFunction<typeof planRemix>;
const mockDeriveRemixFeatures = deriveRemixFeatures as jest.MockedFunction<typeof deriveRemixFeatures>;
const mockGetStemModelState = getStemModelState as jest.MockedFunction<typeof getStemModelState>;
const mockEnsureStemModel = ensureStemModel as jest.MockedFunction<typeof ensureStemModel>;
const mockSeparateStems = separateStems as jest.MockedFunction<typeof separateStems>;
const mockCancelStemSeparation = cancelStemSeparation as jest.MockedFunction<typeof cancelStemSeparation>;
const mockLandStems = landStems as jest.MockedFunction<typeof landStems>;
const mockLandVoice = landVoice as jest.MockedFunction<typeof landVoice>;
const mockLandSpeakers = landSpeakers as jest.MockedFunction<typeof landSpeakers>;
const mockGetDiarizeModelState = getDiarizeModelState as jest.MockedFunction<typeof getDiarizeModelState>;
const mockEnsureDiarizeModels = ensureDiarizeModels as jest.MockedFunction<typeof ensureDiarizeModels>;
const mockDiarizeChannels = diarizeChannels as jest.MockedFunction<typeof diarizeChannels>;
const mockCancelDiarization = cancelDiarization as jest.MockedFunction<typeof cancelDiarization>;
const mockRunVocalChain = runVocalChain as jest.MockedFunction<typeof runVocalChain>;
const mockRunPodcastChain = runPodcastChain as jest.MockedFunction<typeof runPodcastChain>;
const mockRunCoverJourney = runCoverJourney as jest.MockedFunction<typeof runCoverJourney>;
const mockApplyMeasuredOffset = applyMeasuredOffset as jest.MockedFunction<typeof applyMeasuredOffset>;
const mockGetVoiceModelState = getVoiceModelState as jest.MockedFunction<typeof getVoiceModelState>;
const mockEnsureVoiceProfilesLoaded = ensureVoiceProfilesLoaded as jest.MockedFunction<
  typeof ensureVoiceProfilesLoaded
>;
const mockGetVoiceProfiles = getVoiceProfiles as jest.MockedFunction<typeof getVoiceProfiles>;
const mockGetVoiceProfilesLoadError = getVoiceProfilesLoadError as jest.MockedFunction<
  typeof getVoiceProfilesLoadError
>;
const mockUseVoiceVersion = useVoiceVersion as jest.MockedFunction<typeof useVoiceVersion>;

registerAllEffects();

const SR = 48000;

function seedDoc(name = 'take.wav', samples = SR * 8): string {
  const doc = createDocument({ name, sampleRate: SR, channels: [new Float32Array(samples)] });
  useAppStore.getState().addDocument(doc);
  return doc.id;
}

function installBus(): void {
  registerDialogSetters({
    openExportDialog: () => {},
    openNewFileDialog: () => {},
    openEffectDialog: () => {},
    openConvertDialog: () => {},
    openRecordDialog: () => {},
    openTempoDialog: () => {},
    openRemixDialog: () => {},
    openSeparateDialog: () => {},
    openTranscribeDialog: () => {},
    openVoiceChangerDialog: () => {},
    openAlignTimingDialog: () => {},
    openVocalChainDialog: () => {},
    openCoverChainDialog: () => {},
    openPodcastChainDialog: () => {},
    openAlignLyricsDialog: () => {},
    focusRemixPanel: () => {},
    focusTranscriptPanel: () => {},
    focusSpatialPanel: () => {},
  });
}

/** Ported from `TempoDialog.test.tsx`'s `makeEntry`. */
function makeTempoEntry(overrides: Partial<TempoEntry> = {}): TempoEntry {
  return {
    bpm: 120,
    confidence: 0.8,
    beatSamples: Int32Array.from([1000, 23000, 45000]),
    salience: 1,
    peakRatio: 2,
    ibiCv: 0.05,
    truncated: false,
    analyzedEndSample: SR * 8,
    odf: new Float32Array(10),
    periodFrames: 40,
    decimationFactor: 4,
    bands: new Float32Array(0),
    numBands: 0,
    odfLow: new Float32Array(0),
    stale: false,
    ...overrides,
  } as TempoEntry;
}

/** Ported from `RemixDialog.test.tsx`'s `makeAnalysis`. */
function makeRemixAnalysis() {
  const BAR = 88200;
  const NUM_BARS = 8;
  return {
    bpm: 120,
    confidence: 0.8,
    beatSamples: Int32Array.from({ length: NUM_BARS * 4 + 1 }, (_, i) => i * (BAR / 4)),
    salience: 1,
    peakRatio: 2,
    ibiCv: 0.02,
    truncated: false,
    analyzedEndSample: NUM_BARS * BAR,
    odf: new Float32Array(64),
    periodFrames: 40,
    decimationFactor: 4,
    bands: new Float32Array(64 * 24),
    numBands: 24,
    odfLow: new Float32Array(64),
    chroma: new Float32Array(32 * 12),
    numChromaFrames: 32,
    chromaRate: 43,
    beatsPerBar: 4,
    downbeatPhase: 0,
    downbeatConfidence: 0.3,
    barBoundary: Int32Array.from({ length: NUM_BARS + 1 }, (_, i) => i * BAR),
    numBars: NUM_BARS,
    T: new Float32Array(0),
    C: new Float32Array(0),
    L: new Float32Array(0),
    R: new Float32Array(0),
    S: new Float32Array(0),
    cluster: Int32Array.from([0, 0, 1, 1, 1, 1, 1, 1, 0]),
    transitionSeen: new Set<string>(),
  };
}

/** Ported from `AlignTimingDialog.test.tsx`'s `makeGrid`. */
function makeBeatGrid(): BeatGrid {
  const BEATS = Int32Array.from({ length: 24 }, (_, i) => i * (SR / 2));
  return {
    beatSamples: BEATS,
    sampleRate: SR,
    beatsPerBar: null,
    downbeatPhase: null,
    barCount: 0,
    confidence: 0.8,
    stale: false,
    analyzedEndSample: BEATS[BEATS.length - 1],
    truncated: false,
    origin: 'own',
    originDocId: 'doc-1',
    originOpen: true,
  };
}

let transcribeBackend: ReturnType<typeof installTranscribeBackend> | null = null;
let alignLyricsBridge: Record<string, jest.Mock> | null = null;

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  jest.clearAllMocks();
  _resetPassLock();
  installBus();

  // TempoDialog / AlignTimingDialog / RemixDialog (shared tempoAnalysis mock)
  mockGetTempo.mockReturnValue(null);
  mockRegridTempo.mockResolvedValue(null);
  mockRunTempoAnalysis.mockResolvedValue(null);
  mockRunRemixAnalysis.mockResolvedValue(makeRemixAnalysis());
  mockSetRemixAnalysis.mockReturnValue(undefined as never);
  mockApplyTempoChange.mockResolvedValue({ ok: true } as never);
  mockDetectRegionTempo.mockReturnValue(null);

  // AlignTimingDialog
  mockGetBeatGrid.mockReturnValue(makeBeatGrid());
  mockApplyTimingAlignment.mockResolvedValue({ ok: true, markersMoved: 3 } as never);
  mockSuggestSyllableMarkers.mockReturnValue({ added: 12, truncated: false, analysedSeconds: 12 } as never);

  // RemixDialog
  mockCreateRemixDocument.mockResolvedValue({ ok: true, remixDocId: 'remix-1', plan: {} } as never);
  mockPlanRemix.mockImplementation(
    (_analysis, options): PlanRemixResult =>
      ({
        ok: true,
        segments: [{ start: 0, end: options.targetSample }],
        joins: [],
        outputSample: options.targetSample,
        targetSample: options.targetSample,
        totalCost: 1,
        minOutputSample: 2 * 88200,
        maxOutputSample: 24 * 88200,
        maxBarUse: 1,
        canReroll: true,
      }) as never
  );
  mockDeriveRemixFeatures.mockImplementation(() => makeRemixAnalysis() as never);

  // SeparateDialog
  mockGetStemModelState.mockResolvedValue({ downloaded: true, bytes: 1, expectedBytes: 1 } as never);
  mockEnsureStemModel.mockResolvedValue({ ok: true, path: 'C:/model.onnx' } as never);
  mockSeparateStems.mockResolvedValue({ ok: true, output: {} } as never);
  mockCancelStemSeparation.mockResolvedValue(true);
  mockLandStems.mockReturnValue({
    documentIds: [],
    trackIds: [],
    sessionName: '',
    monoRoutedAsDualMono: false,
    sourcePeak: 0,
    exactSumHolds: true,
    landingMode: 'replaced',
    landedStartSample: 0,
  } as never);
  mockLandVoice.mockReturnValue({} as never);
  mockLandSpeakers.mockReturnValue({} as never);
  mockGetDiarizeModelState.mockResolvedValue({ downloaded: true, bytes: 1, expectedBytes: 1 } as never);
  mockEnsureDiarizeModels.mockResolvedValue({ ok: true } as never);
  mockDiarizeChannels.mockResolvedValue({ ok: true } as never);
  mockCancelDiarization.mockResolvedValue(true);

  // VocalChainDialog / PodcastChainDialog / CoverChainDialog
  mockRunVocalChain.mockResolvedValue({} as never);
  mockRunPodcastChain.mockResolvedValue({} as never);
  mockRunCoverJourney.mockResolvedValue({} as never);
  mockApplyMeasuredOffset.mockReturnValue({
    applied: true,
    sessionRate: SR,
    takeStartSample: 0,
    instrumentalStartSample: 0,
    shiftedSamples: 0,
    fadeInSample: 1200,
    fadeOutSample: 1200,
    cursorSample: 0,
  } as never);

  // VoiceChangerDialog
  mockGetVoiceModelState.mockResolvedValue({
    downloaded: true,
    bytes: VOICE_MODEL_BYTES,
    expectedBytes: VOICE_MODEL_BYTES,
  });
  mockEnsureVoiceProfilesLoaded.mockResolvedValue(undefined);
  mockGetVoiceProfiles.mockReturnValue([
    {
      id: 'voice-1',
      name: 'Alice',
      embedding: new Float32Array(TONE_EMBEDDING_SIZE),
      createdAt: 1,
      sourceName: 'alice.wav',
    } as VoiceProfile,
  ]);
  mockGetVoiceProfilesLoadError.mockReturnValue(null);
  mockUseVoiceVersion.mockReturnValue(0);

  // TranscribeDialog — the real fake-IPC backend (F4b's own test convention),
  // defaults to models already downloaded.
  transcribeBackend = installTranscribeBackend();

  // AlignLyricsDialog — window.electronAPI bridge, defaults to model
  // downloaded (this dialog's own test-file convention).
  alignLyricsBridge = {
    alignModelState: jest.fn(async () => ({ downloaded: true, bytes: 1, expectedBytes: 1 })),
    alignEnsureModels: jest.fn(async () => ({ ok: true })),
    onAlignModelProgress: jest.fn(() => () => {}),
    alignRun: jest.fn(async () => ({ words: [], droppedWords: 0 })),
    alignCancel: jest.fn(async () => ({ cancelled: true })),
    onAlignProgress: jest.fn(() => () => {}),
    showMessageBox: jest.fn(async () => 0),
    showOpenDialog: jest.fn(async () => null),
    readFile: jest.fn(async () => new ArrayBuffer(0)),
  };
});

afterEach(() => {
  _resetPassLock();
});

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}

interface Case {
  name: string;
  /** Accessible name, when the button has one distinct enough to find by
   * role. `undefined` for dialogs whose primary button is better found by
   * its own testid (see `TESTID_BY_NAME`) — never both. */
  buttonName?: string | RegExp;
  render: () => Promise<void> | void;
}

const CASES: Case[] = [
  {
    name: 'EffectDialog',
    buttonName: 'Apply',
    render: () => {
      seedDoc();
      render_(<EffectDialog effectId="amplify" onClose={() => {}} />);
    },
  },
  {
    name: 'TempoDialog',
    buttonName: 'Apply',
    render: async () => {
      seedDoc();
      mockGetTempo.mockReturnValue(
        makeTempoEntry({ bpm: null, confidence: 0, beatSamples: Int32Array.from([]) })
      );
      render_(<TempoDialog onClose={() => {}} />);
      fireEvent.change(screen.getByTestId('tempo-target'), { target: { value: '110' } });
      fireEvent.change(screen.getByTestId('tempo-source'), { target: { value: '100' } });
    },
  },
  {
    name: 'AlignTimingDialog',
    buttonName: undefined, // looked up by testid — see TESTID_BY_NAME below
    render: async () => {
      const docId = seedDoc();
      useAppStore.getState().setMarkersForDoc(
        docId,
        Array.from({ length: 4 }, (_, i) => ({
          id: `m${i}`,
          name: `Syllable ${i + 1}`,
          positionSample: (i + 2) * (SR / 2) + 1500,
        }))
      );
      render_(<AlignTimingDialog onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('align-grid-confirmed'));
    },
  },
  {
    name: 'RemixDialog',
    buttonName: 'Create Remix',
    render: async () => {
      seedDoc();
      render_(<RemixDialog onClose={() => {}} />);
      await settle();
      fireEvent.click(screen.getByTestId('remix-tempo-confirmed'));
    },
  },
  {
    name: 'SeparateDialog',
    buttonName: 'Separate',
    render: async () => {
      seedDoc();
      render_(<SeparateDialog onClose={() => {}} />);
      await settle();
    },
  },
  {
    name: 'TranscribeDialog',
    buttonName: 'Transcribe',
    render: async () => {
      seedDoc();
      render_(<TranscribeDialog onClose={() => {}} />);
      await settle();
    },
  },
  {
    name: 'VoiceChangerDialog',
    buttonName: undefined, // looked up by testid — see TESTID_BY_NAME below
    render: async () => {
      seedDoc();
      render_(<VoiceChangerDialog onClose={() => {}} />);
      await settle();
      fireEvent.click(screen.getByTestId('voice-profile-voice-1'));
      fireEvent.click(screen.getByTestId('voice-consent'));
    },
  },
  {
    name: 'AlignLyricsDialog',
    buttonName: undefined, // looked up by testid — see TESTID_BY_NAME below
    render: async () => {
      seedDoc();
      (window as unknown as { electronAPI: unknown }).electronAPI = alignLyricsBridge;
      render_(<AlignLyricsDialog onClose={() => {}} />);
      await settle();
      fireEvent.change(screen.getByTestId('align-lyrics-text'), { target: { value: 'hello there friend' } });
      await settle();
    },
  },
  {
    name: 'VocalChainDialog',
    buttonName: undefined, // looked up by testid — see TESTID_BY_NAME below
    render: () => {
      seedDoc();
      render_(<VocalChainDialog onClose={() => {}} />);
    },
  },
  {
    name: 'PodcastChainDialog',
    buttonName: undefined, // looked up by testid — see TESTID_BY_NAME below
    render: () => {
      seedDoc();
      render_(<PodcastChainDialog onClose={() => {}} />);
    },
  },
  {
    name: 'CoverChainDialog',
    buttonName: undefined, // looked up by testid — see TESTID_BY_NAME below
    render: () => {
      const take = seedDoc('take.wav');
      seedDoc('song.wav');
      useAppStore.getState().setActiveDocument(take);
      render_(<CoverChainDialog onClose={() => {}} />);
      const song = useAppStore.getState().documents.find((d) => d.name === 'song.wav')!;
      fireEvent.change(screen.getByTestId('cover-journey-song'), { target: { value: song.id } });
    },
  },
];

// Dialogs whose primary button carries no accessible name distinct from a
// sibling (or is more reliably found by its own testid) are looked up that
// way instead of by role name.
const TESTID_BY_NAME: Record<string, string> = {
  AlignTimingDialog: 'align-apply',
  VoiceChangerDialog: 'voice-convert',
  AlignLyricsDialog: 'align-lyrics-run',
  VocalChainDialog: 'vocal-chain-apply',
  PodcastChainDialog: 'podcast-chain-apply',
  CoverChainDialog: 'cover-chain-apply',
};

// `render` is imported from RTL as `render`; the CASES table above also wants
// the name `render` for its own field, so the RTL import is aliased locally.
function render_(ui: Parameters<typeof render>[0]) {
  return render(ui);
}

function getStartControl(c: Case): HTMLElement {
  const testId = TESTID_BY_NAME[c.name];
  return testId ? screen.getByTestId(testId) : screen.getByRole('button', { name: c.buttonName });
}

describe.each(CASES)('$name — the start control respects the pass lock (fix round 3, item 2)', (c) => {
  it('is enabled once its own inputs are ready, then disables while a foreign pass holds the lock, then re-enables', async () => {
    await c.render();
    await settle();

    const control = getStartControl(c);
    expect(control).toBeEnabled();

    let release: (() => void) | null = null;
    act(() => {
      release = acquirePass({ id: 'file.save', label: 'Save Project', kind: 'save' });
    });

    expect(getStartControl(c)).toBeDisabled();

    act(() => {
      release!();
    });
    expect(getStartControl(c)).toBeEnabled();
  });
});
