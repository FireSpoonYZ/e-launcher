package com.example.launcherprobe;

import android.view.KeyEvent;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Map;

/** Validates native Shower tool calls before dispatching them to the single display controller. */
final class ShowerToolBridge {
    private static final Map<String, Integer> KEYS = Map.ofEntries(
            Map.entry("BACK", KeyEvent.KEYCODE_BACK),
            Map.entry("HOME", KeyEvent.KEYCODE_HOME),
            Map.entry("ENTER", KeyEvent.KEYCODE_ENTER),
            Map.entry("TAB", KeyEvent.KEYCODE_TAB),
            Map.entry("ESCAPE", KeyEvent.KEYCODE_ESCAPE),
            Map.entry("SPACE", KeyEvent.KEYCODE_SPACE),
            Map.entry("DEL", KeyEvent.KEYCODE_DEL),
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
    private final ShowerController controller;

    ShowerToolBridge(android.content.Context context) {
        controller = new ShowerController(context);
    }

    JSONObject execute(JSONObject arguments) throws Exception {
        if (arguments == null) throw new IllegalArgumentException("缺少 Shower 工具参数");
        String action = arguments.optString("action", "");
        return switch (action) {
            case "create" -> controller.create(integer(arguments, "width", 720),
                    integer(arguments, "height", 1280), integer(arguments, "dpi", 320),
                    integer(arguments, "bitrateKbps", 500));
            case "launch" -> controller.launch(requiredString(arguments, "packageName", 255));
            case "screenshot" -> controller.screenshot(integer(arguments, "maxWidth", 720),
                    integer(arguments, "maxHeight", 1280));
            case "tap" -> controller.tap(integer(arguments, "x"), integer(arguments, "y"));
            case "swipe" -> controller.swipe(integer(arguments, "x1"), integer(arguments, "y1"),
                    integer(arguments, "x2"), integer(arguments, "y2"),
                    integer(arguments, "durationMs", 300));
            case "key" -> key(arguments);
            case "text" -> controller.text(requiredString(arguments, "text", 1000));
            case "release" -> controller.release();
            default -> throw new IllegalArgumentException("未知 Shower action：" + action);
        };
    }

    void shutdown() {
        try { controller.release(); }
        catch (Exception ignored) { }
    }

    private JSONObject key(JSONObject arguments) throws Exception {
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
        Object value = arguments.opt(name);
        if (!(value instanceof String text) || text.isEmpty() || text.length() > maxLength) {
            throw new IllegalArgumentException(name + " 必须是 1.." + maxLength + " 字符的文本");
        }
        return text;
    }
}
