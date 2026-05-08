/**
 * Light/dark theme toggle with localStorage persistence.
 *
 * Default: light. Per plan 06's UX call (most testers in normal-light
 * conditions). The toggle is a single sun/moon icon button in the
 * header — no theme menu, no auto-from-system.
 */
import { onMounted, ref, watch, type Ref } from 'vue';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'harness-labelmanager:theme';

function readStored(): Theme {
  if (typeof localStorage === 'undefined') return 'light';
  const v = localStorage.getItem(STORAGE_KEY);
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
  const theme: Ref<Theme> = ref<Theme>(readStored());

  onMounted(() => {
    applyTheme(theme.value);
  });

  watch(theme, value => {
    applyTheme(value);
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // Private mode / quota — UI works fine without persistence.
    }
  });

  function toggleTheme(): void {
    theme.value = theme.value === 'dark' ? 'light' : 'dark';
  }

  return { theme, toggleTheme };
}
