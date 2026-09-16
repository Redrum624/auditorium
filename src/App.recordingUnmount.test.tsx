import { render } from '@testing-library/react';
import App from './App';
import { makeInitialState, useAppStore } from './stores/appStore';
import { _resetPassLock } from './services/passLock';

/**
 * Fix round 3 (item 5) — `App.tsx`'s M5 unmount effect stops the multitrack
 * recorder on teardown, narrowed behind `multitrackRecorder.isRecording()`
 * rather than the broader `stopAll()` fix round 2 first reached for.
 * `stopAll()` also stops `playbackEngine`/`multitrackPlayer` unconditionally,
 * a side effect that would otherwise fire on EVERY App unmount — including
 * every React Testing Library teardown in this whole suite — with nothing
 * pinning it as deliberate. This file exists to be that pin, and to prove
 * the guard is real rather than decorative.
 *
 * `multitrackRecord.ts` is mocked wholesale (not the real `RecordingEngine`,
 * which needs a mic jsdom does not have) so `isRecording()`/`stop()` are
 * directly controllable spies; every other export passes through untouched.
 */
jest.mock('./multitrack/multitrackRecord', () => {
  const actual = jest.requireActual('./multitrack/multitrackRecord');
  return {
    ...actual,
    multitrackRecorder: {
      isRecording: jest.fn(() => false),
      start: jest.fn(async () => {}),
      stop: jest.fn(async () => {}),
      onChange: jest.fn(() => () => {}),
    },
  };
});

import { multitrackRecorder } from './multitrack/multitrackRecord';
const mockRecorder = multitrackRecorder as unknown as {
  isRecording: jest.Mock<boolean, []>;
  stop: jest.Mock<Promise<void>, []>;
};

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  _resetPassLock();
  mockRecorder.isRecording.mockReset().mockReturnValue(false);
  mockRecorder.stop.mockReset().mockResolvedValue(undefined);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    showMessageBox: jest.fn(async () => ({ response: 0 })),
    onWindowMaximized: () => () => {},
    onCloseRequested: () => () => {},
    respondCloseRequest: () => {},
  };
});

describe('App unmount — the recording-only guard (fix round 3, item 5)', () => {
  it('does not stop the recorder on unmount when nothing is recording', () => {
    const view = render(<App />);
    view.unmount();
    expect(mockRecorder.stop).not.toHaveBeenCalled();
  });

  it('stops the recorder on unmount when a take is recording', () => {
    mockRecorder.isRecording.mockReturnValue(true);
    const view = render(<App />);
    view.unmount();
    expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
  });
});
