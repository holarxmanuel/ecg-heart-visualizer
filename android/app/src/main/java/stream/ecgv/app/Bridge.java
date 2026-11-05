package stream.ecgv.app;

import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

// window.EcgvNative in the interface.
public class Bridge {
    private final MainActivity a;
    Bridge(MainActivity a) { this.a = a; }

    @JavascriptInterface public String info() {
        try {
            return new JSONObject().put("app", true).put("version", BuildConfig.VERSION_NAME).put("code", BuildConfig.VERSION_CODE).toString();
        } catch (Exception e) { return "{\"app\":true}"; }
    }

    @JavascriptInterface public void installUpdate(String url, String sha256) { Updater.start(a, url, sha256); }

    // CSV recordings into the phone's Downloads folder.
    @JavascriptInterface public boolean saveFile(String name, String mime, String base64) {
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                v.put(MediaStore.Downloads.MIME_TYPE, mime);
                Uri uri = a.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                try (OutputStream o = a.getContentResolver().openOutputStream(uri)) { o.write(bytes); }
            } else {
                File f = new File(a.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), name);
                try (FileOutputStream o = new FileOutputStream(f)) { o.write(bytes); }
            }
            a.runOnUiThread(() -> Toast.makeText(a, "Saved to Downloads: " + name, Toast.LENGTH_LONG).show());
            return true;
        } catch (Exception e) {
            a.runOnUiThread(() -> Toast.makeText(a, "Could not save the recording.", Toast.LENGTH_LONG).show());
            return false;
        }
    }
}
