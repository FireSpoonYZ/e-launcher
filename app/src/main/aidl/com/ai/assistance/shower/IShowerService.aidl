package com.ai.assistance.shower;

import android.os.ParcelFileDescriptor;
import com.ai.assistance.shower.IShowerClient;
import com.ai.assistance.shower.IShowerGesture;

interface IShowerService {
    int ensureDisplay(int width, int height, int dpi, int bitrateKbps);
    boolean attachClient(int displayId, IShowerClient client);
    boolean touchDisplay(int displayId);
    boolean destroyDisplay(int displayId);
    boolean launchApp(String packageName, int displayId);
    boolean tap(int displayId, float x, float y);
    boolean swipe(int displayId, float x1, float y1, float x2, float y2, long durationMs, IShowerGesture gesture);
    boolean injectKeyWithMeta(int displayId, int keyCode, int metaState);
    ParcelFileDescriptor requestScreenshot(int displayId, int maxWidth, int maxHeight);
}
