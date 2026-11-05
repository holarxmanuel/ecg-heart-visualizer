package stream.ecgv.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

// Android's installer reports back here: show its confirmation screen, or
// tell the update screen what went wrong.
public class InstallReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context c, Intent i) {
        int status = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        MainActivity a = MainActivity.current.get();
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = i.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) {
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try { c.startActivity(confirm); } catch (Exception e) {
                    if (a != null) a.updateEvent("error", 0, "Could not open the installer.");
                }
            }
            return;
        }
        if (status == PackageInstaller.STATUS_SUCCESS) return;   // the app restarts as the new version
        if (a != null) {
            String msg = i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
            a.updateEvent(status == PackageInstaller.STATUS_FAILURE_ABORTED ? "cancelled" : "error", 0,
                status == PackageInstaller.STATUS_FAILURE_ABORTED ? "The update was cancelled." : "Could not update" + (msg != null ? ": " + msg : "."));
        }
    }
}
