<script setup lang="ts">
/**
 * Top-level shell. Sections are placeholders in this commit; each one
 * grows into a fully-wired component over the following commits.
 *
 * Single-page guided UX: sections stack vertically and stay visible
 * once reached. No stepper, no next/back. Operator scrolls.
 */
import AppHeader from './components/AppHeader.vue';
import AppFooter from './components/AppFooter.vue';
import ConnectSection from './components/ConnectSection.vue';
import SectionCard from './components/SectionCard.vue';
import { isConnected } from './state/session';
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

    <SectionCard :step="2" title="Confirm what we see" :state="isConnected ? 'active' : 'pending'">
      <p>
        Once connected, we'll show you the model we detected and let you correct it if the guess is
        off.
      </p>
    </SectionCard>

    <SectionCard :step="3" title="Pick the loaded label" state="pending">
      <p>
        LW 3xx and 4xx don't auto-detect their roll, so this is mandatory. LW 5xx prefills from the
        NFC SKU on the roll.
      </p>
    </SectionCard>

    <SectionCard :step="4" title="Print the diagnostic" state="pending">
      <p>
        One comprehensive print (not a battery of seven). Header, edge probes, fill region,
        trailing-edge marker. Whatever comes out is what we ask you about next.
      </p>
    </SectionCard>

    <SectionCard :step="5" title="What does it look like?" state="pending">
      <p>
        Three radios — <em>verified</em>, <em>partial</em>, <em>unsupported</em> — and an optional
        one-liner if you want to add detail.
      </p>
    </SectionCard>

    <SectionCard :step="6" title="Submit the report" state="pending">
      <p>
        Opens a prefilled GitHub issue in a new tab. If GitHub is unreachable or the URL gets too
        long, we drop a copyable JSON payload here as a fallback.
      </p>
    </SectionCard>
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
