import { act, fireEvent, render, screen, within } from '@testing-library/react';
import App from './App';
import DialogShell from './components/Dialogs/DialogShell';
import { TOOL_HOST_WIDTH } from './components/Dialogs/PipelineToolHost';
import { DEFAULT_PANEL, MODULE_COLUMN_WIDTH } from './components/Layout/ModuleStrip';
import { createDocument } from './audio/AudioDocument';
import { playbackEngine } from './audio/PlaybackEngine';
import { installTranscribeBackend, seedTranscript, voiceVector } from './__mocks__/transcribeBackend';
import { _resetTranscriptsForTest } from './services/transcribeService';
import { defaultParamsFor, getEffect, getVisibleEffects } from './effects/EffectRegistry';
import { hasOpenDialog } from './services/dialogBus';
import { runEffectOnSelection } from './services/effectRunner';
import { isCommandEnabled, runCommand } from './services/menuActions';
import { _resetPassLock, getRunningPass, isPassRunning } from './services/passLock';
import { getHistory } from './services/undoHistory';
import { makeInitialState, useAppStore } from './stores/appStore';

/**
 * Item 6 (2026-08-18) / M6 / N16 — an effect opens on one click as a card in
 * the module column, between the module strip and the module card, instead of
 * as a modal over the stage.
 *
 * The harness is `App.pipelineHost.test`'s: `TempoDialog` is stubbed so a
 * hosted PIPELINE pass can be started and finished from outside (its
 * `dismissable` is internal state no test may reach otherwise), rendering the
 * real `DialogShell` — the seam both hosts share. The effect runner is mocked
 * so Apply's promise is the test's to resolve: a lock that exists "during
 * Apply only" can only be observed with Apply held open.
 */
jest.mock('./components/Dialogs/TempoDialog', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const Shell = jest.requireActual<{ default: typeof DialogShell }>(
    './components/Dialogs/DialogShell'
  ).default;
  return {
    __esModule: true,
    default: function StubTempoDialog({ onClose }: { onClose: () => void }) {
      const [busy, setBusy] = React.useState(false);
      return React.createElement(Shell, {
        title: 'Match Tempo',
        dismissable: !busy,
        onClose,
        children: [
          React.createElement(
            'button',
            { key: 'toggle', type: 'button', onClick: () => setBusy((b) => !b) },
            busy ? 'finish pass' : 'start pass'
          ),
          // Fix round 1 — the real hand-off shape (see
          // `App.pipelineHost.test.tsx`'s identical stub): the pass ends and
          // the panel is asked for in the SAME synchronous block as `onClose`,
          // exactly what RemixDialog/TranscribeDialog do. Calling
          // `focusTranscriptPanel()` alone (the old version of this stub's
          // test) never exercised `onClose` — under lot C, `onClose` is the
          // ONLY thing that releases the tool's slot of the pass lock
          // (C-j), so a hand-off that skips it is not a real hand-off.
          React.createElement(
            'button',
            {
              key: 'handover',
              type: 'button',
              onClick: () => {
                setBusy(false);
                jest
                  .requireActual<typeof import('./services/dialogBus')>('./services/dialogBus')
                  .focusTranscriptPanel();
                onClose();
              },
            },
            'finish and hand over'
          ),
        ],
      });
    },
  };
});

jest.mock('./services/effectRunner', () => {
  const actual = jest.requireActual('./services/effectRunner');
  return { ...actual, runEffectOnSelection: jest.fn(async () => 'committed') };
});
const mockRun = runEffectOnSelection as jest.MockedFunction<typeof runEffectOnSelection>;
const realRun = jest.requireActual<typeof import('./services/effectRunner')>(
  './services/effectRunner'
).runEffectOnSelection;

interface MessageBoxOptions {
  type?: string;
  title?: string;
  message: string;
}
const showMessageBox = jest.fn(async (_opts: MessageBoxOptions) => ({ response: 0 }));

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  _resetPassLock();
  showMessageBox.mockClear();
  mockRun.mockReset();
  mockRun.mockImplementation(async () => 'committed');
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    showMessageBox,
    onWindowMaximized: () => () => {},
    onCloseRequested: () => () => {},
    respondCloseRequest: () => {},
  };
});

function addDoc() {
  const doc = createDocument({
    name: 'take.wav',
    sampleRate: 44100,
    channels: [new Float32Array(44100)],
  });
  act(() => {
    useAppStore.getState().addDocument(doc);
  });
  return doc;
}

function strip(): HTMLElement {
  return screen.getByTestId('sidebar-tabs');
}

function stripButton(label: string): HTMLButtonElement {
  return within(strip()).getByRole('button', { name: label }) as HTMLButtonElement;
}

async function openTool(id: string) {
  await act(async () => {
    await runCommand(id);
  });
}

function host(): HTMLElement {
  return screen.getByTestId('effect-host');
}

function inset(): string {
  return screen.getByTestId('editor-stage').style.getPropertyValue('--stage-inset-right');
}

function effectRowButton(index: number): HTMLButtonElement {
  return within(screen.getAllByTestId('effects-item')[index]).getByRole('button') as HTMLButtonElement;
}

