package com.example.launcherprobe;

import android.content.ComponentName;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.drawable.Drawable;
import android.view.View;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.Map;

/** First-page preview from the validated snapshot, without binding any live widgets. */
final class DesktopBackupPreview extends View {
    private final JSONObject layout, settings;
    private final Map<String, Drawable> icons;
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final long createdAt;
    private final int columns, rows;

    DesktopBackupPreview(Context context, JSONObject snapshot, Map<String, Drawable> icons) {
        super(context);
        layout = snapshot.optJSONObject("layout"); settings = snapshot.optJSONObject("settings");
        createdAt = snapshot.optLong("createdAt"); this.icons = icons;
        columns = layout.optInt("columns", 4); rows = layout.optInt("rows", 8);
        JSONArray slots = layout.optJSONArray("slots");
        for (int i = 0; i < Math.min(slots.length(), columns * rows); i++) loadIcon(slots.optJSONObject(i));
        JSONArray dock = layout.optJSONArray("dock");
        for (int i = 0; i < dock.length(); i++) loadIcon(dock.optJSONObject(i));
        setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
    }
    private String key(JSONObject item) { return item.optString("package") + "/" + item.optString("class"); }
    private void loadIcon(JSONObject item) {
        if (item == null) return;
        if ("folder".equals(item.optString("type"))) {
            JSONArray children = item.optJSONArray("children");
            for (int i = 0; i < Math.min(4, children.length()); i++) loadIcon(children.optJSONObject(i));
        } else if ("app".equals(item.optString("type")) || "shortcut".equals(item.optString("type"))) {
            String key = key(item);
            if (!icons.containsKey(key)) {
                try {
                    icons.put(key, item.has("class")
                            ? getContext().getPackageManager().getActivityIcon(new ComponentName(item.optString("package"), item.optString("class")))
                            : getContext().getPackageManager().getApplicationIcon(item.optString("package")));
                } catch (android.content.pm.PackageManager.NameNotFoundException e) {
                    icons.put(key, getContext().getPackageManager().getDefaultActivityIcon());
                }
            }
        }
    }
    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        String theme = settings.optString("theme");
        boolean dark = "dark".equals(theme) || "system".equals(theme)
                && (getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
                == android.content.res.Configuration.UI_MODE_NIGHT_YES;
        boolean systemWallpaper = "system".equals(settings.optString("wallpaper"));
        float width = getWidth(), height = getHeight();
        paint.setShader(new LinearGradient(0, 0, width * .6f, height,
                dark ? 0xff1b3948 : systemWallpaper ? 0xffdce6e9 : 0xffdcf6f9,
                dark ? 0xff102630 : systemWallpaper ? 0xffa6b7c0 : 0xff76c7d2, Shader.TileMode.CLAMP));
        canvas.drawRect(0, 0, width, height, paint); paint.setShader(null);
        float inset = width * .055f, top = height * .065f;
        boolean showDock = settings.optBoolean("dockVisible", true);
        float dockHeight = showDock ? height * .11f : 0;
        float cellWidth = (width - inset * 2) / columns;
        float cellHeight = (height - top - dockHeight - inset * 2) / rows;
        JSONArray slots = layout.optJSONArray("slots");
        for (int i = 0; i < Math.min(slots.length(), columns * rows); i++) {
            JSONObject item = slots.optJSONObject(i); if (item == null) continue;
            float x = inset + i % columns * cellWidth, y = top + i / columns * cellHeight;
            drawItem(canvas, item, new RectF(x + 2, y + 2,
                    x + cellWidth * item.optInt("spanX", 1) - 2, y + cellHeight * item.optInt("spanY", 1) - 2));
        }
        if (showDock) {
            RectF tray = new RectF(inset, height - dockHeight - inset, width - inset, height - inset);
            paint.setColor(0x88ffffff); canvas.drawRoundRect(tray, inset * 2, inset * 2, paint);
            JSONArray dock = layout.optJSONArray("dock"); float dockCell = tray.width() / dock.length();
            for (int i = 0; i < dock.length(); i++) {
                JSONObject item = dock.optJSONObject(i); if (item == null) continue;
                drawItem(canvas, item, new RectF(tray.left + i * dockCell + 2, tray.top + 3, tray.left + (i + 1) * dockCell - 2, tray.bottom - 3));
            }
        }
    }
    private void drawItem(Canvas canvas, JSONObject item, RectF bounds) {
        String type = item.optString("type");
        if ("clock".equals(type) || "appwidget".equals(type) || "ai_widget".equals(type) || "widget_picker".equals(type)) {
            paint.setColor(0xbbffffff); canvas.drawRoundRect(bounds, 7, 7, paint);
            if ("clock".equals(type)) {
                paint.setColor(0xff315563); paint.setTextSize(Math.min(bounds.height() * .58f, bounds.width() * .18f));
                canvas.drawText(android.text.format.DateFormat.format("HH:mm", createdAt).toString(), bounds.left + bounds.width() * .08f,
                        bounds.centerY() - (paint.ascent() + paint.descent()) / 2, paint);
            } else {
                String symbol = "ai_widget".equals(type) ? "sparkles" : "widget_picker".equals(type) ? "plus" : "grid";
                drawIcon(canvas, new ChatIcon(symbol, 0xff1695a9), bounds, .42f);
            }
        } else if ("folder".equals(type)) {
            float side = Math.min(bounds.width(), bounds.height()) * .85f;
            RectF folder = new RectF(bounds.centerX() - side / 2, bounds.centerY() - side / 2, bounds.centerX() + side / 2, bounds.centerY() + side / 2);
            paint.setColor(0xaaffffff); canvas.drawRoundRect(folder, 5, 5, paint);
            JSONArray children = item.optJSONArray("children");
            for (int i = 0; i < Math.min(4, children.length()); i++) {
                float x = folder.left + i % 2 * side / 2, y = folder.top + i / 2 * side / 2;
                drawItem(canvas, children.optJSONObject(i), new RectF(x, y, x + side / 2, y + side / 2));
            }
        } else if ("assistant".equals(type)) drawIcon(canvas, new ChatIcon("sparkles", 0xff0099ad), bounds, .8f);
        else drawIcon(canvas, icons.get(key(item)), bounds, .85f);
    }
    private void drawIcon(Canvas canvas, Drawable icon, RectF bounds, float scale) {
        if (icon == null) return;
        float side = Math.min(bounds.width(), bounds.height()) * scale;
        icon.setBounds(Math.round(bounds.centerX() - side / 2), Math.round(bounds.centerY() - side / 2),
                Math.round(bounds.centerX() + side / 2), Math.round(bounds.centerY() + side / 2)); icon.draw(canvas);
    }
}
