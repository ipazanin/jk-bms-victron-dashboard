<script setup lang="ts">
/**
 * Three views of history, from the three sources that actually exist.
 *
 * Daily energy is folded from this browser's own recordings — the BMS keeps no per-day series — so
 * it grows with the log. Lifetime counters and the event logbook come from the pack itself: the
 * counters from whatever frame is on the instruments now, the logbook from the last time this
 * browser read one, kept so it can be reviewed off the boat.
 */
import { computed, onMounted } from 'vue'

import { dailyTotals } from '../../application/history/daily'
import { useHistoryBrowser } from '../../application/history/historyBrowser'
import { eventWallTime } from '../../application/logbook'
import { ampHours, duration, hours, kilowattHours } from '../../application/format'
import { hashOf } from '../../application/route'
import { useTelemetry } from '../../application/telemetry'

const telemetry = useTelemetry()
const { battery, device, logbook, source } = telemetry
const browser = useHistoryBrowser()

onMounted(() => {
  void browser.refresh().catch(() => undefined)
})

const connectHref = hashOf({ name: 'connect' })
const logHref = hashOf({ name: 'log' })

// ── daily energy ──────────────────────────────────────────────────────────────

const days = computed(() => dailyTotals(browser.sessions.value.map((listing) => listing.record), Date.now()))
const maxSolarAh = computed(() => Math.max(1, ...days.value.map((day) => day.solarAh)))

const dayLabel = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' })

/** Signed amp-hours at whole precision, with negative zero normalised so a flat day is not '−0 Ah'. */
function packNet(value: number): string {
  const rounded = Math.round(value)
  return `${rounded === 0 ? 0 : rounded} Ah`
}

// ── lifetime counters ─────────────────────────────────────────────────────────

/** Present whenever a pack is on the instruments — live, remembered or a browsed session. */
const lifetime = computed(() => {
  const pack = battery.value
  const info = device.value
  if (pack === null && info === null) return null
  return {
    cycleCount: pack?.cycleCount ?? null,
    cycledCapacity: pack?.cycledCapacity ?? null,
    powerOnCount: info?.powerOnCount ?? null,
    uptimeSeconds: pack?.uptimeSeconds ?? info?.uptimeSeconds ?? null,
    model: info?.model ?? null,
  }
})

// ── device logbook ────────────────────────────────────────────────────────────

const stamp = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

/** Newest first, each with a real date when the boot instant is known, else elapsed-since-boot. */
const logbookRows = computed(() => {
  const stored = logbook.value
  if (stored === null) return []
  return [...stored.events].reverse().map((event) => {
    const wall = eventWallTime(stored, event)
    return {
      key: `${event.secondsSinceBoot}:${event.code}`,
      label: event.label,
      when: wall === null ? `+${duration(event.secondsSinceBoot)}` : stamp.format(wall),
    }
  })
})

const logbookAge = computed(() => {
  const stored = logbook.value
  if (stored === null) return null
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(
    stored.fetchedAt,
  )
})
</script>

