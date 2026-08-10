import type { PackFrame } from './PackFrame'
import type { ScenarioName } from './ScenarioName'
import type { SolarFrame } from './SolarFrame'

/**
 * One captured condition, playable from end to end.
 *
 * The two streams stay apart rather than being merged into paired rows here. The pack and the
 * controller are separate radios on separate cadences, and pairing them at distill time would have
 * to invent a value for whichever had not spoken yet — the same reason the archive stores them as
 * two streams. The playback clock merges them by timestamp as it walks, which is what a real
 * afternoon on the boat does to them anyway.
 */
export interface PlaybackScenario {
  readonly name: ScenarioName
  /** What the control panel's button says. */
  readonly title: string
  /** What the capture shows, in prose, so the panel can explain what the button will do. */
  readonly note: string
  /** First frame to last, in milliseconds. A loop advances its time base by exactly this. */
  readonly spanMs: number
  readonly pack: readonly PackFrame[]
  readonly solar: readonly SolarFrame[]
}
