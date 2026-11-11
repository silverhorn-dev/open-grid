package org.opengrid.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

// Nach einem Neustart des Handys: Posteingang wieder starten (Einstellung "Im Hintergrund erreichbar").
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) InboxService.start(context)
    }
}
