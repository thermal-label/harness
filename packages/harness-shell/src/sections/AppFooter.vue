<script setup lang="ts">
/**
 * Small attribution / source link at the foot of the page.
 *
 * Reports-go-to link reads `adapter.targetRepo` so each driver app
 * points its operators at the right repo's issues page.
 */
import { useAdapter } from '../state/adapterContext';

const adapter = useAdapter();
</script>

<template>
  <footer class="footer">
    <p class="muted">
      thermal-label · {{ adapter.driverKey }} hardware harness · source on
      <a href="https://github.com/thermal-label/harness" rel="noopener" target="_blank">github</a>.
      Reports go to the
      <a :href="`https://github.com/${adapter.targetRepo}/issues`" rel="noopener" target="_blank">
        {{ adapter.driverKey }} repo
      </a>
      .
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
</style>