<template>
  <section class="stats" data-testid="stats-view">
    <header class="head">
      <h2 class="plate">Stats &amp; history</h2>
    </header>

    <!-- Lifetime counters, straight off the pack. -->
    <section v-if="lifetime !== null" class="panel">
      <h3 class="plate">Lifetime</h3>
      <p class="muted since">Since the pack was commissioned{{ lifetime.model ? ` · ${lifetime.model}` : '' }}</p>
      <dl class="tiles">
        <div v-if="lifetime.cycleCount !== null" class="tile">
          <dt>Cycles</dt>
          <dd class="secondary-figure">{{ lifetime.cycleCount }}</dd>
        </div>
        <div v-if="lifetime.cycledCapacity !== null" class="tile">
          <dt>Cycled capacity</dt>
          <dd class="secondary-figure">{{ ampHours(lifetime.cycledCapacity, 0) }}</dd>
        </div>
        <div v-if="lifetime.powerOnCount !== null" class="tile">
          <dt>Power-ons</dt>
          <dd class="secondary-figure">{{ lifetime.powerOnCount }}</dd>
        </div>
        <div v-if="lifetime.uptimeSeconds !== null" class="tile">
          <dt>Uptime</dt>
          <dd class="secondary-figure">{{ duration(lifetime.uptimeSeconds) }}</dd>
        </div>
      </dl>
    </section>

    <!-- Daily energy, folded from recordings. -->
    <section class="panel">
      <h3 class="plate">Daily energy</h3>
      <p class="muted since">Folded from this browser's recordings — the pack keeps no daily history of its own.</p>

      <p v-if="days.length === 0" class="copy state">
        Nothing recorded yet. Days appear here as you record sessions in the
        <a :href="logHref">log</a>.
      </p>

      <div v-else class="daily-scroll">
      <table class="daily">
        <thead>
          <tr>
            <th class="col-day">Day</th>
            <th>Recorded</th>
            <th class="num">Solar in</th>
            <th class="num">House out</th>
            <th class="num">Pack net</th>
            <th class="num">Deepest</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="day in days" :key="day.day">
            <td class="col-day">{{ dayLabel.format(day.day) }}</td>
            <td class="recorded">
              {{ hours(day.recordedMs / 3_600_000) }}
              <span class="muted count">· {{ day.sessions }}</span>
            </td>
            <td class="num solar">
              <span class="bar" :style="{ '--fill': `${(day.solarAh / maxSolarAh) * 100}%` }" />
              <span class="readout">{{ ampHours(day.solarAh, 0) }}</span>
            </td>
            <td class="num readout house-fig">{{ kilowattHours(day.houseWh / 1000) }}</td>
            <td class="num readout">{{ packNet(day.packAh) }}</td>
            <td class="num readout">{{ day.deepestSoc === null ? '—' : `${day.deepestSoc}%` }}</td>
          </tr>
        </tbody>
      </table>
      </div>
    </section>

    <!-- The device's own event log. -->
    <section class="panel">
      <h3 class="plate">Device logbook</h3>
      <p v-if="logbookAge !== null" class="muted since">
        Read from the pack {{ logbookAge }}. Power cycles and protection events, back to first power-on.
      </p>

      <p v-if="logbookRows.length === 0" class="copy state">
        <template v-if="source === 'live'">Waiting for the pack to send its logbook…</template>
        <template v-else>
          No logbook read yet. <a :href="connectHref">Connect the BMS</a> and it is fetched
          automatically; it then stays here for review.
        </template>
      </p>

      <ul v-else class="logbook">
        <li v-for="row in logbookRows" :key="row.key" class="event">
          <span class="when readout">{{ row.when }}</span>
          <span class="what">{{ row.label }}</span>
        </li>
      </ul>
    </section>
  </section>
</template>

<style scoped>
.stats {
  background: var(--surface);
}

.head {
  padding: 1.25rem var(--pad);
  border-bottom: 1px solid var(--gridline);
}

.head h2 {
  margin: 0;
}

.panel {
  padding: 1.25rem var(--pad);
  border-bottom: 1px solid var(--gridline);
}

.panel h3 {
  margin: 0;
}

.since {
  margin: 0.35rem 0 1rem;
}

.state {
  margin: 0.5rem 0 0;
}

.state a,
.since a {
  color: var(--pack-ink);
}

/* Lifetime tiles */
.tiles {
  display: grid;
  /* auto-fit, not auto-fill: the last tiles stretch to fill the row rather than leaving an empty
     track showing the gridline background through the gap. */
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: 1px;
  margin: 0;
  background: var(--gridline);
}

.tile {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.85rem;
  background: var(--surface);
}

.tile dt {
  font-family: var(--font-label);
  font-size: 0.6875rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-muted);
}

.tile dd {
  margin: 0;
  color: var(--ink);
}

/* Daily table — scrolls inside its own box on a narrow phone rather than widening the page. */
.daily-scroll {
  overflow-x: auto;
}

.daily {
  width: 100%;
  min-width: 24rem;
  border-collapse: collapse;
  font-size: 0.875rem;
}

.daily th {
  font-family: var(--font-label);
  font-size: 0.6875rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-muted);
  font-weight: 600;
  text-align: left;
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid var(--gridline);
}

.daily td {
  padding: 0.5rem 0.6rem;
  border-bottom: 1px solid var(--gridline);
  color: var(--ink);
  vertical-align: middle;
}

.daily .num {
  text-align: right;
}

.col-day {
  font-family: var(--font-label);
  letter-spacing: 0.02em;
  white-space: nowrap;
}

.recorded .count {
  margin-left: 0.15rem;
}

/* Solar cell carries a proportional bar behind its figure. */
.solar {
  position: relative;
}

.solar .bar {
  position: absolute;
  left: 0.6rem;
  right: 0.6rem;
  bottom: 0.25rem;
  height: 3px;
  background: linear-gradient(to right, var(--solar) var(--fill), transparent var(--fill));
  opacity: 0.7;
}

.house-fig {
  color: var(--house-ink);
}

/* Logbook */
.logbook {
  list-style: none;
  margin: 0;
  padding: 0;
}

.event {
  display: flex;
  align-items: baseline;
  gap: 1rem;
  padding: 0.4rem 0;
  border-bottom: 1px solid var(--gridline);
}

.event:last-child {
  border-bottom: none;
}

.when {
  flex: none;
  width: 8.5rem;
  color: var(--ink-muted);
  font-size: 0.8125rem;
}

.what {
  color: var(--ink);
}

@media (max-width: 560px) {
  .when {
    width: 6.5rem;
  }
}
</style>
