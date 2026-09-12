package com.example.launcherprobe;

import android.content.Context;
import android.content.ContextWrapper;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Comparator;
import java.util.Iterator;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

/** Runs the same npm/SDK integration check under the real target application's UID. */
final class NpmRuntimeChecks {
    static String run(Context context, Context tests) throws Exception {
        File root = new File(context.getCacheDir(), "npm-device-check-" + UUID.randomUUID());
        Context isolated = new ContextWrapper(context) {
            @Override public File getFilesDir() { return new File(root, "files"); }
            @Override public File getCacheDir() { return new File(root, "cache"); }
        };
        File home = new File(isolated.getFilesDir(), "node");
        try {
            Files.createDirectories(home.toPath());
            Files.createDirectories(isolated.getCacheDir().toPath());
            PiAgentBridge.prepareNpm(isolated, home);
            File marker = new File(home, "npm/11.6.2/payload-complete.txt");
            long prepared = marker.lastModified();
            File node = new File(home, "bin/node");
            Files.delete(node.toPath());
            android.system.Os.symlink(new File(root, "old-apk/libnode_launcher.so").getPath(), node.getPath());
            PiAgentBridge.prepareNpm(isolated, home);
            if (!node.isFile() || marker.lastModified() != prepared) throw new AssertionError("APK upgrade link repair / payload cache failed");
            PiAgentBridge.copyAssets(context, "pi-runtime.cjs", new File(home, "pi-runtime.cjs"));
            PiAgentBridge.copyAssets(context, "pi-sdk", new File(home, "pi-sdk"));
            PiAgentBridge.copyAssets(tests, "npm-check.cjs", new File(home, "npm-check.cjs"));
            JSONObject snapshot = new JSONObject(new PiConfigStore(isolated).snapshot());
            JSONArray npm = snapshot.getJSONObject("globalSettings").getJSONArray("npmCommand");
            File log = new File(root, "npm-check.log");
            ProcessBuilder builder = new ProcessBuilder(npm.getString(0), new File(home, "npm-check.cjs").getPath(),
                    npm.getString(1), new File(home, "pi-runtime.cjs").getPath())
                    .directory(home).redirectErrorStream(true).redirectOutput(log);
            JSONObject environment = snapshot.getJSONObject("runtimeEnvironment");
            for (Iterator<String> keys = environment.keys(); keys.hasNext();) {
                String key = keys.next(); builder.environment().put(key, environment.getString(key));
            }
            Process process = builder.start();
            if (!process.waitFor(4, TimeUnit.MINUTES)) {
                process.destroyForcibly();
                process.waitFor(5, TimeUnit.SECONDS);
                throw new AssertionError("npm/SDK integration check timed out");
            }
            String output;
            try (java.io.InputStream input = Files.newInputStream(log.toPath())) {
                output = new String(input.readNBytes(32000), StandardCharsets.UTF_8);
            }
            if (process.exitValue() != 0) throw new AssertionError("npm/SDK exit " + process.exitValue() + ": " + output);
            return "App UID " + android.os.Process.myUid() + ", SELinux "
                    + new String(Files.readAllBytes(new File("/proc/self/attr/current").toPath()), StandardCharsets.UTF_8).trim()
                    + "\nPASS: packaged launcher, cached npm payload and dangling APK link repair\n" + output;
        } finally {
            if (root.exists()) try (java.util.stream.Stream<java.nio.file.Path> paths = Files.walk(root.toPath())) {
                for (java.nio.file.Path path : (Iterable<java.nio.file.Path>) paths.sorted(Comparator.reverseOrder())::iterator) Files.delete(path);
            }
        }
    }
}
