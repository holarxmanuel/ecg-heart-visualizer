/**
 * Running inside the ECGV Android app (window.EcgvNative is its bridge).
 *
 * The app is a separate product from the laptop app: it carries this whole
 * interface inside the APK, so it opens and simulates with no network at all,
 * and it has no USB port to read an AD8232 from. Inside it:
 *   - Online / Offline is a free choice, as in an installed app
 *   - the USB sensor and "Get the App" controls are hidden
 *   - the browser updater and service worker are not used: the app updates
 *     itself as a whole (see app-update.js)
 *   - CSV recordings are saved to the phone's Downloads
 * In a browser nothing here changes anything.
 */
export const IN_APP = typeof window !== 'undefined' && !!window.EcgvNative;

if (IN_APP) document.documentElement.classList.add('in-app');

export function nativeInfo() {
  try { return JSON.parse(window.EcgvNative.info()); } catch { return null; }
}

/** Save a text file to the phone's Downloads. Returns false outside the app. */
export function saveTextFile(name, mime, text) {
  if (!IN_APP) return false;
  const b64 = btoa(unescape(encodeURIComponent(text)));
  return window.EcgvNative.saveFile(name, mime, b64);
}

// On the website, visitors on Android phones are offered the phone app.
if (!IN_APP && typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)) {
  const show = () => document.getElementById('android-app-bar')?.classList.remove('hidden');
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show); else show();
}
