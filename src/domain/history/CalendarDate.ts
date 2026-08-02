/**
 * A day on the wall calendar, written `YYYY-MM-DD`.
 *
 * A Victron day record names a day and never an instant. It carries no hour, no zone and no clock
 * of its own — the controller counts days, and the register a day sits in says how many days ago it
 * was. Turning that into an epoch millisecond would require a zone the record does not carry, and
 * every fold downstream would then be reading a placement this browser invented rather than the day
 * the controller actually recorded.
 *
 * So the archive keeps the day as a day. It is a string rather than a number because a calendar
 * date has no arithmetic of its own: two dates compare, one steps to the next, and nothing about it
 * survives a conversion to milliseconds unchanged.
 */
export type CalendarDate = string
