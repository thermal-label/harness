<script setup lang="ts">
/**
 * Top-level shell component. Composes the section flow:
 *
 *   AppHeader → intro → ConnectSection → [EngineTabs?] →
 *   MediaSection → PrintSection → AssessmentSection → SubmitSection →
 *   AppFooter
 *
 * Sections read the adapter via `useAdapter()` and the shared session
 * store via `useSession()`. Engine tabs render iff the connected
 * device declares more than one engine — single-engine devices stay
 * flat regardless.
 *
 * If the browser lacks the required transport API (today: WebUSB),
 * the Connect section is replaced by `<UnsupportedBrowser>` pointing
 * at alternative browsers / CLI / mock mode.
 */
import { computed } from 'vue';
import AppHeader from './sections/AppHeader.vue';
import AppFooter from './sections/AppFooter.vue';
import ConnectSection from './sections/ConnectSection.vue';
import MediaSection from './sections/MediaSection.vue';
import PrintSection from './sections/PrintSection.vue';
import AssessmentSection from './sections/AssessmentSection.vue';
import SubmitSection from './sections/SubmitSection.vue';
import EngineTabs from './sections/EngineTabs.vue';
import UnsupportedBrowser from './sections/UnsupportedBrowser.vue';
import { canRunOnThisBrowser } from './composables/useCapabilities';
import { useAdapter } from './state/adapterContext';
import { useSession } from './state/session';

const adapter = useAdapter();
const session = useSession();
const supported = canRunOnThisBrowser();

const isMultiEngine = computed(() => {
  const dev = session.device.value as { engines?: readonly unknown[] } | null;
  if (!dev?.engines) return false;
  return dev.engines.length > 1;
});

const heading = computed(
  () => adapter.pageHeading ?? `How does your ${adapter.driverDisplayName} actually behave?`,
);
const blurb = computed(
  () =>
    adapter.introBlurb ??
    'This page walks you through one diagnostic print and one short report. It takes about two minutes — the printer prints once, you eyeball the output, you pick a verdict, you submit.',
);
</script>

<template>
  <AppHeader />
  <main class="page">
    <section class="intro">
      <h1>{{ heading }}</h1>
      <p class="lede">{{ blurb }}</p>
    </section>

    <UnsupportedBrowser v-if="!supported" />
    <template v-else>
      <ConnectSection />
      <EngineTabs v-if="isMultiEngine" />
      <MediaSection />
      <PrintSection />
      <AssessmentSection />
      <SubmitSection />
    </template>
  </main>
  <AppFooter />
</template>

<style scoped>
.page {
  max-width: 760px;
  margin: 0 auto;
  padding: var(--space-5);
}

.intro {
  margin: var(--space-5) 0 var(--space-6);
}

.lede {
  font-size: 1.05rem;
  color: var(--fg-muted);
  max-width: 60ch;
}
</style>
