/**
 * Inside the Android app: when a newer app is published, a screen with one
 * button blocks the app until it is updated. The app downloads the APK,
 * checks its SHA-256, and Android asks to confirm the install.
 *
 * Only when the server can be reached: an ECG app used offline must never be
 * blocked by an update it cannot download.
 */
import { IN_APP, nativeInfo } from './platform.js';

const APK = '/download/ECGV.apk';

export function startAppUpdates() {
  if (!IN_APP) return;
  let latest = null, gate = null;
  const check = async () => {
    try {
      const r = await fetch(`/download/android.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) return;
      latest = await r.json();
      const me = nativeInfo() || {};
      if (me.code && me.code < (latest.min_code ?? latest.code)) show(me);
    } catch { /* offline: carry on */ }
  };
  function show(me) {
    if (gate) return;
    gate = document.createElement('div');
    gate.className = 'app-update-gate';
    gate.setAttribute('role', 'alertdialog');
    gate.innerHTML = `
      <div class="app-update-card">
        <img src="/icons/icon-192.png" alt="" width="72" height="72">
        <h2>Update ECGV</h2>
        <p>Version ${latest.version} is ready. Update now to keep the live stream and simulator working correctly. It takes a few seconds.</p>
        <div class="upd-bar hidden"><i></i></div>
        <p class="upd-msg"></p>
        <button class="btn btn-primary w-full upd-btn">Update now</button>
        <p class="upd-ver">Installed: ${me.version} . New: ${latest.version}</p>
      </div>`;
    document.body.appendChild(gate);
    document.documentElement.classList.add('update-required');
    const btn = gate.querySelector('.upd-btn'), msg = gate.querySelector('.upd-msg');
    const bar = gate.querySelector('.upd-bar'), fill = bar.querySelector('i');
    btn.onclick = () => {
      btn.disabled = true; btn.textContent = 'Updating...'; msg.textContent = 'Starting...';
      window.EcgvNative.installUpdate(location.origin + APK, latest.sha256 || '');
    };
    window.addEventListener('ecgv-update', (e) => {
      const d = e.detail || {};
      const busy = ['downloading', 'verifying', 'installing'].includes(d.state);
      bar.classList.toggle('hidden', d.state !== 'downloading');
      fill.style.width = `${Math.max(d.progress || 0, 3)}%`;
      msg.textContent = d.state === 'permission'
        ? 'On the next screen, turn on "Allow from this source", then come back. Only needed once.'
        : d.state === 'downloading' && d.progress >= 0 ? `${d.message} ${d.progress}%` : (d.message || '');
      btn.disabled = busy;
      btn.textContent = busy ? (d.state === 'installing' ? 'Confirm on the next screen' : 'Updating...') : 'Update now';
    });
  }
  check();
  setInterval(check, 30 * 60 * 1000);
  window.addEventListener('ecgv-native', check);   // fired when the app returns to the front
  window.addEventListener('online', check);
}
