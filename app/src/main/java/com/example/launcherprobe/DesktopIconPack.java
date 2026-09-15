package com.example.launcherprobe;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.content.res.Resources;
import android.graphics.drawable.Drawable;
import org.xmlpull.v1.XmlPullParser;
import android.util.Xml;
import java.io.InputStream;
import java.util.LinkedHashMap;
import java.util.Map;

/** Standard appfilter icon packs; missing mappings always retain the real application icon. */
public final class DesktopIconPack {
    public static Map<String, String> installed(Context context) {
        Map<String, String> result = new LinkedHashMap<>();
        for (String action : new String[]{"org.adw.launcher.THEMES", "com.gau.go.launcherex.theme", "com.novalauncher.THEME"}) {
            for (ResolveInfo info : context.getPackageManager().queryIntentActivities(new Intent(action), 0))
                result.put(info.activityInfo.packageName, info.loadLabel(context.getPackageManager()).toString());
        }
        return result;
    }
    private final Map<String, String> icons = new LinkedHashMap<>();
    private Resources resources;
    private final String packageName;
    public DesktopIconPack(Context context) {
        packageName = new DesktopPreferences(context).iconPack();
        if (packageName.isEmpty()) return;
        try {
            resources = context.getPackageManager().getResourcesForApplication(packageName);
            int xml = resources.getIdentifier("appfilter", "xml", packageName);
            if (xml != 0) {
                try (android.content.res.XmlResourceParser parser = resources.getXml(xml)) { read(parser); }
            } else {
                try (InputStream input = resources.getAssets().open("appfilter.xml")) {
                    XmlPullParser parser = Xml.newPullParser(); parser.setInput(input, "UTF-8"); read(parser);
                }
            }
        } catch (Exception ignored) { icons.clear(); resources = null; }
    }
    private void read(XmlPullParser parser) throws Exception {
        int count = 0;
        for (int event = parser.getEventType(); event != XmlPullParser.END_DOCUMENT; event = parser.next()) {
            if (++count > 200000) throw new java.io.IOException("Icon pack too large");
            if (event == XmlPullParser.START_TAG && "item".equals(parser.getName())) {
                String component = parser.getAttributeValue(null, "component");
                String drawable = parser.getAttributeValue(null, "drawable");
                if (component != null && drawable != null) icons.put(component, drawable);
            }
        }
    }
    public Drawable icon(ComponentName component, Drawable fallback) {
        if (resources == null) return fallback;
        String name = icons.get("ComponentInfo{" + component.flattenToString() + "}");
        if (name == null) name = icons.get("ComponentInfo{" + component.flattenToShortString() + "}");
        if (name == null) return fallback;
        try {
            int id = resources.getIdentifier(name, "drawable", packageName);
            return id == 0 ? fallback : resources.getDrawable(id, null);
        } catch (Resources.NotFoundException | SecurityException ignored) { return fallback; }
    }
}