describe('an effect opens in the module column, not over the stage', () => {
  it('opens in the column, not over the stage', async () => {
    addDoc();
    render(<App />);
    await openTool('effect.amplify');

    expect(host()).toHaveAttribute('data-effect-id', 'amplify');
    expect(screen.queryByTestId('dialog-overlay')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(host()).getByTestId('hosted-tool')).toHaveAttribute(
      'aria-label',
      getEffect('amplify')!.name
    );
    expect(within(host()).getByTestId('effect-dialog')).toBeInTheDocument();
    // Idle, the card suspends nothing: Space, Ctrl+Z and the arrows stay live.
    expect(hasOpenDialog()).toBe(false);
    expect(isPassRunning()).toBe(false);
  });

  it('sits between the strip and the module card, and forces Effects (M6/N16)', async () => {
    addDoc();
    render(<App />);
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', DEFAULT_PANEL);

    await openTool('effect.amplify');

    const panel = screen.getByTestId('sidebar-panel');
    expect(panel).toHaveAttribute('data-active-tab', 'effects');
    expect(screen.getByTestId('effects-list')).toBeInTheDocument();
    // Inside the column, ABOVE the module card: same parent, earlier sibling.
    expect(host().parentElement).toBe(panel.parentElement);
    expect(host().compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // …and below the strip. The strip is an absolutely positioned pill that
    // mounts AFTER the column in DOM order, so the vertical order is read off
    // the two anchors rather than the document order: the column (which holds
    // the host) starts below the strip's top.
    const column = host().parentElement as HTMLElement;
    expect(parseInt(column.style.top, 10)).toBeGreaterThan(parseInt(strip().style.top, 10));
    const tempo = screen.queryByTestId('tempo-card');
    if (tempo) expect(host().parentElement).toBe(tempo.parentElement);
  });

  it('W1 and the stage inset: the strip, the card and the module card share one width', async () => {
    addDoc();
    render(<App />);
    expect(strip().style.width).toBe(`${MODULE_COLUMN_WIDTH}px`);

    await openTool('effect.amplify');
    expect(strip().style.width).toBe(`${MODULE_COLUMN_WIDTH}px`);
    expect(host().style.width).toBe(`${MODULE_COLUMN_WIDTH}px`);
    expect(host().style.marginLeft).toBe('');
    // The module card declares no width of its own — the column's 348 is its.
    expect(screen.getByTestId('sidebar-panel').style.width).toBe('');
    // 14 + 348 + 14: the same clearance a module card asks for.
    expect(inset()).toBe('376px');

    // M6's new switch case: the module card closes, the effect card stays, and
    // the stage keeps its clearance for the card still in the column.
    fireEvent.click(screen.getByTestId('sidebar-panel-close'));
    expect(screen.queryByTestId('sidebar-panel')).toBeNull();
    expect(host()).toBeInTheDocument();
    expect(inset()).toBe('376px');

    fireEvent.click(within(host()).getByTestId('hosted-tool-close'));
    expect(screen.queryByTestId('effect-host')).toBeNull();
    expect(inset()).toBe('14px');
    expect(strip().style.width).toBe(`${MODULE_COLUMN_WIDTH}px`);
  });

  // C1 (lot C, item 3, 2026-09-15) OVERTURNS the ruling this test pinned
  // before lot C — "Open question 1's default": the effect card stayed
  // VISIBLE over every module. The user's own ruling ("it should go back with
  // the effect ... in the state you left it") means leaving the module
  // BACKGROUNDS the card instead — hidden, not destroyed, per C2 — and
  // returning to Effects foregrounds the SAME instance again. Only `openTool`,
  // ✕ / Cancel / Apply and the orphan rule still UNMOUNT it.
  it('backgrounds on a strip click and foregrounds again on return (C1)', async () => {
    addDoc();
    render(<App />);
    await openTool('effect.amplify');
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'effects');
    expect(host()).not.toHaveAttribute('data-backgrounded');
    expect(host()).not.toHaveAttribute('hidden');

    fireEvent.click(stripButton('Files'));
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'files');
    // Still mounted — C2: state is preserved by keeping the host mounted and
    // hidden, never by unmounting it.
    const backgroundedHost = host();
    expect(backgroundedHost).toHaveAttribute('data-effect-id', 'amplify');
    expect(backgroundedHost).toHaveAttribute('data-backgrounded', 'true');
    expect(backgroundedHost).toHaveAttribute('hidden');
    expect(backgroundedHost.style.display).toBe('none');

    fireEvent.click(stripButton('Effects'));
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'effects');
    // The SAME DOM node returns foregrounded — nothing was ever unmounted.
    expect(host()).toBe(backgroundedHost);
    expect(host()).not.toHaveAttribute('data-backgrounded');
    expect(host()).not.toHaveAttribute('hidden');
  });
});

/**
 * C1/C2, end to end through App: a parameter edit is local `useState` inside
 * `EffectDialog` — nothing here lifts it into a store (C2 forbids it) — so
 * the only proof that it survives a background/foreground round trip is that
 * the SAME mounted instance carries it across. X3: `-7.5`, off every
 * identity (not `0`, not the param's own default).
 */
describe('a parameter edit survives backgrounding (C1/C2)', () => {
  function gainInput(): HTMLInputElement {
    const el = document.getElementById('effect-param-gainDb');
    if (!(el instanceof HTMLInputElement)) throw new Error('no gain input');
    return el;
  }

  it('a typed value is still there after leaving and returning to Effects', async () => {
    addDoc();
    render(<App />);
    await openTool('effect.amplify');
    fireEvent.change(gainInput(), { target: { value: '-7.5' } });
    expect(gainInput().value).toBe('-7.5');

    fireEvent.click(stripButton('Markers'));
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'markers');
    expect(host()).toHaveAttribute('data-backgrounded', 'true');

    fireEvent.click(stripButton('Effects'));
    expect(host()).not.toHaveAttribute('data-backgrounded');
    expect(gainInput().value).toBe('-7.5');
  });
});

/**
 * C4, the idle case: a badge on the strip button for a module whose host is
 * retained-but-backgrounded. `running` reads lot M's `usePassLock()` — proven
 * here by its absence: idle, nothing holds the lock, so the badge must read
 * `running=false` off the SAME source `getRunningPass()` reports, not a
 * parallel flag that could disagree with it.
 */
describe('the strip badge reads the lock, not a parallel flag (C4)', () => {
  it('shows an idle badge naming the backgrounded effect, and none on the foregrounded module', async () => {
    addDoc();
    render(<App />);
    await openTool('effect.amplify');
    expect(screen.queryByTestId('module-badge-effects')).toBeNull();

    fireEvent.click(stripButton('Markers'));

    expect(isPassRunning()).toBe(false);
    const badge = screen.getByTestId('module-badge-effects');
    expect(badge).toHaveAttribute('data-running', 'false');
    expect(stripButton('Effects').title).toContain(getEffect('amplify')!.name);
    expect(screen.queryByTestId('module-badge-markers')).toBeNull();
  });
});

describe('every door reaches the same card', () => {
  it('the Effects card’s effect row, one click', async () => {
    addDoc();
    render(<App />);
    fireEvent.click(stripButton('Effects'));
    const first = getVisibleEffects()[0];
    await act(async () => {
      fireEvent.click(effectRowButton(0));
    });
    expect(host()).toHaveAttribute('data-effect-id', first.id);
  });

  it('a second row swaps the card — one effect at a time', async () => {
    addDoc();
    render(<App />);
    fireEvent.click(stripButton('Effects'));
    const [first, second] = getVisibleEffects();
    await act(async () => {
      fireEvent.click(effectRowButton(0));
    });
    expect(host()).toHaveAttribute('data-effect-id', first.id);

    await act(async () => {
      fireEvent.click(effectRowButton(1));
    });
    expect(screen.getAllByTestId('effect-host')).toHaveLength(1);
    expect(host()).toHaveAttribute('data-effect-id', second.id);
  });

  // The menu's door is `runCommand(id)` — the same call MenuBar makes.
  it('the Effects menu’s command', async () => {
    addDoc();
    render(<App />);
    await openTool('effect.reverb');
    expect(host()).toHaveAttribute('data-effect-id', 'reverb');
  });
});

describe('close paths', () => {
  it('the header ✕ unmounts the card and leaves the Effects module card in place', async () => {
    addDoc();
    render(<App />);
    await openTool('effect.amplify');

    fireEvent.click(within(host()).getByTestId('hosted-tool-close'));
    expect(screen.queryByTestId('effect-host')).toBeNull();
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'effects');
  });

  it('the body’s Cancel unmounts the card and leaves the Effects module card in place', async () => {
    addDoc();
    render(<App />);
    await openTool('effect.amplify');

    fireEvent.click(within(host()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('effect-host')).toBeNull();
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'effects');
  });

  it('Apply runs the effect, then unmounts the card with nothing left locked', async () => {
    addDoc();
    render(<App />);
    await openTool('effect.amplify');

    await act(async () => {
      fireEvent.click(within(host()).getByRole('button', { name: 'Apply' }));
    });
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockRun.mock.calls[0][0]).toBe('amplify');
    expect(screen.queryByTestId('effect-host')).toBeNull();
    expect(hasOpenDialog()).toBe(false);
    expect(isPassRunning()).toBe(false);
  });
});

