package com.example.launcherprobe;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.AtomicFile;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/** App-private Pi files; editor and form writes share validation and conflict checks. */
final class PiConfigStore {
    private static final Object LOCK = new Object();
    private static final String LEGACY_SESSIONS = "pi_legacy_workspace_sessions";
    private static final String LEGACY_SESSIONS_CAPTURED = "pi_legacy_workspace_sessions_captured";
    private final Context context;
    private final String conversationId;
    private final File global;
    private final File workspace;
    private final File cache;
    private final File home;
    private final File nativeLibraryDir;

    PiConfigStore(Context context) {
        this(context, context.getSharedPreferences("chat", Context.MODE_PRIVATE)
                .getString("active_chat", "legacy"));
    }

    PiConfigStore(Context context, String conversationId) {
        this.context = context.getApplicationContext();
        this.conversationId = conversationId;
        registerExistingSessions(this.context);
        home = new File(context.getFilesDir(), "node");
        global = new File(home, ".pi/agent");
        workspace = new File(new File(context.getFilesDir(), "pi-workspaces"), workspaceName(conversationId) + "/.pi");
        cache = new File(context.getCacheDir(), "pi-runtime");
        String nativePath = context.getApplicationInfo().nativeLibraryDir;
        nativeLibraryDir = nativePath == null ? new File(context.getFilesDir(), "native") : new File(nativePath);
    }

    String conversationId() { return conversationId; }
    File directory(boolean project) { return project ? workspace : global; }
    File workspaceRoot() { return workspace.getParentFile(); }

    private File file(boolean project, String name) throws IOException {
        if (project) ensureWorkspace();
        File root = directory(project).getCanonicalFile();
        File target = new File(root, name).getCanonicalFile();
        if (name.isEmpty() || !target.getPath().startsWith(root.getPath() + File.separator)) {
            throw new IOException("配置路径必须位于当前配置目录内");
        }
        return target;
    }

    String read(boolean project, String name) throws IOException {
        synchronized (LOCK) { return readFile(file(project, name), name.endsWith(".json") ? "{}\n" : ""); }
    }

    private static String readFile(File file, String fallback) throws IOException {
        AtomicFile atomic = new AtomicFile(file);
        // openRead also recovers an interrupted AtomicFile write.
        if (!file.exists() && !new File(file.getPath() + ".bak").exists()) return fallback;
        if (file.length() > ConfigJson.MAX_LENGTH * 4L) throw new IOException("配置文件过大");
        byte[] bytes = atomic.readFully();
        return new String(bytes, StandardCharsets.UTF_8);
    }

    void save(boolean project, String name, String source, String expected) throws IOException {
        String formatted = name.endsWith(".json") ? ConfigJson.format(source) : source;
        if (formatted.length() > ConfigJson.MAX_LENGTH) throw new IOException("配置文件过大");
        synchronized (LOCK) {
            File target = file(project, name);
            String previous = read(project, name);
            if (expected != null && !expected.equals(previous)) {
                throw new IOException("文件已被其他操作修改，请重新打开后合并；当前编辑内容已保留");
            }
            if (formatted.equals(previous)) return;
            write(file(project, name + ".previous"), previous);
            write(target, formatted);
        }
    }

    void saveTogether(Map<String, String> updates, Map<String, String> originals) throws IOException {
        synchronized (LOCK) {
            Map<String, String> formatted = new LinkedHashMap<>();
            for (Map.Entry<String, String> item : updates.entrySet()) {
                formatted.put(item.getKey(), ConfigJson.format(item.getValue()));
                if (!read(false, item.getKey()).equals(originals.get(item.getKey()))) {
                    throw new IOException("配置已变化，请重新打开后修改");
                }
            }
            java.util.List<String> saved = new java.util.ArrayList<>();
            try {
                for (Map.Entry<String, String> item : formatted.entrySet()) {
                    save(false, item.getKey(), item.getValue(), originals.get(item.getKey()));
                    saved.add(item.getKey());
                }
            } catch (IOException exception) {
                for (String name : saved) try { write(file(false, name), originals.get(name)); }
                catch (IOException rollback) { exception.addSuppressed(rollback); }
                throw exception;
            }
        }
    }

