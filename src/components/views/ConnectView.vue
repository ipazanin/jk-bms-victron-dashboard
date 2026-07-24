<script setup lang="ts">
import { computed } from 'vue'

import ConnectPanel from '../ConnectPanel.vue'
import { loadAdvertisementKey } from '../../application/storage'
import { useTelemetry } from '../../application/telemetry'

const telemetry = useTelemetry()
const {
  capabilities,
  adapterOn,
  source,
  bmsState,
  solarState,
  bmsError,
  solarError,
  foreignDeviceSeen,
  lastDevice,
} = telemetry

const initialKey = loadAdvertisementKey()

const canReconnect = computed(() => capabilities.canReconnect && lastDevice.value !== null)
const reconnectName = computed(() => lastDevice.value?.name ?? null)
</script>

<template>
  <section class="connect" data-testid="connect-view">
    <header class="head">
      <h2 class="head-title">Connect</h2>
      <p class="copy head-sub">
        Pair the BMS and, if you have one, the Victron solar controller — both stay local to this
        browser.
      </p>
    </header>

    <div class="body">
      <ConnectPanel
        class="card"
        :capabilities="capabilities"
        :adapter-on="adapterOn"
        :source="source"
        :bms-state="bmsState"
        :solar-state="solarState"
        :bms-error="bmsError"
        :solar-error="solarError"
        :foreign-device-seen="foreignDeviceSeen"
        :initial-key="initialKey"
        :can-reconnect="canReconnect"
        :reconnect-name="reconnectName"
        @connect-bms="telemetry.connectBms"
        @reconnect-bms="telemetry.reconnectBms"
        @disconnect-bms="telemetry.disconnectBms"
        @start-solar="telemetry.startSolar"
        @stop-solar="telemetry.stopSolar"
      />
    </div>
  </section>
</template>

<style scoped>
.connect {
  container-type: inline-size;
}

.head {
  padding: clamp(1rem, 3vw, 1.75rem) var(--pad) 0;
}

.head-title {
  margin: 0;
  font-family: var(--font-body);
  font-weight: 600;
  font-size: clamp(1.35rem, 1rem + 1.6vw, 1.85rem);
  letter-spacing: -0.01em;
  color: var(--ink);
}

.head-sub {
  margin: 0.4rem 0 0;
}

.body {
  display: flex;
  flex-direction: column;
  gap: clamp(1rem, 2.5vw, 1.5rem);
  padding: 1.25rem var(--pad) 2.5rem;
}

/*
 * ConnectPanel supplies its own padding; `.card` (the global elevated-surface utility in
 * tokens.css) falls through onto its root for the background, edge, radius and shadow, matching
 * the Bus and Stats cards. ConnectPanel's own top border and its BMS/solar divider predate that
 * utility and still draw a 1px --gridline rule; overridden here — at higher specificity than its
 * single-class rule, so this wins regardless of stylesheet order — so the card reads as one
 * elevated surface with breathing room standing in for the old rule, not a redundant line.
 */
.card.card {
  border-top-color: var(--card-border);
}

.card :deep(.solar) {
  border-top: none;
  margin-top: 1.5rem;
  padding-top: 0;
}
</style>