describe('interplay with the pipeline tools', () => {
  // Fix round 1 (C5) — OVERTURNS this test's old premise, pinned as "the 640
  // host and the 348 card never coexist": C5 is explicit that at most ONE
  // effect card AND ONE hosted tool are retained AT THE SAME TIME — two
  // independent slots, not one shared slot — so opening an effect while an
  // idle tool is retained no longer destroys the tool. The invariant the old
  // test name protected — the VISIBLE surfaces never coexist, so the strip is
  // always exactly one width — is still real and still checked here: it is
  // now structural (`columnHost` is a single value), not "only one thing is
  // ever mounted".
  it('an effect foregrounds over an idle retained tool — both retained, only the VISIBLE surfaces never coexist (C5)', async () => {
    addDoc();
    render(<App />);
    await openTool('tempo.match');
    const toolNode = screen.getByTestId('tool-host');
    expect(toolNode).not.toHaveAttribute('data-backgrounded');

    await openTool('effect.amplify');
    // Still retained — mounted, hidden, not destroyed.
    expect(screen.getByTestId('tool-host')).toBe(toolNode);
    expect(screen.getByTestId('tool-host')).toHaveAttribute('data-backgrounded', 'true');
    expect(host()).toHaveAttribute('data-effect-id', 'amplify');
    expect(host()).not.toHaveAttribute('data-backgrounded');
    // Only ONE visible surface at a time: 348 (the effect card / module
    // card), never 640 (the tool) while the effect is foregrounded.
    expect(strip().style.width).toBe(`${MODULE_COLUMN_WIDTH}px`);
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'effects');

    // And returning to Pipeline foregrounds the SAME retained tool again.
    fireEvent.click(stripButton('Pipeline'));
    expect(screen.getByTestId('tool-host')).toBe(toolNode);
    expect(screen.getByTestId('tool-host')).not.toHaveAttribute('data-backgrounded');
    expect(strip().style.width).toBe(`${TOOL_HOST_WIDTH}px`);
  });

  // Fix round 1 (C5) — the symmetric case (X2), same overturned premise.
  it('a pipeline tool foregrounds over an open effect card — both retained (C5)', async () => {
    addDoc();
    render(<App />);
    await openTool('effect.amplify');
    const effectNode = host();

    await openTool('lyrics.align');
    // Still retained — mounted, hidden, not destroyed.
    expect(host()).toBe(effectNode);
    expect(host()).toHaveAttribute('data-backgrounded', 'true');
    expect(screen.getByTestId('tool-host')).toHaveAttribute('data-tool-id', 'lyrics.align');
    expect(screen.getByTestId('tool-host')).not.toHaveAttribute('data-backgrounded');
    expect(strip().style.width).toBe(`${TOOL_HOST_WIDTH}px`);

    fireEvent.click(stripButton('Effects'));
    expect(host()).toBe(effectNode);
    expect(host()).not.toHaveAttribute('data-backgrounded');
    expect(strip().style.width).toBe(`${MODULE_COLUMN_WIDTH}px`);
  });

  // Lot M: `effect.<id>`'s own `enabled` now ANDs in `passFree()`
  // (menuActions.ts), so `runCommand('effect.amplify')` bails before it ever
  // calls `openEffectDialog` — the App-level message box this test used to
  // assert is unreachable through the registry now (M3: the refusal is a
  // disabled command with a reason, not a dialog). `showMessageBox` stays as
  // defence in depth for `TranscriptPanel.tsx`'s bypass, tested separately.
  it('refuses to open an effect while a pipeline pass runs — the registry gate, no message box', async () => {
    addDoc();
    render(<App />);
    await openTool('tempo.match');
    fireEvent.click(screen.getByRole('button', { name: 'start pass' }));

    // Fix round 1 (MED) — restores the coverage the old
    // `showMessageBox.mock.calls[0][0].message).toContain('Match Tempo')`
    // assertion carried: `describeHostedPass()`'s label for a hosted TOOL.
    expect(getRunningPass()?.label).toBe('Match Tempo');
    expect(isCommandEnabled('effect.amplify')).toBe(false);
    await openTool('effect.amplify');

    expect(showMessageBox).not.toHaveBeenCalled();
    expect(screen.getByTestId('tool-host')).toHaveAttribute('data-tool-id', 'tempo.match');
    expect(screen.queryByTestId('effect-host')).toBeNull();
  });
});

describe('the module lock, during Apply only (N16)', () => {
  it('locks the ✕ and Cancel while Apply runs (never the strip, C3), and refuses another effect', async () => {
    addDoc();
    render(<App />);
    await openTool('effect.amplify');
    // Idle: nothing is held.
    expect(hasOpenDialog()).toBe(false);
    expect(isPassRunning()).toBe(false);
    for (const button of within(strip()).getAllByRole('button')) expect(button).not.toBeDisabled();

    let finish!: (v: 'committed') => void;
    mockRun.mockReturnValueOnce(new Promise<'committed'>((resolve) => (finish = resolve)));
    await act(async () => {
      fireEvent.click(within(host()).getByRole('button', { name: 'Apply' }));
    });

    // M6: the modal stack stays empty — a hosted card never joins it, running
    // or idle. `isPassRunning()` is the question that answers "is a pass
    // running now".
    expect(hasOpenDialog()).toBe(false);
    expect(isPassRunning()).toBe(true);
    // Fix round 1 (MED) — restores the coverage the old
    // `showMessageBox.mock.calls[0][0].message).toContain(getEffect('amplify')!.name)`
    // assertion carried: `describeHostedPass()`'s label for a hosted EFFECT —
    // the real registry name, never the `'A pipeline pass'` fallback.
    expect(getRunningPass()?.label).toBe(getEffect('amplify')!.name);
    // Fix round 1 (C3) — OVERTURNS this test's old premise: the strip used to
    // disable every button while Apply ran, because leaving would have
    // discarded the pass. M2 removes that: switching module now backgrounds
    // the running Apply instead of blocking the switch, and the pass keeps
    // running (`getRunningPass()` above still names it). The invariant this
    // test protects — Apply's OWN controls (the ✕, Cancel) still refuse to
    // DISCARD a running pass — is unaffected and still checked right below;
    // only the strip's behaviour changed.
    for (const button of within(strip()).getAllByRole('button')) {
      expect(button).not.toBeDisabled();
    }
    fireEvent.click(stripButton('Markers'));
    expect(host()).toHaveAttribute('data-backgrounded', 'true');
    expect(isPassRunning()).toBe(true);
    fireEvent.click(stripButton('Effects'));
    expect(host()).not.toHaveAttribute('data-backgrounded');

    expect(within(host()).getByTestId('hosted-tool-close')).toBeDisabled();
    expect(within(host()).getByRole('button', { name: 'Cancel' })).toBeDisabled();

    // Lot M: `effect.reverb`'s own `enabled` ANDs in `passFree()`, so this is
    // refused at the registry — no message box, the row was already
    // disabled — exactly like the sibling test above.
    expect(isCommandEnabled('effect.reverb')).toBe(false);
    await openTool('effect.reverb');
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(host()).toHaveAttribute('data-effect-id', 'amplify');

    await act(async () => {
      finish('committed');
    });
    expect(screen.queryByTestId('effect-host')).toBeNull();
    expect(hasOpenDialog()).toBe(false);
    expect(isPassRunning()).toBe(false);
    for (const button of within(strip()).getAllByRole('button')) expect(button).not.toBeDisabled();
  });
});

