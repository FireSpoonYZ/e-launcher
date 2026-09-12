package com.example.launcherprobe;

import org.json.JSONObject;

/** Metadata for an app-private chat attachment; file names are generated IDs, never provider names. */
public final class ChatAttachment {
    public final String id, name, mimeType, kind, path;
    public final long size;

    public ChatAttachment(String id, String name, String mimeType, String kind, long size, String path) {
        this.id = id; this.name = name; this.mimeType = mimeType; this.kind = kind; this.size = size; this.path = path;
    }

    static ChatAttachment fromJson(JSONObject value) throws Exception {
        return new ChatAttachment(value.getString("id"), value.optString("name", "附件"),
                value.optString("mimeType", "application/octet-stream"), value.optString("kind", "file"),
                value.optLong("size"), value.getString("path"));
    }

    JSONObject toJson() {
        try { return new JSONObject().put("id", id).put("name", name).put("mimeType", mimeType)
                .put("kind", kind).put("size", size).put("path", path); }
        catch (Exception exception) { throw new IllegalStateException(exception); }
    }
}
