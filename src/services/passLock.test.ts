import {
  PASS_REFUSED,
  _resetPassLock,
  acquirePass,
  blockedByPassReason,
  getPassVersion,
  getRunningPass,
  isPassRunning,
  passBusyReason,
  runExclusivePass,
  type PassDescriptor,
} from './passLock';

beforeEach(() => {
  _resetPassLock();
});

afterEach(() => {
  _resetPassLock();
});

describe('runExclusivePass', () => {
  // Acceptance 1 — a refusal is a refusal, not a queue.
  it('runs the function exactly once, and refuses a second pass while the first holds the lock', async () => {
    let calls = 0;
    const first = runExclusivePass(
      { id: 'edit.separateStems', label: 'Separate into Stems', kind: 'pipeline' },
      async () => {
        calls++;
        return 'ok';
      }
    );
    await first;
    expect(calls).toBe(1);

    const release = acquirePass({ id: 'effects.coverChain', label: 'Cover Chain', kind: 'pipeline' });
    expect(release).not.toBeNull();

    const refused = await runExclusivePass(
      { id: 'edit.transcribe', label: 'Transcribe', kind: 'host-job' },
      async () => {
        calls++;
        return 'never';
      }
    );

    expect(refused).toBe(PASS_REFUSED);
    expect(calls).toBe(1);
    release!();
  });

  // Acceptance 2a — M5, the throw/reject release path, including the shape a
  // crashed/killed utility process takes at this boundary (a rejected fn()).
  it('releases the lock when the pass throws, so a fresh pass can acquire it right after', async () => {
    const d: PassDescriptor = { id: 'voice.separate', label: 'Separate Voice', kind: 'host-job' };
    await expect(
      runExclusivePass(d, async () => {
        throw new Error('worker died');
      })
    ).rejects.toThrow('worker died');

    expect(isPassRunning()).toBe(false);
    expect(getRunningPass()).toBeNull();

    const release = acquirePass({ id: 'effects.podcastChain', label: 'Podcast Chain', kind: 'pipeline' });
    expect(release).not.toBeNull();
    expect(getRunningPass()?.label).toBe('Podcast Chain');
    release!();
  });

  // Acceptance 2b — a stale release cannot free a newer pass.
  it('makes a stale release closure a no-op once a newer pass holds the lock', () => {
    const releaseA = acquirePass({ id: 'effect.noise-reduction', label: 'Noise Reduction', kind: 'effect' });
    expect(releaseA).not.toBeNull();
    releaseA!();
    expect(isPassRunning()).toBe(false);

    const releaseB = acquirePass({ id: 'voice.separate', label: 'Separate Voice', kind: 'host-job' });
    expect(releaseB).not.toBeNull();

    // The STALE closure from A's already-released hold — calling it again must
    // not touch B's hold.
    releaseA!();

    expect(getRunningPass()?.label).toBe('Separate Voice');
    releaseB!();
  });
});

describe('blockedByPassReason and getPassVersion', () => {
  // Acceptance 3 — the reason string names the real running pass, and the
  // version counter bumps by exactly 2 per acquire+release.
  it('reports the real pass label in the reason, and bumps the version by 2 per acquire+release', () => {
    const before = getPassVersion();
    const release = acquirePass({ id: 'effects.vocalChain', label: 'Vocal Chain', kind: 'pipeline' });
    expect(release).not.toBeNull();

    expect(blockedByPassReason()).toBe(passBusyReason('Vocal Chain'));
    expect(blockedByPassReason()).toContain('Vocal Chain');
    // Not the empty string and not a generic fallback — a real pass name.
    expect(blockedByPassReason()).not.toBe('');
    expect(blockedByPassReason()).not.toContain('A pipeline pass');

    release!();
    expect(blockedByPassReason()).toBeNull();
    expect(getPassVersion()).toBe(before + 2);
  });

  it('reads null when nothing is running', () => {
    expect(isPassRunning()).toBe(false);
    expect(getRunningPass()).toBeNull();
    expect(blockedByPassReason()).toBeNull();
  });
});

describe('acquirePass', () => {
  it('refuses a second acquire while the first is held — X3: a non-identity label', () => {
    const release = acquirePass({ id: 'multitrack.mixdown', label: 'Mix Down', kind: 'mixdown' });
    expect(release).not.toBeNull();

    const second = acquirePass({ id: 'file.export', label: 'Export', kind: 'export' });
    expect(second).toBeNull();
    // Refusing a second acquire must not disturb the first.
    expect(getRunningPass()?.label).toBe('Mix Down');

    release!();
  });

  it('an idempotent release does not double-bump the version', () => {
    const release = acquirePass({ id: 'file.save', label: 'Save Project', kind: 'save' });
    const before = getPassVersion();
    release!();
    const afterFirst = getPassVersion();
    release!();
    release!();
    expect(getPassVersion()).toBe(afterFirst);
    expect(afterFirst).toBe(before + 1);
  });
});
