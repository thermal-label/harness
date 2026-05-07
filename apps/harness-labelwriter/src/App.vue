<script setup lang="ts">
/**
 * Top-level shell. Single-page guided UX: sections stack vertically
 * and stay visible once reached. No stepper, no next/back — the
 * operator scrolls.
 */
import AppHeader from './components/AppHeader.vue';
import AppFooter from './components/AppFooter.vue';
import ConnectSection from './components/ConnectSection.vue';
import IdentitySection from './components/IdentitySection.vue';
import MediaSection from './components/MediaSection.vue';
import PrintSection from './components/PrintSection.vue';
import AssessmentSection from './components/AssessmentSection.vue';
import SubmitSection from './components/SubmitSection.vue';
</script>

<template>
  <AppHeader />
  <main class="page">
    <section class="intro">
      <h1>How does your LabelWriter actually behave?</h1>
      <p class="lede">
        This page walks you through one diagnostic print and one short report. It takes about two
        minutes — the printer prints once, you eyeball the output, you pick a verdict, you submit.
        You'll need a USB-connected LabelWriter and a working browser USB stack (Chrome/Edge —
        Firefox doesn't ship WebUSB).
      </p>
    </section>

    <ConnectSection />
    <IdentitySection />
    <MediaSection />
    <PrintSection />
    <AssessmentSection />
    <SubmitSection />
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
