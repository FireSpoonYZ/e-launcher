package com.example.launcherprobe;

import android.hardware.display.DisplayManager;
import android.util.DisplayMetrics;
import android.view.Display;
import android.view.KeyEvent;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** Routes each native tool call to the display owned by its host-authenticated conversation. */
final class ShowerToolBridge {
    private static final Map<String, Integer> KEYS = Map.ofEntries(
            Map.entry("BACK", KeyEvent.KEYCODE_BACK),
            Map.entry("HOME", KeyEvent.KEYCODE_HOME),
            Map.entry("ENTER", KeyEvent.KEYCODE_ENTER),
            Map.entry("TAB", KeyEvent.KEYCODE_TAB),
            Map.entry("ESCAPE", KeyEvent.KEYCODE_ESCAPE),
            Map.entry("SPACE", KeyEvent.KEYCODE_SPACE),
            Map.entry("DEL", KeyEvent.KEYCODE_DEL),
            Map.entry("A", KeyEvent.KEYCODE_A),
            Map.entry("COPY", KeyEvent.KEYCODE_COPY),
            Map.entry("CUT", KeyEvent.KEYCODE_CUT),
            Map.entry("PASTE", KeyEvent.KEYCODE_PASTE),
            Map.entry("FORWARD_DEL", KeyEvent.KEYCODE_FORWARD_DEL),
            Map.entry("DPAD_UP", KeyEvent.KEYCODE_DPAD_UP),
            Map.entry("DPAD_DOWN", KeyEvent.KEYCODE_DPAD_DOWN),
            Map.entry("DPAD_LEFT", KeyEvent.KEYCODE_DPAD_LEFT),
            Map.entry("DPAD_RIGHT", KeyEvent.KEYCODE_DPAD_RIGHT),
            Map.entry("DPAD_CENTER", KeyEvent.KEYCODE_DPAD_CENTER),
            Map.entry("PAGE_UP", KeyEvent.KEYCODE_PAGE_UP),
            Map.entry("PAGE_DOWN", KeyEvent.KEYCODE_PAGE_DOWN),
            Map.entry("MOVE_HOME", KeyEvent.KEYCODE_MOVE_HOME),
            Map.entry("MOVE_END", KeyEvent.KEYCODE_MOVE_END)
    );
    private final android.content.Context context;
    private final ShowerManager manager;
    private final Map<String, ShowerController> controllers = new ConcurrentHashMap<>();

    ShowerToolBridge(android.content.Context context) {
        this.context = context.getApplicationContext();
        manager = new ShowerManager(this.context);
    }

    JSONObject execute(String conversationId, JSONObject arguments) throws Exception {
        if (conversationId == null || conversationId.isBlank()) {
            throw new IllegalArgumentException("Shower 操作必须属于一个聊天");
        }
        if (arguments == null) throw new IllegalArgumentException("缺少 Shower 工具参数");
        ShowerController controller = controllers.computeIfAbsent(conversationId,
                ignored -> new ShowerController(context, manager));
        String action = arguments.optString("action", "");
        return switch (action) {
            case "create" -> create(controller, arguments);
            case "launch" -> controller.launch(requiredString(arguments, "packageName", 255));
            case "screenshot" -> controller.screenshot(integer(arguments, "maxWidth", 720),
                    integer(arguments, "maxHeight", 1280));
            case "tap" -> controller.tap(integer(arguments, "x"), integer(arguments, "y"));
            case "swipe" -> controller.swipe(integer(arguments, "x1"), integer(arguments, "y1"),
                    integer(arguments, "x2"), integer(arguments, "y2"),
                    integer(arguments, "durationMs", 300));
            case "key" -> key(controller, arguments);
            case "text" -> controller.text(requiredString(arguments, "text", 1000, true));
            case "copy" -> controller.copy(requiredString(arguments, "text", 1000));
            case "paste" -> controller.paste();
            case "clear" -> controller.text("").put("action", "clear");
            case "release" -> controller.release();
            default -> throw new IllegalArgumentException("未知 Shower action：" + action);
        };
    }

    @SuppressWarnings("deprecation") // Real metrics are the default display's full, current logical size.
    private JSONObject create(ShowerController controller, JSONObject arguments) throws Exception {
        DisplayManager displays = context.getSystemService(DisplayManager.class);
        Display display = displays == null ? null : displays.getDisplay(Display.DEFAULT_DISPLAY);
        if (display == null) throw new IllegalStateException("无法读取系统主屏参数");
        DisplayMetrics metrics = new DisplayMetrics();
        display.getRealMetrics(metrics);
        return controller.create(integer(arguments, "width", metrics.widthPixels),
                integer(arguments, "height", metrics.heightPixels),
                integer(arguments, "dpi", metrics.densityDpi),
                integer(arguments, "bitrateKbps", 500));
    }

    void forgetConversation(String conversationId) {
        ShowerController controller = controllers.remove(conversationId);
        if (controller != null) {
            try { controller.release(); }
            catch (Exception ignored) { } // The server also reclaims idle displays or dead client tokens.
        }
    }

    void shutdown() {
        for (ShowerController controller : controllers.values()) {
            try { controller.release(); }
            catch (Exception ignored) { }
        }
        controllers.clear();
        manager.stopServer();
    }

    private JSONObject key(ShowerController controller, JSONObject arguments) throws Exception {
        String name = requiredString(arguments, "key", 32);
        Integer keyCode = KEYS.get(name);
        if (keyCode == null) throw new IllegalArgumentException("不支持的虚拟屏按键：" + name);
        int metaState = 0;
        JSONArray modifiers = arguments.optJSONArray("modifiers");
        if (modifiers != null) for (int index = 0; index < modifiers.length(); index++) {
            metaState |= switch (modifiers.getString(index)) {
                case "SHIFT" -> KeyEvent.META_SHIFT_ON;
                case "ALT" -> KeyEvent.META_ALT_ON;
                case "CTRL" -> KeyEvent.META_CTRL_ON;
                case "META" -> KeyEvent.META_META_ON;
                default -> throw new IllegalArgumentException("不支持的按键修饰符");
            };
        }
        return controller.key(keyCode, metaState, name);
    }

    private static int integer(JSONObject arguments, String name) {
        if (!arguments.has(name)) throw new IllegalArgumentException("缺少参数 " + name);
        return integer(arguments, name, 0);
    }

    private static int integer(JSONObject arguments, String name, int fallback) {
        if (!arguments.has(name)) return fallback;
        Object value = arguments.opt(name);
        if (!(value instanceof Number number)) throw new IllegalArgumentException(name + " 必须是整数");
        long integer = number.longValue();
        if (number.doubleValue() != integer || integer < Integer.MIN_VALUE || integer > Integer.MAX_VALUE) {
            throw new IllegalArgumentException(name + " 必须是整数");
        }
        return (int) integer;
    }

    private static String requiredString(JSONObject arguments, String name, int maxLength) {
        return requiredString(arguments, name, maxLength, false);
    }

    private static String requiredString(JSONObject arguments, String name, int maxLength, boolean allowEmpty) {
        Object value = arguments.opt(name);
        if (!(value instanceof String text) || !allowEmpty && text.isEmpty() || text.length() > maxLength) {
            throw new IllegalArgumentException(name + " 必须是 " + (allowEmpty ? "0" : "1")
                    + ".." + maxLength + " 字符的文本");
        }
        return text;
    }
}
