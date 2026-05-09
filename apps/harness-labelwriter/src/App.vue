<script setup lang="ts">
/**
 * Top-level shell. Single-page guided UX: sections stack vertically
 * and stay visible once reached. No stepper, no next/back — the
 * operator scrolls.
 *
 * Multi-engine devices (Twin Turbo, Duo) get an extra `<EngineTabs>`
 * strip after IdentitySection — each tab scopes the Media / Print /
 * Assessment sections to one engine's session slot. Single-engine
 * devices render exactly as before, with no tab strip and no extra
 * chrome (per plan 09 hard rule: 6-LW renders identically to today).
 *
 * If the browser lacks WebUSB (and we're not in mock mode), the
 * Connect section is replaced by an `UnsupportedBrowser` screen
 * pointing the operator at alternative browsers / the CLI / mock
 * mode. The downstream sections gate on `isConnected`, so they stay
 * hidden until a real connection happens.
 */
import { computed } from 'vue';
import AppHeader from './components/AppHeader.vue';
import AppFooter from './components/AppFooter.vue';
import ConnectSection from './components/ConnectSection.vue';
import MediaSection from './components/MediaSection.vue';
import PrintSection from './components/PrintSection.vue';
import AssessmentSection from './components/AssessmentSection.vue';
import SubmitSection from './components/SubmitSection.vue';
import EngineTabs from './components/EngineTabs.vue';
import UnsupportedBrowser from './components/UnsupportedBrowser.vue';
import { canRunOnThisBrowser } from './composables/useCapabilities';
import { device } from './state/session';

const supported = canRunOnThisBrowser();
const isMultiEngine = computed(() => (device.value?.engines.length ?? 0) > 1);
</script>

<template>
  <AppHeader />
  <main class="page">
    <section class="intro">
      <h1>How does your LabelWriter actually behave?</h1>
      <p class="lede">
        This page walks you through one diagnostic print and one short report. It takes about two
        minutes — the printer prints once, you eyeball the output, you pick a verdict, you submit.
      </p>
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
