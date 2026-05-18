<script setup lang="ts">
/**
 * Small attribution / source link at the foot of the page.
 *
 * Reports-go-to link reads `adapter.targetRepo` so each driver app
 * points its operators at the right repo's issues page. The version
 * line shows the harness app + driver-core versions — the same pair
 * embedded in every submitted report.
 */
import { useAdapter } from '../state/adapterContext';

const adapter = useAdapter();
</script>

<template>
  <footer class="footer">
    <p class="muted">
      thermal-label · {{ adapter.driverDisplayName }} hardware harness · source on
      <a href="https://github.com/thermal-label/harness" rel="noopener" target="_blank">github</a>.
      Reports go to the
      <a :href="`https://github.com/${adapter.targetRepo}/issues`" rel="noopener" target="_blank">
        {{ adapter.driverDisplayName }} repo
      </a>
      .
    </p>
    <p class="versions">
      harness {{ adapter.harnessVersion }} · {{ adapter.driverKey }}-core
      {{ adapter.driverVersion }}
    </p>
  </footer>
</template>

<style scoped>
.footer {
  padding: var(--space-5) var(--space-5) var(--space-6);
  font-size: 0.85rem;
  border-top: 1px solid var(--border);
  margin-top: var(--space-6);
  text-align: center;
}

.versions {
  margin-top: var(--space-2);
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--fg-faint);
}
</style>
