<script setup lang="ts">
/**
 * Shown in place of the Connect section when the current browser
 * lacks a required Web API (today: WebUSB). Capability-based — no
 * user-agent sniffing — so a future Firefox build that ships WebUSB
 * unlocks the harness automatically.
 *
 * Always points to mock mode as a "you can still see the flow" path,
 * because the maintainer self-walks from whatever browser is open.
 */
import { CAPABILITIES, summariseMissing } from '../composables/useCapabilities';

const summary = summariseMissing();
const mockUrl = (() => {
  if (typeof window === 'undefined') return '?mock=1';
  const url = new URL(window.location.href);
  url.searchParams.set('mock', '1');
  return url.toString();
})();
</script>

<template>
  <div class="unsupported">
    <h2>This browser can't connect to the printer</h2>
    <p>
      The harness needs <strong>{{ summary }}</strong> to talk to a USB-connected labelwriter. Your
      current browser doesn't expose it, so the connect button would just fail.
    </p>

    <p>You have a few options:</p>
    <ul>
      <li>
        <strong>Switch to a browser that supports WebUSB</strong> — Chrome, Edge, Brave, Opera,
        Vivaldi, and Arc all do today. (Firefox is working on it but isn't shipping yet.)
      </li>
      <li>
        <strong>Use the CLI version</strong> — clone the harness repo and run
        <code>pnpm --filter verify-cli verify labelwriter &lt;model&gt;</code> from a terminal. No
        browser needed.
      </li>
      <li>
        <strong>Self-walk in mock mode</strong> — no hardware, no WebUSB, just the UI flow:
        <a :href="mockUrl">{{ mockUrl }}</a>
      </li>
    </ul>

    <details class="diag">
      <summary>What we detected</summary>
      <table>
        <tbody>
          <tr>
            <td><code>navigator.usb</code></td>
            <td>{{ CAPABILITIES.webusb ? 'available' : 'missing' }}</td>
          </tr>
          <tr>
            <td><code>navigator.serial</code></td>
            <td>{{ CAPABILITIES.webserial ? 'available' : 'missing' }}</td>
          </tr>
          <tr>
            <td><code>navigator.bluetooth</code></td>
            <td>{{ CAPABILITIES.webbluetooth ? 'available' : 'missing' }}</td>
          </tr>
        </tbody>
      </table>
    </details>
  </div>
</template>

<style scoped>
.unsupported {
  background: var(--bg-elevated, var(--bg));
  border: 1px solid var(--border);
  border-left: 4px solid var(--accent);
  border-radius: var(--radius-sm);
  padding: var(--space-5);
}

.unsupported h2 {
  margin: 0 0 var(--space-3);
  font-size: 1.15rem;
}

.unsupported p {
  margin: 0 0 var(--space-3);
  line-height: 1.5;
}

.unsupported ul {
  margin: 0 0 var(--space-3);
  padding-left: var(--space-5);
  line-height: 1.6;
}

.unsupported li + li {
  margin-top: var(--space-2);
}

.unsupported code {
  background: var(--code-bg, rgba(0, 0, 0, 0.06));
  padding: 0.05rem 0.35rem;
  border-radius: 0.2rem;
  font-size: 0.9em;
}

.unsupported a {
  word-break: break-all;
}

.diag {
  margin-top: var(--space-4);
  font-size: 0.9rem;
}

.diag summary {
  cursor: pointer;
  color: var(--muted);
}

.diag table {
  margin-top: var(--space-2);
  border-collapse: collapse;
}

.diag td {
  padding: 0.15rem 0.7rem 0.15rem 0;
  font-size: 0.85rem;
}

.diag td:first-child {
  color: var(--muted);
}
</style>
