/**
 * The four charger error codes a history record keeps, most recent first. 0 is "no error".
 *
 * Fixed at four rather than modelled as a list, because the register is four bytes wide and always
 * writes all four: a controller that has never faulted reports four zeros, not an empty history.
 * Every captured day on this boat reads 0,0,0,0, which is what a fault-free two months looks like.
 */
export type RecentChargerErrors = readonly [number, number, number, number]
