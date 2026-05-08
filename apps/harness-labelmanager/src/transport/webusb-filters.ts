/**
 * WebUSB device filters built from the labelmanager-core registry.
 *
 * Browser USB pickers honour `filters[]` — we expose every registered
 * vid/pid pair so the picker only surfaces actual LabelManager
 * hardware. All Dymo printers share VID 0x0922; per-PID entries
 * narrow the picker to just labelmanager units, so a user with a
 * sibling LabelWriter plugged in alongside doesn't see it offered.
 */
import { DEVICES, type LabelManagerDevice } from '@thermal-label/labelmanager-core';

export function buildLabelmanagerUsbFilters(): readonly USBDeviceFilter[] {
  const seen = new Set<string>();
  const filters: USBDeviceFilter[] = [];
  for (const device of Object.values(DEVICES)) {
    const usb = device.transports.usb;
    if (!usb) continue;
    const vid = parseInt(usb.vid, 16);
    const pid = parseInt(usb.pid, 16);
    const key = `${String(vid)}:${String(pid)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    filters.push({ vendorId: vid, productId: pid });
  }
  return filters;
}

/**
 * Find a `LabelManagerDevice` registry entry whose USB transport
 * matches the given vid/pid pair. The browser surfaces vid/pid as
 * decimal numbers on `USBDevice`; the registry stores them as hex
 * strings, so we parse-and-compare.
 *
 * Returns the FIRST matching entry — labelmanager PIDs are mostly
 * unique today (one mass-storage decoy collision for LM_280 / LP_350
 * is documented in the registry's `hardwareQuirks`). The user
 * confirms / overrides in the identity panel.
 */
export function findDeviceByVidPid(vid: number, pid: number): LabelManagerDevice | undefined {
  for (const device of Object.values(DEVICES)) {
    const usb = device.transports.usb;
    if (!usb) continue;
    if (parseInt(usb.vid, 16) === vid && parseInt(usb.pid, 16) === pid) {
      return device;
    }
  }
  return undefined;
}
