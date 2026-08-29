/**
 * Who a Victron advertisement could have come from, which is a fact about the radio that heard it.
 *
 * Every Victron on earth broadcasts under one company id, so a rejection means nothing on its own:
 * the same three bytes are a statement about this boat's controller on one route and a statement
 * about the marina on the other. A radio that watches one chooser-picked handle hears nobody else,
 * so a key that does not match there can only be the stored key gone stale. A radio scanning for
 * the company id hears every unit in range, where the same mismatch is most often a neighbour's
 * charger being exactly what it is.
 *
 * It travels with the rejection because only the transport knows it, and the sentence the owner
 * reads is wrong on one route or the other unless it is told which.
 */
export type SolarAdvertisementSource = 'this-controller' | 'anything-in-range'
