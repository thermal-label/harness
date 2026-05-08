<script setup lang="ts">
/**
 * Top-level shell. Single-page guided UX: sections stack vertically
 * and stay visible once reached. No stepper, no next/back — the
 * operator scrolls.
 *
 * Subsequent commits land the section components; today this is the
 * shell with header/footer + intro copy so the bootstrap step is
 * self-contained and visible.
 */
import AppHeader from './components/AppHeader.vue';
import AppFooter from './components/AppFooter.vue';
</script>

<template>
  <AppHeader />
  <main class="page">
    <section class="intro">
      <h1>How does your LabelManager actually behave?</h1>
      <p class="lede">
        This page walks you through one diagnostic print and one short report. It takes about two
        minutes — the printer prints once, you eyeball the output, you pick a verdict, you submit.
      </p>
    </section>
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
