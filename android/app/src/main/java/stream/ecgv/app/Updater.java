package stream.ecgv.app;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

// In-app update: download the new APK, check it is exactly the file the server
// published (SHA-256), and hand it to Android's installer, which shows its own
// "Update this app?" confirmation. Android never lets an app install silently;
// the first time, it also asks the person to allow ECGV to install
// updates, after which the update carries on by itself.
final class Updater {
    private static volatile boolean busy = false;
    private static volatile String waitingUrl, waitingSha;

    static void start(MainActivity a, String url, String sha256) {
        if (busy) return;
        if (Build.VERSION.SDK_INT >= 26 && !a.getPackageManager().canRequestPackageInstalls()) {
            waitingUrl = url; waitingSha = sha256;
            a.updateEvent("permission", 0, "Allow ECGV to install updates, then come back.");
            a.runOnUiThread(() -> a.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + a.getPackageName()))));
            return;
        }
        busy = true;
        new Thread(() -> run(a, url, sha256), "ruckus-update").start();
    }

    // Back from the settings screen: carry on if the permission was given.
    static void resumeIfWaiting(MainActivity a) {
        if (waitingUrl == null) return;
        if (Build.VERSION.SDK_INT >= 26 && !a.getPackageManager().canRequestPackageInstalls()) {
            a.updateEvent("permission-denied", 0, "ECGV is not allowed to install updates yet.");
            return;
        }
        String u = waitingUrl, s = waitingSha;
        waitingUrl = null; waitingSha = null;
        start(a, u, s);
    }

    private static void run(MainActivity a, String url, String sha256) {
        File f = new File(a.getCacheDir(), "update.apk");
        try {
            a.updateEvent("downloading", 0, "Downloading the update...");
            HttpURLConnection h = (HttpURLConnection) new URL(url).openConnection();
            h.setConnectTimeout(20000); h.setReadTimeout(30000);
            h.setRequestProperty("Cache-Control", "no-cache");
            if (h.getResponseCode() != 200) throw new Exception("download failed (" + h.getResponseCode() + ")");
            long total = h.getContentLengthLong(), done = 0;
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            int last = -1;
            try (InputStream in = h.getInputStream(); OutputStream out = new FileOutputStream(f)) {
                byte[] buf = new byte[64 * 1024]; int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n); md.update(buf, 0, n); done += n;
                    int pct = total > 0 ? (int) (done * 100 / total) : -1;
                    if (pct != last) { last = pct; a.updateEvent("downloading", pct, "Downloading the update..."); }
                }
            }
            a.updateEvent("verifying", 100, "Checking the update...");
            StringBuilder hex = new StringBuilder();
            for (byte b : md.digest()) hex.append(String.format("%02x", b));
            if (sha256 != null && !sha256.isEmpty() && !hex.toString().equalsIgnoreCase(sha256)) throw new Exception("the download was damaged, please try again");

            a.updateEvent("installing", 100, "Confirm the update on the next screen.");
            PackageInstaller pi = a.getPackageManager().getPackageInstaller();
            PackageInstaller.SessionParams p = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            p.setAppPackageName(a.getPackageName());
            if (Build.VERSION.SDK_INT >= 31) p.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
            int id = pi.createSession(p);
            try (PackageInstaller.Session s = pi.openSession(id)) {
                try (InputStream in = new FileInputStream(f); OutputStream out = s.openWrite("base.apk", 0, f.length())) {
                    byte[] buf = new byte[64 * 1024]; int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                    s.fsync(out);
                }
                Intent done2 = new Intent(a, InstallReceiver.class);
                int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                s.commit(PendingIntent.getBroadcast(a, id, done2, flags).getIntentSender());
            }
        } catch (Exception e) {
            a.updateEvent("error", 0, "Could not update: " + e.getMessage());
        } finally {
            busy = false;
        }
    }
}
