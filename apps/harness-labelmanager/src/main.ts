import { createHarness } from '@thermal-label/harness-shell';
import '@thermal-label/harness-shell/styles';
import { adapter } from './adapter';

createHarness('#app', adapter);
