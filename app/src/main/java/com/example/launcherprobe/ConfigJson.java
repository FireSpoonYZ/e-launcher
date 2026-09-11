package com.example.launcherprobe;

import android.util.JsonReader;
import android.util.JsonToken;
import org.json.JSONObject;

import java.io.IOException;
import java.io.StringReader;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Strict JSON editing without converting unknown numbers through double. */
final class ConfigJson {
    static final int MAX_LENGTH = 1_048_576;

    private static final class NumberText {
        final String value;
        NumberText(String value) { this.value = value; }
        @Override public String toString() { return value; }
    }

    static Map<String, Object> object(String source) throws IOException {
        Object value = parse(source);
        if (!(value instanceof Map)) throw new IOException("配置根节点必须是 JSON 对象");
        return asObject(value);
    }

    static Object parse(String source) throws IOException {
        if (source.length() > MAX_LENGTH) throw new IOException("配置文件不能超过 1 MiB 字符");
        try (JsonReader reader = new JsonReader(new StringReader(source))) {
            reader.setLenient(false);
            Object result = read(reader, 0);
            if (reader.peek() != JsonToken.END_DOCUMENT) throw new IOException("JSON 结尾有多余内容");
            return result;
        } catch (IllegalStateException | NumberFormatException exception) {
            throw new IOException(exception.getMessage(), exception);
        }
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> asObject(Object value) { return (Map<String, Object>) value; }

    private static Object read(JsonReader reader, int depth) throws IOException {
        if (depth > 64) throw new IOException("JSON 嵌套不能超过 64 层");
        switch (reader.peek()) {
            case BEGIN_OBJECT:
                Map<String, Object> map = new LinkedHashMap<>();
                reader.beginObject();
                while (reader.hasNext()) {
                    String key = reader.nextName();
                    if (map.containsKey(key)) throw new IOException("重复的配置键：" + key);
                    map.put(key, read(reader, depth + 1));
                }
                reader.endObject();
                return map;
            case BEGIN_ARRAY:
                List<Object> list = new ArrayList<>();
                reader.beginArray();
                while (reader.hasNext()) list.add(read(reader, depth + 1));
                reader.endArray();
                return list;
            case STRING: return reader.nextString();
            case NUMBER: return new NumberText(reader.nextString());
            case BOOLEAN: return reader.nextBoolean();
            case NULL: reader.nextNull(); return null;
            default: throw new IOException("不完整的 JSON：" + reader.peek());
        }
    }

    static String format(String source) throws IOException { return encode(object(source)); }

    static String encode(Object value) {
        StringBuilder text = new StringBuilder();
        write(text, value, 0);
        return text.append('\n').toString();
    }

    private static void indent(StringBuilder text, int depth) {
        for (int i = 0; i < depth; i++) text.append("  ");
    }

    private static void write(StringBuilder text, Object value, int depth) {
        if (value instanceof Map) {
            Map<String, Object> map = asObject(value);
            text.append('{');
            int index = 0;
            for (Map.Entry<String, Object> item : map.entrySet()) {
                text.append(index++ == 0 ? "\n" : ",\n");
                indent(text, depth + 1);
                text.append(JSONObject.quote(item.getKey())).append(": ");
                write(text, item.getValue(), depth + 1);
            }
            if (!map.isEmpty()) { text.append('\n'); indent(text, depth); }
            text.append('}');
        } else if (value instanceof List) {
            List<?> list = (List<?>) value;
            text.append('[');
            for (int i = 0; i < list.size(); i++) {
                text.append(i == 0 ? "\n" : ",\n");
                indent(text, depth + 1);
                write(text, list.get(i), depth + 1);
            }
            if (!list.isEmpty()) { text.append('\n'); indent(text, depth); }
            text.append(']');
        } else if (value instanceof String) {
            text.append(JSONObject.quote((String) value));
        } else if (value == null || value instanceof Boolean || value instanceof NumberText) {
            text.append(value);
        } else {
            throw new IllegalArgumentException("不支持的 JSON 值类型");
        }
    }

    static Object get(Map<String, Object> root, String path) {
        Object value = root;
        for (String part : path.split("\\.")) {
            if (!(value instanceof Map)) return null;
            value = asObject(value).get(part);
        }
        return value;
    }

    static void set(Map<String, Object> root, String path, Object value, boolean remove) {
        String[] parts = path.split("\\.");
        Map<String, Object> current = root;
        for (int i = 0; i < parts.length - 1; i++) {
            Object child = current.get(parts[i]);
            if (child != null && !(child instanceof Map)) {
                throw new IllegalArgumentException("配置键不是对象：" + parts[i]);
            }
            if (child == null) {
                if (remove) return;
                child = new LinkedHashMap<String, Object>();
                current.put(parts[i], child);
            }
            current = asObject(child);
        }
        if (remove) current.remove(parts[parts.length - 1]);
        else current.put(parts[parts.length - 1], value);
    }

    static boolean isNumber(Object value) { return value instanceof NumberText || value instanceof Number; }

    static boolean sameValue(Object left, Object right) {
        if (left instanceof Map && right instanceof Map) {
            Map<String, Object> a = asObject(left), b = asObject(right);
            if (!a.keySet().equals(b.keySet())) return false;
            for (String key : a.keySet()) if (!sameValue(a.get(key), b.get(key))) return false;
            return true;
        }
        if (left instanceof java.util.List && right instanceof java.util.List) {
            java.util.List<?> a = (java.util.List<?>) left, b = (java.util.List<?>) right;
            if (a.size() != b.size()) return false;
            for (int i = 0; i < a.size(); i++) if (!sameValue(a.get(i), b.get(i))) return false;
            return true;
        }
        if (isNumber(left) && isNumber(right)) {
            if (left.toString().equals(right.toString())) return true;
            try { return new java.math.BigDecimal(left.toString()).compareTo(new java.math.BigDecimal(right.toString())) == 0; }
            catch (NumberFormatException exception) { return false; }
        }
        return java.util.Objects.equals(left, right);
    }

    static Map<String, Object> merge(Map<String, Object> global, Map<String, Object> project) {
        Map<String, Object> merged = new LinkedHashMap<>(global);
        for (Map.Entry<String, Object> item : project.entrySet()) {
            Object inherited = merged.get(item.getKey());
            Object override = item.getValue();
            merged.put(item.getKey(), inherited instanceof Map && override instanceof Map
                    ? merge(asObject(inherited), asObject(override)) : override);
        }
        return merged;
    }
}