describe('the orphan rule (N16)', () => {
  it('closes the card when the last document closes', async () => {
    const doc = addDoc();
    render(<App />);
    await openTool('effect.amplify');
    expect(host()).toBeInTheDocument();

    act(() => {
      useAppStore.getState().closeDocument(doc.id);
    });
    expect(screen.queryByTestId('effect-host')).toBeNull();
  });
});

/**
 * Fix round 2, finding 4 — Acceptance 10 (C-i, C5): the orphan rule now has
 * TWO slots to drop, and this is the first test that ever retains both at
 * once and then orphans them together.
 */
describe('the orphan rule drops BOTH retained slots at once (C-i, Acceptance 10)', () => {
  it('closes the retained tool and the retained effect, and clears both badges, when the last document closes', async () => {
    const doc = addDoc();
    render(<App />);
    await openTool('effect.amplify');
    await openTool('lyrics.align');
    // C5: both retained — the tool foregrounded, the effect backgrounded.
    expect(screen.getByTestId('tool-host')).not.toHaveAttribute('data-backgrounded');
    expect(host()).toHaveAttribute('data-backgrounded', 'true');
    expect(screen.getByTestId('module-badge-effects')).toBeInTheDocument();

    act(() => {
      useAppStore.getState().closeDocument(doc.id);
    });

    expect(screen.queryByTestId('tool-host')).toBeNull();
    expect(screen.queryByTestId('effect-host')).toBeNull();
    expect(screen.queryByTestId('module-badge-pipeline')).toBeNull();
    expect(screen.queryByTestId('module-badge-effects')).toBeNull();
  });
});

/**
 * Fix round 2, finding 4 — C-h, previously untested: "no auto-foreground, no
 * new toast. The card closes itself ... the badge disappears and the result
 * is where it always goes." Apply's own `onClose()` on a committed run
 * (`EffectDialog.tsx`) is the concrete mechanism decisions.md cites; this
 * drives that mechanism for real, with the card BACKGROUNDED at the moment
 * it fires.
 */
describe('a pass that finishes while backgrounded lands silently (C-h)', () => {
  it('no auto-foreground: the module card underneath stays put, and the badge goes with the card', async () => {
    addDoc();
    render(<App />);
    await openTool('effect.amplify');

    let finish!: (v: 'committed') => void;
    mockRun.mockReturnValueOnce(new Promise<'committed'>((resolve) => (finish = resolve)));
    await act(async () => {
      fireEvent.click(within(host()).getByRole('button', { name: 'Apply' }));
    });
    expect(isPassRunning()).toBe(true);

    fireEvent.click(stripButton('Markers'));
    expect(host()).toHaveAttribute('data-backgrounded', 'true');
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'markers');
    const badge = screen.getByTestId('module-badge-effects');
    expect(badge).toHaveAttribute('data-running', 'true');

    await act(async () => {
      finish('committed');
    });

    // No auto-foreground — still on Markers, untouched.
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'markers');
    // The card closed itself (Apply's own onClose on a committed run) and the
    // badge went with it — silently, no message box, no toast.
    expect(screen.queryByTestId('effect-host')).toBeNull();
    expect(screen.queryByTestId('module-badge-effects')).toBeNull();
    expect(isPassRunning()).toBe(false);
    expect(showMessageBox).not.toHaveBeenCalled();
  });
});

/**
 * Fix round 2, findings 5 and 6, combined — investigated and merged on the
 * coordinator's own steer (finding 6): there is no UI door that changes the
 * active document without leaving the Effects module (`FilesPanel.tsx` is
 * the only `setActiveDocument` caller in any component, and `openEffect`
 * always forces `sidebarTab: 'effects'`, so showing Files necessarily
 * backgrounds the effect first). The one real, MOUSE-DRIVEN action left that
 * "takes a preview away" is the strip click itself — and it exercises C-f
 * (the backgrounding release), not the old document-moved effect. This one
 * test now pins BOTH: (5) nothing at App level proved backgrounding stops
 * the shared engine — deleting `backgrounded={columnHost !== 'effect'}` from
 * `App.tsx` passed every other App-level test while leaving an invisible
 * sound source still playing; and (6) the mouse-driven half of "a preview
 * the app takes away leaves no stale Stop Preview" — re-pinned end to end
 * through a real strip click, foregrounding again, and a fresh Preview press
 * that starts a NEW preview rather than stopping playback the user did not
 * start.
 */
describe('a preview the mouse takes away by backgrounding leaves no stale button (C-f, findings 5/6)', () => {
  it('a real strip click stops a running Preview and hands the engine back; the button never lies when the card returns', async () => {
    const doc = addDoc();
    render(<App />);
    await openTool('effect.amplify');
    const stop = jest.spyOn(playbackEngine, 'stop');
    const load = jest.spyOn(playbackEngine, 'load');
    try {
      fireEvent.click(within(host()).getByRole('button', { name: 'Preview' }));
      expect(within(host()).getByRole('button', { name: 'Stop Preview' })).toBeInTheDocument();
      stop.mockClear();
      load.mockClear();

      // Mouse-driven: a real click on the Files strip button (not a direct
      // store call) backgrounds the effect — and per C-f, releases the
      // preview the instant it does.
      fireEvent.click(stripButton('Files'));

      expect(host()).toHaveAttribute('data-backgrounded', 'true');
      expect(stop).toHaveBeenCalled();
      expect(load).toHaveBeenCalledWith(expect.objectContaining({ id: doc.id }));
      expect(playbackEngine.loadedDocumentId).toBe(doc.id);

      // Foreground it again: the button must not still claim a preview is
      // running (the exact stale-button hazard the old Files-panel test
      // pinned), and pressing it starts a FRESH preview — never a stop of
      // playback the user just started on the document they moved to.
      fireEvent.click(stripButton('Effects'));
      expect(host()).not.toHaveAttribute('data-backgrounded');
      expect(within(host()).getByRole('button', { name: 'Preview' })).toBeInTheDocument();
      expect(within(host()).queryByRole('button', { name: 'Stop Preview' })).toBeNull();

      load.mockClear();
      fireEvent.click(within(host()).getByRole('button', { name: 'Preview' }));
      expect(within(host()).getByRole('button', { name: 'Stop Preview' })).toBeInTheDocument();
      expect(load).toHaveBeenCalledTimes(1);
      // The throwaway preview document, not the take — a fresh preview, not
      // a resumed stale one.
      expect(load.mock.calls[0][0].id).not.toBe(doc.id);
    } finally {
      stop.mockRestore();
      load.mockRestore();
    }
  });
});

/**
 * Fix round 1 (finding 1): the user's scenario — edit Amplify's gain, then
 * click Reverb in the Effects card beneath. The card that now names Reverb
 * must show Reverb's own defaults and Apply must send exactly those, never
 * the `{ gainDb: 7 }` the previous card held (which would have run Reverb on
 * fallbacks the user never saw). The row swap at 'a second row swaps the
 * card' above only pins `data-effect-id`; this pins the state behind it.
 */