    static void write(File file, String text) throws IOException {
        File parent = file.getParentFile();
        if (parent == null || (!parent.isDirectory() && !parent.mkdirs())) throw new IOException("无法创建配置目录");
        AtomicFile atomic = new AtomicFile(file);
        FileOutputStream output = null;
        try {
            output = atomic.startWrite();
            output.write(text.getBytes(StandardCharsets.UTF_8));
            atomic.finishWrite(output);
        } catch (IOException exception) {
            if (output != null) atomic.failWrite(output);
            throw exception;
        }
    }

    static void registerExistingSessions(Context context) {
        synchronized (LOCK) {
            SharedPreferences preferences = context.getSharedPreferences("chat", Context.MODE_PRIVATE);
            if (preferences.getBoolean(LEGACY_SESSIONS_CAPTURED, false)) return;
            Set<String> sessions = new java.util.HashSet<>();
            sessions.add(preferences.getString("active_chat", "legacy"));
            try {
                org.json.JSONObject index = new org.json.JSONObject(preferences.getString("conversations", "{}"));
                java.util.Iterator<String> ids = index.keys();
                while (ids.hasNext()) sessions.add(ids.next());
            } catch (Exception exception) {
                throw new IllegalStateException("无法登记旧会话工作区", exception);
            }
            preferences.edit().putStringSet(LEGACY_SESSIONS, sessions)
                    .putBoolean(LEGACY_SESSIONS_CAPTURED, true).apply();
        }
    }

    static void deleteWorkspace(Context context, String conversationId) throws IOException {
        synchronized (LOCK) {
            File root = new File(new File(context.getFilesDir(), "pi-workspaces"), workspaceName(conversationId));
            deleteTree(root);
            SharedPreferences preferences = context.getSharedPreferences("chat", Context.MODE_PRIVATE);
            Set<String> legacy = new java.util.HashSet<>(preferences.getStringSet(LEGACY_SESSIONS,
                    java.util.Collections.emptySet()));
            if (legacy.remove(conversationId)) preferences.edit().putStringSet(LEGACY_SESSIONS, legacy).apply();
        }
    }

    private void ensureWorkspace() throws IOException {
        synchronized (LOCK) {
            File root = workspaceRoot();
            if (root.isDirectory()) return;
            File parent = root.getParentFile();
            if (parent == null || (!parent.isDirectory() && !parent.mkdirs())) throw new IOException("无法创建会话工作区目录");
            File temporary = new File(parent, "." + root.getName() + "-creating");
            deleteTree(temporary);
            try {
                File legacy = new File(context.getFilesDir(), "pi-workspace");
                Set<String> sessions = context.getSharedPreferences("chat", Context.MODE_PRIVATE)
                        .getStringSet(LEGACY_SESSIONS, java.util.Collections.emptySet());
                if (sessions.contains(conversationId) && legacy.isDirectory()) copyTree(legacy, temporary);
                else if (!temporary.mkdirs()) throw new IOException("无法创建会话工作区");
                File project = new File(temporary, ".pi");
                if (!project.isDirectory() && !project.mkdirs()) throw new IOException("无法创建会话配置目录");
                if (!temporary.renameTo(root)) throw new IOException("无法启用会话工作区");
            } catch (IOException exception) {
                deleteTree(temporary);
                throw exception;
            }
        }
    }

    private static String workspaceName(String conversationId) {
        if (conversationId == null || !conversationId.matches("[A-Za-z0-9_-]{1,100}")) {
            if (conversationId == null) throw new IllegalArgumentException("conversationId is required");
            return java.util.UUID.nameUUIDFromBytes(conversationId.getBytes(StandardCharsets.UTF_8)).toString();
        }
        return conversationId;
    }

