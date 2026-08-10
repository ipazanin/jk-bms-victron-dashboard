/**
 * The conditions the boat captures hold, and so the only ones playback can run.
 *
 * A union rather than a free string: the panel's buttons, the fixture's rows and the controller's
 * scenario switch all name the same two things, and a third name would have to be captured on real
 * hardware before it could mean anything. A typo names nothing and the type checker says so.
 */
export type ScenarioName = 'float' | 'discharge'