describe('swapping the hosted effect starts the new one from its own defaults', () => {
  function paramInput(id: string): HTMLInputElement {
    const el = document.getElementById(`effect-param-${id}`);
    if (!(el instanceof HTMLInputElement)) throw new Error(`no parameter input for ${id}`);
    return el;
  }

  it('Reverb, opened over an edited Amplify card, shows and applies its own defaults', async () => {
    addDoc();
    render(<App />);
    await openTool('effect.amplify');
    fireEvent.change(paramInput('gainDb'), { target: { value: '7' } });
    expect(paramInput('gainDb').value).toBe('7');

    const reverb = getEffect('reverb')!;
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId('effects-list')).getByRole('button', { name: reverb.name })
      );
    });
    expect(screen.getAllByTestId('effect-host')).toHaveLength(1);
    expect(host()).toHaveAttribute('data-effect-id', 'reverb');
    expect(document.getElementById('effect-param-gainDb')).toBeNull();
    for (const p of reverb.params) {
      if (p.type === 'boolean') expect(paramInput(p.id).checked).toBe(Boolean(p.default));
      else expect(paramInput(p.id).value).toBe(String(p.default));
    }

    await act(async () => {
      fireEvent.click(within(host()).getByRole('button', { name: 'Apply' }));
    });
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockRun.mock.calls[0][0]).toBe('reverb');
    expect(mockRun.mock.calls[0][1]).toEqual(defaultParamsFor('reverb'));
  });
});

/**
 * Fix round 2 (round-1 finding 2): the lock during Apply holds the strip, the
 * ✕, Cancel and the global keys — never the mouse ("Mouse interaction is
 * never suspended"). The modal's backdrop used to make every click below
 * impossible; as a card, the edit pill, the Files panel and the File menu
 * stay live while the worker runs, and the runner commits its result to the
 * region it resolved BEFORE the worker started. The dialog now hands the
 * runner `shouldCancel` (T6-3's seam, asked once between the audio arriving
 * and `applyEdit`): a document that moved — edited, swapped, closed — is
 * never written, the card stays and says so.
 *
 * These run the REAL runner over the synchronous worker mock, which answers
 * behind one microtask: Apply, then the mouse door, then the flush — the
 * exact window the hazard lands in.
 */
describe('the mouse stays live during Apply: a document that moved is never written (fix round 2)', () => {
  const STALE_HINT =
    'The document changed while the effect was running, so nothing was applied. Apply again to run it on the document as it is now.';

  function docById(id: string) {
    return useAppStore.getState().documents.find((d) => d.id === id) ?? null;
  }

  /** A document File > Close can close without a Save prompt (clean, on disk). */
  function addSavedDoc(name: string) {
    const doc = createDocument({
      name,
      sampleRate: 44100,
      channels: [new Float32Array(44100)],
      filePath: `C:/takes/${name}`,
      neverSaved: false,
    });
    act(() => {
      useAppStore.getState().addDocument(doc);
    });
    return doc;
  }

  /** Selects the first half of the active document and clicks Apply on the
   * open Amplify card with the real runner: the worker is now pending behind
   * a microtask and the lock is up. */
  function applyOnFirstHalf() {
    act(() => {
      useAppStore.getState().setSelection({ start: 0, end: 22050 });
    });
    mockRun.mockImplementation(realRun);
    fireEvent.click(within(host()).getByRole('button', { name: 'Apply' }));
    // M6: the modal stack stays empty; the pass lock is what is up.
    expect(hasOpenDialog()).toBe(false);
    expect(isPassRunning()).toBe(true);
  }

  /** Lets the worker answer and the runner settle. */
  function flush() {
    return act(async () => {});
  }

  it('a Delete on the edit pill zero-fills the document; the returning worker writes nothing over it', async () => {
    const doc = addDoc();
    render(<App />);
    await openTool('effect.amplify');
    applyOnFirstHalf();

    // The lock holds the strip, not the pill: this is the door.
    const del = within(screen.getByTestId('edit-pill')).getByRole('button', { name: 'Delete' });
    expect(del).toBeEnabled();
    fireEvent.click(del);
    // Since lot C, Delete keeps the length (the span is zero-filled, N6): the
    // document's `channels` identity still changes, which is the signal the
    // Apply-time guard keys on — the length no longer does.
    const edited = docById(doc.id)!.channels;
    expect(edited[0]).toHaveLength(44100);
    expect(Array.from(edited[0].subarray(0, 22050)).every((v) => v === 0)).toBe(true);
    expect(getHistory(doc.id).done).toEqual(['Delete']);

    await flush();
    // Identity, not equality: a commit allocates fresh arrays.
    expect(docById(doc.id)!.channels).toBe(edited);
    expect(getHistory(doc.id).done).toEqual(['Delete']);
    expect(host()).toHaveAttribute('data-effect-id', 'amplify');
    expect(within(host()).getByTestId('effect-stale-hint')).toHaveTextContent(STALE_HINT);
    expect(hasOpenDialog()).toBe(false);
    expect(isPassRunning()).toBe(false);
    for (const button of within(strip()).getAllByRole('button')) expect(button).not.toBeDisabled();
    expect(showMessageBox).not.toHaveBeenCalled();
  });

  // Fix round 1 (C1/C-e) — OVERTURNS this test's old ordering: it used to
  // background the effect card BEFORE starting Apply (clicking Files while
  // idle), then reach `within(host())` for the Apply button — which worked
  // only because, before lot C, backgrounding did not really exist: the card
  // stayed fully visible and interactive over every module (the exact bug
  // C1 fixes). Now that C-e makes a backgrounded card genuinely
  // non-interactive (`hidden` + `display:none`, correctly excluded from the
  // accessibility tree `getByRole` queries), clicking its Apply button while
  // backgrounded is not something a real user could do either. Apply now
  // starts FIRST, foregrounded; the switch to Files happens AFTER, backgrounding
  // the RUNNING effect — C3/M2 explicitly allow that, and the pass keeps
  // running behind it. The invariant this test protects — the mouse stays
  // live during Apply, and a document swap under a running Apply never
  // corrupts either document — is unchanged and still proven below.
  it('a row click in the Files panel switches documents while Apply keeps running backgrounded; the effect lands in neither and the caret stays put', async () => {
    const a = addSavedDoc('take.wav');
    const b = addSavedDoc('other.wav');
    act(() => {
      useAppStore.getState().setActiveDocument(a.id);
    });
    render(<App />);
    await openTool('effect.amplify');
    applyOnFirstHalf();
    // The strip is free even mid-pass (C3/M2); the Files panel is now the
    // module card beneath the BACKGROUNDED, still-running effect.
    fireEvent.click(stripButton('Files'));
    expect(host()).toHaveAttribute('data-backgrounded', 'true');
    expect(isPassRunning()).toBe(true);
    const aChannels = docById(a.id)!.channels;
    const bChannels = docById(b.id)!.channels;

    fireEvent.click(within(screen.getByTestId('files-list')).getByText('other.wav').closest('button')!);
    expect(useAppStore.getState().activeDocumentId).toBe(b.id);

    await flush();
    expect(docById(a.id)!.channels).toBe(aChannels);
    expect(docById(b.id)!.channels).toBe(bChannels);
    expect(getHistory(a.id).done).toEqual([]);
    expect(getHistory(b.id).done).toEqual([]);
    // `applyEdit` writes the selection and the cursor GLOBALLY: a commit here
    // would have put [0, 22050] back on the document the user moved on to.
    expect(useAppStore.getState().selection).toBeNull();
    expect(host()).toBeInTheDocument();
    expect(within(host()).getByTestId('effect-stale-hint')).toHaveTextContent(STALE_HINT);
    expect(hasOpenDialog()).toBe(false);
    expect(isPassRunning()).toBe(false);
    expect(showMessageBox).not.toHaveBeenCalled();
  });

  // Lot M / M-c: `file.close` is gated on `closeFree()`, not the blanket
  // `passFree()` the other three document-lifecycle commands use — a running
  // hosted EFFECT is the one pass kind proven safe to close against (this
  // very suite), so `menuActions.ts`'s carve-out keeps `runCommand`
  // succeeding here exactly as it did before lot M. See `closeFree`'s own
  // docblock for the full argument.
  it('File > Close on the document raises no "document not found" failure; the card stays for the document now active', async () => {
    const a = addSavedDoc('take.wav');
    const b = addSavedDoc('other.wav');
    act(() => {
      useAppStore.getState().setActiveDocument(a.id);
    });
    render(<App />);
    await openTool('effect.amplify');
    applyOnFirstHalf();
    const bChannels = docById(b.id)!.channels;
    expect(isCommandEnabled('file.close')).toBe(true);

    // The menu's own command; a clean document closes without a prompt.
    let closing!: Promise<void>;
    act(() => {
      closing = runCommand('file.close');
    });
    expect(docById(a.id)).toBeNull();
    expect(useAppStore.getState().activeDocumentId).toBe(b.id);

    await flush();
    await act(async () => {
      await closing;
    });
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(docById(b.id)!.channels).toBe(bChannels);
    expect(getHistory(b.id).done).toEqual([]);
    expect(host()).toBeInTheDocument();
    expect(within(host()).getByTestId('effect-stale-hint')).toHaveTextContent(STALE_HINT);
    expect(hasOpenDialog()).toBe(false);
    expect(isPassRunning()).toBe(false);
  });

  it('closing the LAST document mid-Apply: the orphan rule drops the card and the returning worker raises no failure dialog', async () => {
    addSavedDoc('take.wav');
    render(<App />);
    await openTool('effect.amplify');
    applyOnFirstHalf();
    expect(isCommandEnabled('file.close')).toBe(true);

    let closing!: Promise<void>;
    act(() => {
      closing = runCommand('file.close');
    });
    expect(useAppStore.getState().documents).toHaveLength(0);
    expect(screen.queryByTestId('effect-host')).toBeNull();

    await flush();
    await act(async () => {
      await closing;
    });
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(hasOpenDialog()).toBe(false);
    expect(isPassRunning()).toBe(false);
  });
});