    private static void copyTree(File source, File target) throws IOException {
        if (Files.isSymbolicLink(source.toPath())) {
            Files.copy(source.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING,
                    java.nio.file.LinkOption.NOFOLLOW_LINKS);
        } else if (source.isDirectory()) {
            if (!target.isDirectory() && !target.mkdirs()) throw new IOException("无法复制旧工作区");
            File[] children = source.listFiles();
            if (children == null) throw new IOException("无法读取旧工作区");
            for (File child : children) copyTree(child, new File(target, child.getName()));
        } else {
            Files.copy(source.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING,
                    StandardCopyOption.COPY_ATTRIBUTES);
        }
    }

    private static void deleteTree(File file) throws IOException {
        if (!Files.exists(file.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS)) return;
        if (!Files.isSymbolicLink(file.toPath()) && file.isDirectory()) {
            File[] children = file.listFiles();
            if (children == null) throw new IOException("无法读取待清理工作区");
            for (File child : children) deleteTree(child);
        }
        if (!file.delete()) throw new IOException("无法清理会话工作区");
    }

    String previous(boolean project, String name) throws IOException {
        synchronized (LOCK) {
            File previous = file(project, name + ".previous");
            if (!previous.isFile()) throw new IOException("没有可恢复的上一版");
            return readFile(previous, "");
        }
    }

    Map<String, Object> settings(boolean project) throws IOException {
        return ConfigJson.object(read(project, "settings.json"));
    }

    Map<String, Object> effectiveSettings() throws IOException {
        Map<String, Object> project = settings(true);
        // These two settings are explicitly global-only in Pi's contract.
        project.remove("httpProxy");
        project.remove("defaultProjectTrust");
        return ConfigJson.merge(settings(false), project);
    }

    void initialize(SharedPreferences legacy) throws IOException {
        synchronized (LOCK) {
            File marker = file(false, ".launcher-migrated");
            if (marker.exists()) return;
            String oldSettings = read(false, "settings.json");
            Map<String, Object> settings = ConfigJson.object(oldSettings);
            settings.putIfAbsent("defaultProvider", "launcher");
            settings.putIfAbsent("defaultModel", legacy.getString("model", "gpt-4o-mini"));
            String effort = legacy.getString("reasoning_effort", "");
            if (!effort.isEmpty()) settings.putIfAbsent("defaultThinkingLevel", effort);
            String oldModels = read(false, "models.json");
            Map<String, Object> models = ConfigJson.object(oldModels);
            Object providersValue = models.get("providers");
            if (providersValue != null && !(providersValue instanceof Map)) throw new IOException("models.json providers 必须是对象");
            Map<String, Object> providers = providersValue == null ? new LinkedHashMap<>() : ConfigJson.asObject(providersValue);
            if (!providers.containsKey("launcher")) {
                Map<String, Object> provider = new LinkedHashMap<>();
                provider.put("baseUrl", legacy.getString("base_url", "https://api.openai.com/v1"));
                provider.put("api", "openai-completions");
                Map<String, Object> model = new LinkedHashMap<>();
                model.put("id", legacy.getString("model", "gpt-4o-mini"));
                if (!effort.isEmpty()) model.put("reasoning", true);
                provider.put("models", java.util.Collections.singletonList(model));
                providers.put("launcher", provider);
                models.put("providers", providers);
            }
            String oldAuth = read(false, "auth.json");
            Map<String, Object> auth = ConfigJson.object(oldAuth);
            String key = legacy.getString("api_key", "");
            if (!key.isEmpty() && !auth.containsKey("launcher")) {
                Map<String, Object> credential = new LinkedHashMap<>();
                credential.put("type", "api_key");
                credential.put("key", key);
                auth.put("launcher", credential);
            }
            save(false, "models.json", ConfigJson.encode(models), oldModels);
            save(false, "auth.json", ConfigJson.encode(auth), oldAuth);
            save(false, "settings.json", ConfigJson.encode(settings), oldSettings);
            write(marker, "1\n");
        }
    }

