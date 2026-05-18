/**
 * Capture the browser + OS the harness is running in, for the
 * `environment` block of a `HardwareReport` / `DiagnosticsSnapshot`.
 *
 * The harness is Chromium-only (Web USB / Web Bluetooth / Web Serial),
 * so the structured User-Agent Client Hints API
 * (`navigator.userAgentData`) is the primary source — it gives a clean
 * browser/OS split, and the async high-entropy call adds the OS
 * version + full browser version. Non-Chromium runtimes (jsdom /
 * happy-dom under test, the rare Firefox/Safari visitor) fall back to
 * parsing `navigator.userAgent`.
 *
 * Never rejects — every probe is guarded; a total failure still
 * resolves to a snapshot carrying at least the raw `userAgent`.
 */
import type { EnvironmentSnapshot } from '@thermal-label/harness-core/shared';

/** A `{ brand, version }` entry from the Client Hints brand list. */
interface UaBrand {
  brand: string;
  version: string;
}

/** Subset of the high-entropy values this module requests. */
interface HighEntropyValues {
  platform?: string;
  platformVersion?: string;
  fullVersionList?: UaBrand[];
}

/** Subset of `navigator.userAgentData` — not in the standard DOM lib. */
interface NavigatorUaData {
  brands?: UaBrand[];
  platform?: string;
  mobile?: boolean;
  getHighEntropyValues?: (hints: readonly string[]) => Promise<HighEntropyValues>;
}

/** GREASE brand entries (`"Not_A Brand"` and friends) carry no signal. */
function isGreaseBrand(brand: string): boolean {
  return /not.{0,3}a.{0,3}brand/i.test(brand);
}

/** Canonical browser family from a raw Client-Hints / UA brand string. */
function normalizeBrand(brand: string): string {
  if (/edge/i.test(brand)) return 'Edge';
  if (/opr|opera/i.test(brand)) return 'Opera';
  if (/firefox/i.test(brand)) return 'Firefox';
  if (/\bchrome\b|google chrome/i.test(brand)) return 'Chrome';
  if (/chromium/i.test(brand)) return 'Chromium';
  if (/safari/i.test(brand)) return 'Safari';
  return brand;
}

/**
 * Pick the most informative brand from a Client Hints brand list:
 * drop GREASE entries, then prefer a branded engine (Edge / Opera /
 * Firefox) over the generic Chrome / Chromium entry every Chromium
 * browser also advertises.
 */
function pickBrand(brands: readonly UaBrand[] | undefined): UaBrand | undefined {
  if (!brands || brands.length === 0) return undefined;
  const real = brands.filter(b => !isGreaseBrand(b.brand));
  const find = (re: RegExp): UaBrand | undefined => real.find(b => re.test(b.brand));
  return (
    find(/edge/i) ??
    find(/opr|opera/i) ??
    find(/firefox/i) ??
    find(/chrome|chromium/i) ??
    real[0] ??
    brands[0]
  );
}

/** Canonical OS name from a Client-Hints `platform` or a UA fragment. */
function normalizeOs(raw: string): string {
  if (/win/i.test(raw)) return 'Windows';
  if (/mac|darwin/i.test(raw)) return 'macOS';
  if (/cros|chrome\s?os/i.test(raw)) return 'ChromeOS';
  if (/android/i.test(raw)) return 'Android';
  if (/ios|iphone|ipad|ipod/i.test(raw)) return 'iOS';
  if (/linux|x11/i.test(raw)) return 'Linux';
  return raw || 'Unknown';
}

/**
 * Map a Windows Client-Hints `platformVersion` to the marketing
 * release. Chromium reports a kernel-ish version: a major ≥ 13 means
 * Windows 11, 1–12 means Windows 10, 0 means 8.1 or earlier.
 */
function windowsRelease(platformVersion: string): string {
  const major = Number.parseInt(platformVersion.split('.')[0] ?? '', 10);
  if (Number.isNaN(major)) return platformVersion;
  if (major >= 13) return '11';
  if (major >= 1) return '10';
  return '8.1 or earlier';
}

/**
 * Fallback environment parse from a raw UA string — used in
 * non-Chromium runtimes that lack `navigator.userAgentData`. OS
 * version is intentionally not parsed: Chromium (the only target that
 * matters) always reaches the Client Hints path, so UA-string version
 * heuristics buy nothing.
 */
function parseUserAgent(userAgent: string): EnvironmentSnapshot {
  const browser = matchBrowser(userAgent);
  return {
    runtime: 'browser',
    browser: browser.name,
    ...(browser.version ? { browserVersion: browser.version } : {}),
    os: matchOs(userAgent),
    mobile: /Mobi/i.test(userAgent),
    userAgent,
  };
}

function matchBrowser(ua: string): { name: string; version?: string } {
  const patterns: readonly (readonly [string, RegExp])[] = [
    ['Edge', /Edg(?:e|A|iOS)?\/([\d.]+)/],
    ['Opera', /OPR\/([\d.]+)/],
    ['Firefox', /Firefox\/([\d.]+)/],
    ['Chrome', /Chrome\/([\d.]+)/],
    ['Safari', /Version\/([\d.]+)\s.*Safari/],
  ];
  for (const [name, re] of patterns) {
    const matched = re.exec(ua);
    if (matched) {
      const version = matched[1];
      return version ? { name, version } : { name };
    }
  }
  return { name: 'Unknown' };
}

function matchOs(ua: string): string {
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS';
  if (/CrOS/i.test(ua)) return 'ChromeOS';
  if (/Android/i.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Linux|X11/i.test(ua)) return 'Linux';
  return 'Unknown';
}

/**
 * Capture the environment. Resolves to an {@link EnvironmentSnapshot};
 * never rejects.
 */
export async function captureEnvironment(): Promise<EnvironmentSnapshot> {
  const nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator;
  const userAgent = nav?.userAgent ?? '';
  const uaData = (nav as (Navigator & { userAgentData?: NavigatorUaData }) | undefined)
    ?.userAgentData;

  if (!uaData) return parseUserAgent(userAgent);

  // Low-entropy values are synchronous and always present on Chromium
  // — a usable snapshot on their own.
  const lowBrand = pickBrand(uaData.brands);
  let browser = lowBrand ? normalizeBrand(lowBrand.brand) : 'Unknown';
  let browserVersion = lowBrand?.version;
  let os = normalizeOs(uaData.platform ?? '');
  let osVersion: string | undefined;
  const mobile = uaData.mobile;

  // High-entropy values (OS version, full browser version) need an
  // async opt-in call that a permissions policy can reject. The
  // low-entropy snapshot above stands in if it does.
  try {
    const high = await uaData.getHighEntropyValues?.([
      'platform',
      'platformVersion',
      'fullVersionList',
    ]);
    if (high) {
      if (high.platform) os = normalizeOs(high.platform);
      const fullBrand = pickBrand(high.fullVersionList);
      if (fullBrand) {
        browser = normalizeBrand(fullBrand.brand);
        browserVersion = fullBrand.version;
      }
      if (high.platformVersion) {
        osVersion = os === 'Windows' ? windowsRelease(high.platformVersion) : high.platformVersion;
      }
    }
  } catch {
    // High-entropy is best-effort — keep the low-entropy snapshot.
  }

  return {
    runtime: 'browser',
    browser,
    ...(browserVersion ? { browserVersion } : {}),
    os,
    ...(osVersion ? { osVersion } : {}),
    ...(mobile === undefined ? {} : { mobile }),
    userAgent,
  };
}