/**
 * Final round (finding 1): `showPanel`'s hand-off arm force-clears the module
 * lock. It was written for a hosted TOOL handing over its own finished result
 * (`RemixDialog` / `TranscribeDialog` calling the bus from inside the handler
 * that just completed), and that caller always owned the lock it cleared. The
 * effect card publishes the SAME lock through the same seam while its Apply
 * runs, and it is never that caller — a hosted effect and a hosted tool never
 * coexist (W1). What reaches the arm mid-Apply is a mouse-driven command
 * instead, whose reveal path calls the bus; clearing the lock for it un-greys
 * the strip, resumes every global shortcut and lets `openTool` / `openEffect`
 * unmount the card while its worker still runs.
 */
describe('a hand-off command mid-Apply never releases the effect card (final round)', () => {
  /** A real transcript for `docId`, through the real service — that is what
   * makes `Pipeline > Transcribe` take its REVEAL arm (`menuActions.ts`,
   * `getTranscript(id) !== null` -> `focusTranscriptPanel()`) instead of
   * opening the tool. The backend replaces `window.electronAPI` wholesale, so
   * the harness's own surface is put back before the app renders. */
  async function seedTranscriptFor(docId: string) {
    const harnessApi = (window as unknown as { electronAPI: unknown }).electronAPI;
    const backend = installTranscribeBackend();
    await seedTranscript(backend, docId, [
      { index: 0, startSample: 0, endSample: 8000, text: 'hello', vector: voiceVector(8, 0, 1) },
    ]);
    (window as unknown as { electronAPI: unknown }).electronAPI = harnessApi;
  }

  afterEach(() => {
    _resetTranscriptsForTest();
  });

  // Lot M: `edit.transcribe`'s own `enabled` now ANDs in `passFree()`
  // (menuActions.ts), so `runCommand` bails before it can even inspect which
  // arm — reveal or run — to take; the reveal is refused by the same
  // registry gate a fresh run would be, and the App-level message box this
  // test used to pin is unreachable for a door the registry gates (M3: the
  // refusal is a disabled command with a reason). `showMessageBox` still
  // fires for `TranscriptPanel.tsx`'s own "Transcribe again…" button, which
  // calls `openTranscribeDialog` directly and is the one surviving bypass —
  // not exercised by this suite.
  it('Pipeline > Transcribe, revealing an existing transcript, is refused while an effect applies — via the registry gate', async () => {
    const doc = addDoc();
    await seedTranscriptFor(doc.id);
    render(<App />);
    await openTool('effect.amplify');

    let finish!: (v: 'committed') => void;
    mockRun.mockReturnValueOnce(new Promise<'committed'>((resolve) => (finish = resolve)));
    await act(async () => {
      fireEvent.click(within(host()).getByRole('button', { name: 'Apply' }));
    });
    expect(hasOpenDialog()).toBe(false);
    expect(isPassRunning()).toBe(true);
    // Fix round 1 (MED) — restores the coverage the old
    // `showMessageBox.mock.calls[0][0].message).toContain(getEffect('amplify')!.name)`
    // assertion carried.
    expect(getRunningPass()?.label).toBe(getEffect('amplify')!.name);

    expect(isCommandEnabled('edit.transcribe')).toBe(false);
    await openTool('edit.transcribe');

    expect(showMessageBox).not.toHaveBeenCalled();
    // Nothing was released: the lock, the ✕ and the card itself. Fix round 1
    // (C3) — OVERTURNS the old premise that the STRIP stays disabled too: M2
    // lets a module switch through regardless (the strip was never the thing
    // this test is about — the registry gate refusing `edit.transcribe`
    // itself is), so it is checked enabled here instead.
    expect(hasOpenDialog()).toBe(false);
    expect(isPassRunning()).toBe(true);
    for (const button of within(strip()).getAllByRole('button')) {
      expect(button).not.toBeDisabled();
    }
    expect(host()).toHaveAttribute('data-effect-id', 'amplify');
    expect(within(host()).getByTestId('hosted-tool-close')).toBeDisabled();
    // And the doors that were re-opened by a release stay shut — also via
    // the registry gate now.
    expect(isCommandEnabled('effect.reverb')).toBe(false);
    await openTool('effect.reverb');
    expect(host()).toHaveAttribute('data-effect-id', 'amplify');
    expect(isCommandEnabled('tempo.match')).toBe(false);
    await openTool('tempo.match');
    expect(screen.queryByTestId('tool-host')).toBeNull();
    expect(host()).toHaveAttribute('data-effect-id', 'amplify');
    expect(showMessageBox).not.toHaveBeenCalled();
    void doc;

    await act(async () => {
      finish('committed');
    });
    expect(screen.queryByTestId('effect-host')).toBeNull();
    expect(hasOpenDialog()).toBe(false);
    expect(isPassRunning()).toBe(false);
  });

  // Fix round 1 (C-j) — OVERTURNS this test's old premise: it used to call
  // `focusTranscriptPanel()` ALONE (never `onClose()`) because `showPanel`'s
  // hand-off arm itself unmounted the tool and released its lock — calling
  // the bus function was a valid proxy for the whole hand-off. Lot C's C-j
  // amendment moves that release to `onClose()` alone (`showPanel` no longer
  // touches the lock or the mount at all — see its own docblock), so a real
  // hand-off now needs BOTH calls, exactly what RemixDialog/TranscribeDialog
  // actually do (`onClose(); focusRemixPanel();` or
  // `focusTranscriptPanel(); onClose();`) and exactly what the stub's
  // "finish and hand over" button reproduces. The invariant — a hosted TOOL
  // still hands over cleanly while it holds the lock, releasing it — is
  // unchanged; it is proven the way the real dialogs actually trigger it now.
  it('the hand-off itself is untouched: a hosted TOOL still hands over while it holds the lock', async () => {
    addDoc();
    render(<App />);
    await openTool('tempo.match');
    fireEvent.click(screen.getByRole('button', { name: 'start pass' }));
    expect(hasOpenDialog()).toBe(false);
    expect(isPassRunning()).toBe(true);

    // What TranscribeDialog does from inside its own completion handler:
    // `focusTranscriptPanel(); onClose();`, in the SAME synchronous block.
    fireEvent.click(screen.getByRole('button', { name: 'finish and hand over' }));

    expect(showMessageBox).not.toHaveBeenCalled();
    expect(screen.queryByTestId('tool-host')).toBeNull();
    expect(hasOpenDialog()).toBe(false);
    expect(isPassRunning()).toBe(false);
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'transcript');
    for (const button of within(strip()).getAllByRole('button')) expect(button).not.toBeDisabled();
  });

  /**
   * Fix round 1 (C-j, item 4) — the THIRD `showPanel` caller decisions.md's
   * C-j names: `edit.transcribe`'s mouse-driven reveal arm
   * (`menuActions.ts`, `getTranscript(id) !== null` -> `focusTranscriptPanel()`).
   * Before this fix, `showPanel` unconditionally unmounted whatever tool was
   * hosted — reaching this arm with an IDLE retained tool open (not running,
   * so `edit.transcribe` is enabled) silently destroyed it. C-j deletes that
   * unconditional clear; the reveal arm now backgrounds the retained tool
   * instead, exactly C1's "background, don't discard" promise.
   */
  it('reveals an existing transcript by BACKGROUNDING an idle retained tool, not destroying it', async () => {
    const doc = addDoc();
    await seedTranscriptFor(doc.id);
    render(<App />);
    await openTool('tempo.match');
    const node = screen.getByTestId('tool-host');
    expect(node).not.toHaveAttribute('data-backgrounded');
    expect(isPassRunning()).toBe(false);

    expect(isCommandEnabled('edit.transcribe')).toBe(true);
    await act(async () => {
      await runCommand('edit.transcribe');
    });

    // Backgrounded, not destroyed.
    expect(screen.getByTestId('tool-host')).toBe(node);
    expect(screen.getByTestId('tool-host')).toHaveAttribute('data-backgrounded', 'true');
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'transcript');

    fireEvent.click(stripButton('Pipeline'));
    expect(screen.getByTestId('tool-host')).toBe(node);
    expect(screen.getByTestId('tool-host')).not.toHaveAttribute('data-backgrounded');
  });
});

