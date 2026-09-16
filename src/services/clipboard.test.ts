import {
  clearClipboard,
  getClipboard,
  getClipboardKind,
  getClipClipboard,
  setClipboard,
  setClipClipboard,
  type ClipboardClips,
} from './clipboard';

// Lot L (L4a) — one clipboard, two mutually exclusive payload shapes. X3: the
// fixture below uses a non-identity sample rate (22_050, not the app's
// 44_100 default) and a non-zero `startOffsetSample` (24_000, not 0) so a
// defensive-copy assertion cannot pass by comparing zeros with zeros.
function clipsPayload(): ClipboardClips {
  return {
    sampleRate: 48_000,
    entries: [
      {
        documentId: 'doc-9',
        trackOffset: 1,
        startOffsetSample: 24_000,
        offsetSample: 5_000,
        lengthSample: 36_000,
        gainDb: 2,
      },
    ],
  };
}

beforeEach(() => {
  clearClipboard();
});

describe('clipboard — the two slots are mutually exclusive (L4a)', () => {
  it('setClipboard then setClipClipboard: the audio slot empties, the clip slot answers', () => {
    setClipboard({ channels: [Float32Array.of(0.25, -0.5)], sampleRate: 22_050 });
    expect(getClipboard()).not.toBeNull();

    setClipClipboard(clipsPayload());

    expect(getClipboard()).toBeNull();
    expect(getClipboardKind()).toBe('clips');
  });

  it('the reverse order: setClipClipboard then setClipboard empties the clip slot', () => {
    setClipClipboard(clipsPayload());
    expect(getClipClipboard()).not.toBeNull();

    setClipboard({ channels: [Float32Array.of(0.25, -0.5)], sampleRate: 22_050 });

    expect(getClipClipboard()).toBeNull();
    expect(getClipboardKind()).toBe('audio');
    expect(getClipboard()!.sampleRate).toBe(22_050);
  });
});

describe('setClipClipboard stores a defensive copy', () => {
  it('mutating the caller’s entry after the call leaves the stored one untouched', () => {
    const payload = clipsPayload();
    setClipClipboard(payload);

    payload.entries[0].startOffsetSample = 999_999;

    expect(getClipClipboard()!.entries[0].startOffsetSample).toBe(24_000);
  });
});

describe('clearClipboard empties whichever slot is live', () => {
  // Corrected (fix round 1, addendum item 5c): the two slots are mutually
  // exclusive by construction (L4a), so the two can never BOTH be populated
  // at once — `setClipClipboard` below has already nulled the audio slot
  // before `clearClipboard()` ever runs, so this test does NOT exercise
  // `clearClipboard`'s own `clipboard = null` line (it was already null).
  // The two tests below cover each slot's OWN clearing separately instead of
  // one test wrongly claiming to cover both at once.
  it('clears the CLIP slot when it is the one live', () => {
    setClipboard({ channels: [Float32Array.of(0.1)], sampleRate: 22_050 });
    setClipClipboard(clipsPayload());
    expect(getClipboardKind()).toBe('clips');

    clearClipboard();

    expect(getClipboard()).toBeNull();
    expect(getClipClipboard()).toBeNull();
    expect(getClipboardKind()).toBeNull();
  });

  it('clears the AUDIO slot when it is the one live', () => {
    setClipClipboard(clipsPayload());
    setClipboard({ channels: [Float32Array.of(0.1)], sampleRate: 22_050 });
    expect(getClipboardKind()).toBe('audio');

    clearClipboard();

    expect(getClipboard()).toBeNull();
    expect(getClipClipboard()).toBeNull();
    expect(getClipboardKind()).toBeNull();
  });
});
