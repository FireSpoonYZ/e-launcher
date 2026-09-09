package com.example.launcherprobe;

import java.util.LinkedHashMap;
import java.util.Map;

/** Optional OpenAI-compatible reasoning_effort request field. */
public final class ReasoningEffort {
    public static final String DEFAULT = "";
    public static final String LOW = "low";
    public static final String MEDIUM = "medium";
    public static final String HIGH = "high";

    private ReasoningEffort() { }

    public static String normalize(String value) {
        return LOW.equals(value) || MEDIUM.equals(value) || HIGH.equals(value) ? value : DEFAULT;
    }

    public static Map<String, Object> requestFields(String model, String effort) {
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("model", model);
        String normalized = normalize(effort);
        if (!normalized.isEmpty()) fields.put("reasoning_effort", normalized);
        return fields;
    }
}
