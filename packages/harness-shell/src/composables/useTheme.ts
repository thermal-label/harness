/**
 * Light/dark theme toggle with localStorage persistence.
 *
 * Default: light. Per plan-06's UX call (most testers in normal-light
 * conditions). The toggle is a single sun/moon icon button in the
 * header — no theme menu, no auto-from-system.
 *
 * The driverKey is mixed into the storage key so different harness
 * apps don't trample each other's theme preference (the user might
 * prefer dark on labelmanager and light on labelwriter, weird as that
 * is).
 */
import { onMounted, ref, watch, type Ref } from 'vue';
import { useAdapter } from '../state/adapterContext';

export type Theme = 'light' | 'dark';

function readStored(key: string): Theme {
  if (typeof localStorage === 'undefined') return 'light';
  const v = localStorage.getItem(key);
  return v === 'dark' ? 'dark' : 'light';
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
}

export function useTheme(): {
  theme: Ref<Theme>;
  toggleTheme: () => void;
} {
  const adapter = useAdapter();
  const storageKey = `harness-${adapter.driverKey}:theme`;
  const theme: Ref<Theme> = ref<Theme>(readStored(storageKey));

  onMounted(() => {
    applyTheme(theme.value);
  });

  watch(theme, value => {
    applyTheme(value);
    try {
      localStorage.setItem(storageKey, value);
    } catch {
      // Private mode / quota — UI works fine without persistence.
    }
  });

  function toggleTheme(): void {
    theme.value = theme.value === 'dark' ? 'light' : 'dark';
  }

  return { theme, toggleTheme };
}