    String snapshot() throws IOException {
        synchronized (LOCK) {
            Map<String, Object> globalSettings = settings(false);
            Map<String, Object> projectSettings = settings(true);
            Map<String, Object> effective = effectiveSettings();
            Object configuredNpm = effective.get("npmCommand");
            if (configuredNpm == null || (configuredNpm instanceof java.util.List && ((java.util.List<?>) configuredNpm).isEmpty())) {
                java.util.List<String> command = java.util.Arrays.asList(
                        new File(nativeLibraryDir, "libnode_launcher.so").getAbsolutePath(),
                        new File(home, "npm/11.6.2/bin/npm-cli.js").getAbsolutePath());
                globalSettings.put("npmCommand", command);
                projectSettings.remove("npmCommand");
                effective.put("npmCommand", command);
            }
            File npmCache = new File(cache, "npm");
            Map<String, Object> environment = new LinkedHashMap<>();
            environment.put("HOME", home.getAbsolutePath());
            environment.put("TMPDIR", cache.getAbsolutePath());
            String inheritedPath = System.getenv("PATH");
            environment.put("PATH", new File(home, "bin").getAbsolutePath() + File.pathSeparator
                    + (inheritedPath == null ? "/system/bin" : inheritedPath));
            environment.put("LD_LIBRARY_PATH", nativeLibraryDir.getAbsolutePath());
            environment.put("npm_config_cache", npmCache.getAbsolutePath());
            environment.put("npm_config_userconfig", new File(home, "npmrc").getAbsolutePath());
            environment.put("npm_config_script_shell", "/system/bin/sh");
            Map<String, Object> snapshot = new LinkedHashMap<>();
            snapshot.put("agentDir", global.getAbsolutePath());
            snapshot.put("cwd", workspace.getParentFile().getAbsolutePath());
            snapshot.put("cacheDir", cache.getAbsolutePath());
            snapshot.put("runtimeEnvironment", environment);
            snapshot.put("settings", effective);
            snapshot.put("globalSettings", globalSettings);
            snapshot.put("projectSettings", projectSettings);
            snapshot.put("models", ConfigJson.object(read(false, "models.json")));
            snapshot.put("auth", ConfigJson.object(read(false, "auth.json")));
            snapshot.put("systemPrompt", read(false, "SYSTEM.md"));
            snapshot.put("appendSystemPrompt", read(false, "APPEND_SYSTEM.md"));
            return ConfigJson.encode(snapshot);
        }
    }

    void updateCredential(String provider, String next, String previous) throws IOException {
        synchronized (LOCK) {
            String source = read(false, "auth.json");
            Map<String, Object> auth = ConfigJson.object(source);
            Object expected = previous == null ? null : ConfigJson.object(previous);
            if (!ConfigJson.sameValue(auth.get(provider), expected)) throw new IOException("凭据已变化，未覆盖新的配置");
            if (next == null) auth.remove(provider);
            else auth.put(provider, ConfigJson.object(next));
            save(false, "auth.json", ConfigJson.encode(auth), source);
        }
    }

    void updateSetting(boolean project, String key, String next, String previous) throws IOException {
        synchronized (LOCK) {
            String source = read(project, "settings.json");
            Map<String, Object> settings = ConfigJson.object(source);
            Object expected = ConfigJson.object("{\"value\":" + previous + "}").get("value");
            if (!ConfigJson.sameValue(ConfigJson.get(settings, key), expected)) throw new IOException("设置已变化，请重新读取后重试");
            Object value = ConfigJson.object("{\"value\":" + next + "}").get("value");
            ConfigJson.set(settings, key, value, false);
            save(project, "settings.json", ConfigJson.encode(settings), source);
        }
    }

    String[] files(boolean project) throws IOException {
        File root = directory(project);
        java.util.Set<String> names = new java.util.TreeSet<>();
        java.util.Collections.addAll(names, "settings.json", "models.json", "auth.json", "SYSTEM.md", "APPEND_SYSTEM.md", "AGENTS.md", "keybindings.json");
        if (root.isDirectory()) try (java.util.stream.Stream<java.nio.file.Path> paths = Files.walk(root.toPath())) {
            paths.filter(Files::isRegularFile).forEach(path -> {
                String name = root.toPath().relativize(path).toString().replace(File.separatorChar, '/');
                if (!name.endsWith(".previous") && !name.endsWith(".bak") && !name.startsWith(".")) names.add(name);
            });
        }
        return names.toArray(new String[0]);
    }
}
