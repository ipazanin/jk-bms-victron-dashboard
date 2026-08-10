// @vitest-environment jsdom

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'

// The entry file run the way the browser runs it, for the one failure the dev panel cannot report,
// being the panel.
//
// A playback build with no controls on it is indistinguishable from the real dashboard, so a panel
// that never arrives has to say so in the page. Two unrelated things stop it arriving and only one
// of them is a rejected import: `then(onFulfilled, onRejected)` hands a rejection to the second
// argument but never routes a throw out of the first, so a panel that fails while mounting is
// invisible to that shape — Vue rethrows a setup error straight out of `mount`, the rejection
// leaves unhandled, and the host stays empty on a page that looks exactly as it should. Catching
// after the mount is what covers both, so both are checked here, each against the text a developer
// would read off the page and against nothing having escaped instead.

const PANEL = '../src/components/dev/DevControlPanel.vue'

const MOUNT_FAILURE = 'the panel threw before it painted anything'

/** The whole sentence, and that a reason for it reached the page. */
const FAILURE_LINE = /^The fake radio controls would not load — .+/u

vi.stubEnv('VITE_FAKE_BLE', 'true')

// The shell is stood in for. The entry mounts it first and a real one opens the archive and starts
// a controller, none of which sits between the import below and the host it fills.
vi.mock('../src/App.vue', () => ({
  default: defineComponent({
    name: 'ShellStandIn',
    setup() {
      return () => h('div', { class: 'shell' })
    },
  }),
}))

// jsdom implements no matchMedia, and the entry resolves the stored theme before it mounts anything.
window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
})) as unknown as typeof window.matchMedia

const escapedRejections: unknown[] = []

function noteEscapedRejection(rejection: unknown): void {
  escapedRejections.push(rejection)
}

process.on('unhandledRejection', noteEscapedRejection)

beforeEach(() => {
  escapedRejections.length = 0
  // The entry appends its host to a body that already holds the shell's mount point, as the served
  // page does, and re-runs from nothing each time because its work is all import-time.
  document.body.innerHTML = '<div id="app"></div>'
  vi.resetModules()
})

afterAll(() => {
  process.off('unhandledRejection', noteEscapedRejection)
  document.body.innerHTML = ''
  vi.unstubAllEnvs()
})

function devControlsHost(): HTMLElement | null {
  return document.querySelector('#dev-controls')
}

/**
 * Waits for the panel's import to have finished one way or another — painted, or gone unhandled —
 * so that a run where nothing was written into the host still reaches the assertions about why.
 * The wait can return in the turn the host was painted in, and Node reports an unhandled rejection
 * at the end of a turn rather than as it happens, so the count means nothing until one more passes.
 */
async function afterThePanelImportSettles(): Promise<void> {
  await vi.waitFor(() => {
    const painted = devControlsHost()?.textContent !== ''
    expect(painted || escapedRejections.length > 0).toBe(true)
  })
  await new Promise((settle) => setTimeout(settle, 0))
}

describe('the dev controls a playback build mounts beside the shell', () => {
  it('gives the panel a host of its own, outside the one the shell was mounted into', async () => {
    vi.doMock(PANEL, () => ({
      default: defineComponent({
        name: 'PanelStandIn',
        setup() {
          return () => h('p', 'Fake radio controls')
        },
      }),
    }))

    await import('../src/main')
    await afterThePanelImportSettles()

    expect(escapedRejections).toEqual([])
    expect(devControlsHost()?.textContent).toBe('Fake radio controls')
    expect(document.querySelector('#app')?.contains(devControlsHost())).toBe(false)
  })

  it('writes the failure into the host when the chunk will not load', async () => {
    vi.doMock(PANEL, () => {
      throw new TypeError('Failed to fetch dynamically imported module')
    })

    await import('../src/main')
    await afterThePanelImportSettles()

    expect(escapedRejections).toEqual([])
    // The reason itself is not pinned here: a module the runner declines to evaluate rejects with
    // the runner's own sentence rather than with the one thrown. That some reason reached the page
    // is the claim, and the case below is where the wording of one is checked.
    expect(devControlsHost()?.textContent).toMatch(FAILURE_LINE)
  })

  it('writes the failure into the host when the panel throws while mounting', async () => {
    vi.doMock(PANEL, () => ({
      default: defineComponent({
        name: 'PanelThatThrows',
        setup() {
          throw new Error(MOUNT_FAILURE)
        },
      }),
    }))

    await import('../src/main')
    await afterThePanelImportSettles()

    expect(escapedRejections).toEqual([])
    expect(devControlsHost()?.textContent).toMatch(FAILURE_LINE)
    expect(devControlsHost()?.textContent).toContain(MOUNT_FAILURE)
  })
})
