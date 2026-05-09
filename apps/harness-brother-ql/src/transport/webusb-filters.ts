/**
 * WebUSB device filters built from the brother-ql-core registry.
 *
 * Browser USB pickers honour `filters[]` — we expose every registered
 * vid/pid pair so the picker only surfaces actual Brother QL / PT
 * hardware. All Brother label printers in this driver share VID
 * 0x04f9; per-PID entries narrow the picker to just brother-ql units
 * so a user with a sibling LabelManager / LabelWriter plugged in
 * alongside doesn't see those offered.
 *
 * Mass-storage decoy PIDs (Editor Lite mode on QL-700, QL-1100,
 * QL-1110NWB, QL-1115NWB, PT-P750W) are intentionally excluded — the
 * harness can't drive a printer in mass-storage mode, and surfacing
 * those PIDs would just confuse the picker. The user must hold the
 * Editor Lite button to switch the device into printer-class mode
 * before the picker matches it.
 */
import { DEVICES, isMassStorageMode, type BrotherQLDevice } from '@thermal-label/brother-ql-core';

export function buildBrotherQlUsbFilters(): readonly USBDeviceFilter[] {
  const seen = new Set<string>();
  const filters: USBDeviceFilter[] = [];
  for (const device of Object.values(DEVICES)) {
    const usb = device.transports.usb;
    if (!usb) continue;
    const vid = parseInt(usb.vid, 16);
    const pid = parseInt(usb.pid, 16);
    // Don't surface the mass-storage decoy PID — the printer must be
    // held in printer-class mode before the harness can drive it.
    if (isMassStorageMode(pid)) continue;
    const key = `${String(vid)}:${String(pid)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    filters.push({ vendorId: vid, productId: pid });
  }
  return filters;
}

/**
 * Find a `BrotherQLDevice` registry entry whose USB transport matches
 * the given vid/pid pair. The browser surfaces vid/pid as decimal
 * numbers on `USBDevice`; the registry stores them as hex strings, so
 * we parse-and-compare.
 *
 * Returns the FIRST matching entry. The user confirms / overrides in
 * the identity panel if the auto-guess is wrong.
 */
export function findDeviceByVidPid(vid: number, pid: number): BrotherQLDevice | undefined {
  for (const device of Object.values(DEVICES)) {
    const usb = device.transports.usb;
    if (!usb) continue;
    if (parseInt(usb.vid, 16) === vid && parseInt(usb.pid, 16) === pid) {
      return device;
    }
  }
  return undefined;
}
