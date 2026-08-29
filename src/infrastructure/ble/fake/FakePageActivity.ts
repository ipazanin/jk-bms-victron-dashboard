/**
 * The page as the rejoin supervisors are told to see it, so a tab that is plainly in front of the
 * developer can still be put behind something for as long as it takes to watch what happens.
 *
 * It can only ever take the page away, never claim it is in front when it is not: each answer is the
 * lever AND the browser's own answer. A window genuinely moved behind another still narrows the
 * pack's hunt and stands the controller's watch down, exactly as it does on the boat, and the levers
 * are for the states a machine with one screen cannot both cause and watch.
 */

import { browserPageActivity } from '../../../application/pageActivity'
import type { PageActivity } from '../../../application/pageActivity'

export class FakePageActivity implements PageActivity {
  private readonly browser: PageActivity = browserPageActivity()
  private saidVisible = true
  private saidFocused = true
  private readonly listeners = new Set<() => void>()

  constructor() {
    this.browser.subscribe(() => this.announce())
  }

  visible(): boolean {
    return this.saidVisible && this.browser.visible()
  }

  focused(): boolean {
    return this.saidFocused && this.browser.focused()
  }

  subscribe(onChange: () => void): () => void {
    this.listeners.add(onChange)
    return () => {
      this.listeners.delete(onChange)
    }
  }

  /** The tab put behind another tab, which is what kills an advertisement watch outright. */
  showTab(showing: boolean): void {
    this.saidVisible = showing
    this.announce()
  }

  /** The window left showing but no longer typed into — the state Chromium also tears watches down for. */
  holdFocus(focused: boolean): void {
    this.saidFocused = focused
    this.announce()
  }

  private announce(): void {
    for (const listener of this.listeners) listener()
  }
}