/**
 * Final round (finding 2): the card is not modal, so a Preview can be taken
 * off the shared engine by a plain mouse click. The transport's own load
 * effect answers a document switch by loading the new document, which stops
 * and replaces the preview — after which the card must stop offering 'Stop
 * Preview', or the button the user presses stops the transport they just
 * started instead.
 */
describe('a Preview the mouse took away (final round)', () => {
  function addSaved(name: string) {
    const doc = createDocument({
      name,
      sampleRate: 44100,
      channels: [new Float32Array(44100)],
      filePath: `C:/takes/${name}`,
      neverSaved: false,
    });
    act(() => {
      useAppStore.getState().addDocument(doc);
    });
    return doc;
  }

  function previewButton(): HTMLButtonElement {
    const stop = within(host()).queryByRole('button', { name: 'Stop Preview' });
    return (stop ?? within(host()).getByRole('button', { name: 'Preview' })) as HTMLButtonElement;
  }

  // Fix round 1 (C1/C-e) — OVERTURNS this test's old mechanism: it used to
  // switch the document via a click in the Files PANEL, which requires
  // leaving the Effects module — and under C-e that correctly backgrounds
  // (hides, non-interactive) the effect card, so a real user could not reach
  // its Preview button afterward either. What is actually under test is the
  // active-document SWITCH, not the Files panel specifically: any door that
  // changes `activeDocumentId` exercises the same "document moved" effect
  // (`EffectDialog`'s own key: `[activeDocumentId, activeDocChannels,
  // activeSampleRate]`), so it is driven directly through the store here,
  // with the card kept FOREGROUNDED throughout — exactly what the invariant
  // (a preview taken by the mouse leaves no stale button) needs.
  it('a document switch elsewhere in the app ends the preview; the button says Preview and starts a new one', async () => {
    const a = addSaved('take.wav');
    const b = addSaved('other.wav');
    act(() => {
      useAppStore.getState().setActiveDocument(a.id);
    });
    render(<App />);
    await openTool('effect.amplify');

    act(() => {
      fireEvent.click(within(host()).getByRole('button', { name: 'Preview' }));
    });
    expect(previewButton().textContent).toBe('Stop Preview');
    // The throwaway preview document, not the take.
    expect(playbackEngine.loadedDocumentId).not.toBe(a.id);

    act(() => {
      useAppStore.getState().setActiveDocument(b.id);
    });
    expect(useAppStore.getState().activeDocumentId).toBe(b.id);

    // The transport owns the engine now, and the card says so.
    expect(playbackEngine.loadedDocumentId).toBe(b.id);
    expect(previewButton().textContent).toBe('Preview');

    // Pressing it starts a preview of the document the user moved to — the
    // stale label would have stopped that document's playback instead.
    act(() => {
      fireEvent.click(previewButton());
    });
    expect(previewButton().textContent).toBe('Stop Preview');
    expect(playbackEngine.loadedDocumentId).not.toBe(b.id);
  });
});

/**
 * Final round 3 (finding 1) — `Escape`, with the card open and idle.
 *
 * Until item 6 the effect dialog was modal and `Escape` closed it. Hosted, the
 * card joins no dialog stack (`hasOpenDialog()` is false), installs no Escape
 * handler of its own by design, and the global table stays live — so the key
 * the user presses to dismiss the card reaches `edit.deselect` instead. The
 * runner resolves the LIVE selection and falls back to the whole document, so
 * the next Apply writes a different edit from the one Preview auditioned.
 *
 * The keystroke is dispatched from a button INSIDE the card — where focus sits
 * after a Preview click — so it travels the real path: not an editable target,
 * bubbles to the window listener `App` installs, no dialog on the stack.
 *
 * The behaviour is the accepted design (lot-level ruling: shortcuts stay live
 * beside a card). What these pin is that it is not SILENT: the card names the
 * span it will write, and the widening is on screen before Apply is pressed.
 */
