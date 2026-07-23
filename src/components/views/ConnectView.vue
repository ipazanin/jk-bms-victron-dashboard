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
  <ConnectPanel
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
</template>
