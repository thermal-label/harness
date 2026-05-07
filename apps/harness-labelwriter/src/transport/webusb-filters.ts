/**
 * WebUSB device filters built from the labelwriter-core registry.
 *
 * Browser USB pickers honour `filters[]` — we expose every registered
 * vid/pid pair so the picker only surfaces actual LabelWriter
 * hardware. All Dymo LabelWriters share VID 0x0922; we still emit
 * per-PID entries so a user with multiple Dymo product families
 * (e.g. LabelManager 280) only sees the labelwriter ones.
 */
import { DEVICES, type LabelWriterDevice } from '@thermal-label/labelwriter-core';

export function buildLabelwriterUsbFilters(): readonly USBDeviceFilter[] {
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
 * Find a `LabelWriterDevice` registry entry whose USB transport
 * matches the given vid/pid pair. The browser surfaces vid/pid as
 * decimal numbers on `USBDevice`; the registry stores them as hex
 * strings, so we parse-and-compare.
 *
 * Returns the FIRST matching entry — multiple devices can share a
 * (vid, pid) pair on Dymo's lineup (e.g. Wireless / 4xx use
 * overlapping ids depending on the firmware). The user confirms /
 * overrides in the identity panel.
 */
export function findDeviceByVidPid(vid: number, pid: number): LabelWriterDevice | undefined {
  for (const device of Object.values(DEVICES)) {
    const usb = device.transports.usb;
    if (!usb) continue;
    if (parseInt(usb.vid, 16) === vid && parseInt(usb.pid, 16) === pid) {
      return device;
    }
  }
  return undefined;
}