describe('Escape with an effect card open (N18)', () => {
  function scope(): HTMLElement {
    return within(host()).getByTestId('effect-scope');
  }

  /** A real keydown, bubbling from `target` up through the document to the
   * window — the path `installShortcuts`' listener sits on. */
  async function pressEscapeOn(target: Element | Document) {
    await act(async () => {
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
    });
  }

  /** Apply through the REAL runner, then let the worker answer. */
  async function applyForReal() {
    mockRun.mockImplementation(realRun);
    fireEvent.click(within(host()).getByRole('button', { name: 'Apply' }));
    await act(async () => {});
  }

  it('closes an idle card — what Escape did when the effect was a modal — and the selection survives', async () => {
    addDoc();
    render(<App />);
    act(() => {
      useAppStore.getState().setSelection({ start: 0, end: 22050 });
    });
    await openTool('effect.amplify');
    expect(scope()).toHaveTextContent('Selection — 0:00.000 → 0:00.500 (0.50 s)');

    // From a plain BUTTON inside the card: the target `shortcuts.ts` would
    // otherwise have matched to `edit.deselect`.
    await pressEscapeOn(within(host()).getByRole('button', { name: 'Preview' }));

    expect(screen.queryByTestId('effect-host')).toBeNull();
    // The key never reached `edit.deselect`: the span Apply would have written
    // is still the user's.
    expect(useAppStore.getState().selection).toEqual({ start: 0, end: 22050 });
    expect(hasOpenDialog()).toBe(false);
    expect(isPassRunning()).toBe(false);
    // The ✕'s own aftermath: the module card beneath stays on Effects.
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'effects');
  });

  it('closes the card from the stage too: Escape pressed on the body with the card open', async () => {
    addDoc();
    render(<App />);
    act(() => {
      useAppStore.getState().setSelection({ start: 0, end: 22050 });
    });
    await openTool('effect.amplify');

    await pressEscapeOn(document.body);

    expect(screen.queryByTestId('effect-host')).toBeNull();
    expect(useAppStore.getState().selection).toEqual({ start: 0, end: 22050 });
  });

  it('restores the real document to the engine when a Preview was running — the ✕ path, not a new one', async () => {
    const doc = addDoc();
    render(<App />);
    await openTool('effect.amplify');
    const stop = jest.spyOn(playbackEngine, 'stop');
    const load = jest.spyOn(playbackEngine, 'load');
    try {
      fireEvent.click(within(host()).getByRole('button', { name: 'Preview' }));
      expect(within(host()).getByRole('button', { name: 'Stop Preview' })).toBeInTheDocument();
      stop.mockClear();
      load.mockClear();

      await pressEscapeOn(document.body);

      expect(screen.queryByTestId('effect-host')).toBeNull();
      expect(stop).toHaveBeenCalled();
      expect(load).toHaveBeenCalledWith(expect.objectContaining({ id: doc.id }));
      expect(playbackEngine.loadedDocumentId).toBe(doc.id);
    } finally {
      stop.mockRestore();
      load.mockRestore();
    }
  });

  // M6 overturns this test's old premise. Before lot M, `hasOpenDialog()`
  // suspended EVERY global shortcut while a hosted pass ran, so Escape did
  // nothing at all and the selection was untouchable proof of that. Now the
  // modal stack (what `hasOpenDialog()` means) stays empty behind a
  // BACKGROUNDED pass, so a global Escape reaches `edit.deselect` exactly as
  // it would idle. That is safe: `edit.deselect` only clears the live
  // `selection` field, and the running Apply already snapshotted its own
  // region before the worker started (T6-3) — clearing the GLOBAL selection
  // cannot corrupt an in-flight commit, it only changes what a LATER edit
  // would act on. What must still hold is that the CARD and its lock are
  // untouched by a global key (`DialogShell`'s hosted branch installs no
  // Escape handler of its own, N18).
  it('does not touch the card or its lock while Apply runs; the global deselect now reaches the store (M6)', async () => {
    addDoc();
    render(<App />);
    act(() => {
      useAppStore.getState().setSelection({ start: 0, end: 22050 });
    });
    await openTool('effect.amplify');

    let finish!: (v: 'committed') => void;
    mockRun.mockReturnValueOnce(new Promise<'committed'>((resolve) => (finish = resolve)));
    await act(async () => {
      fireEvent.click(within(host()).getByRole('button', { name: 'Apply' }));
    });
    expect(hasOpenDialog()).toBe(false);
    expect(isPassRunning()).toBe(true);

    await pressEscapeOn(within(host()).getByRole('button', { name: 'Preview' }));
    await pressEscapeOn(document.body);

    // The card and its lock: untouched by the global key.
    expect(host()).toHaveAttribute('data-effect-id', 'amplify');
    expect(hasOpenDialog()).toBe(false);
    expect(isPassRunning()).toBe(true);
    expect(within(host()).getByTestId('hosted-tool-close')).toBeDisabled();
    // Fix round 1 (C3) — OVERTURNS the old "strip stays disabled too"
    // premise: M2 lets a module switch through regardless of a running pass.
    for (const button of within(strip()).getAllByRole('button')) expect(button).not.toBeDisabled();
    // M6: the keyboard stays live, so the global Escape -> edit.deselect DOES
    // reach the store now.
    expect(useAppStore.getState().selection).toBeNull();

    // The pass finishes as before: the card unmounts with nothing left locked.
    await act(async () => {
      finish('committed');
    });
    expect(screen.queryByTestId('effect-host')).toBeNull();
    expect(hasOpenDialog()).toBe(false);
    expect(isPassRunning()).toBe(false);
  });

  it('with no card open, Escape keeps its meaning: Deselect', async () => {
    addDoc();
    render(<App />);
    act(() => {
      useAppStore.getState().setSelection({ start: 0, end: 22050 });
    });
    expect(screen.queryByTestId('effect-host')).toBeNull();

    await pressEscapeOn(document.body);

    expect(useAppStore.getState().selection).toBeNull();
  });

  it('after the card is closed by Escape, the next Escape deselects as before', async () => {
    addDoc();
    render(<App />);
    act(() => {
      useAppStore.getState().setSelection({ start: 0, end: 22050 });
    });
    await openTool('effect.amplify');

    await pressEscapeOn(document.body);
    expect(screen.queryByTestId('effect-host')).toBeNull();
    expect(useAppStore.getState().selection).toEqual({ start: 0, end: 22050 });

    await pressEscapeOn(document.body);
    expect(useAppStore.getState().selection).toBeNull();
  });

  it('control: with the selection left alone, Apply writes only the selection', async () => {
    const doc = addDoc();
    render(<App />);
    act(() => {
      useAppStore.getState().setSelection({ start: 0, end: 22050 });
    });
    await openTool('effect.amplify');

    await applyForReal();

    expect(useAppStore.getState().selection).toEqual({ start: 0, end: 22050 });
    expect(getHistory(doc.id).done).toEqual([`Effect: ${getEffect('amplify')!.name}`]);
  });
});
