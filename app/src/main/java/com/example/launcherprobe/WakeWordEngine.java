package com.example.launcherprobe;

import android.content.Context;

import com.k2fsa.sherpa.onnx.FeatureConfig;
import com.k2fsa.sherpa.onnx.KeywordSpotter;
import com.k2fsa.sherpa.onnx.KeywordSpotterConfig;
import com.k2fsa.sherpa.onnx.OnlineModelConfig;
import com.k2fsa.sherpa.onnx.OnlineStream;
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * sherpa-onnx keyword spotter over the bundled zh-en zipformer model. Keywords given to createStream() are added
 * to the configured file rather than replacing it, so the user's words are written to a private keywords file.
 */
final class WakeWordEngine implements AutoCloseable {
    static final int SAMPLE_RATE = 16_000;
    private static final String ASSET_DIR = "kws";
    private static final String ENCODER = "encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx";
    private static final String DECODER = "decoder-epoch-13-avg-2-chunk-16-left-64.onnx";
    private static final String JOINER = "joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx";
    private static final String TOKENS = "tokens.txt";
    private static Set<String> vocabulary;

    private final KeywordSpotter spotter;
    private final OnlineStream stream;

    /** Blocking: copies the model on first use and loads it (roughly a second on a phone). */
    WakeWordEngine(Context context, List<String> words, String sensitivity) throws IOException {
        File dir = modelDir(context);
        File keywords = new File(dir, "keywords.txt");
        write(keywords, WakeWords.keywordsFile(words, vocabulary(context)).getBytes(StandardCharsets.UTF_8));
        OnlineTransducerModelConfig transducer = new OnlineTransducerModelConfig();
        transducer.setEncoder(new File(dir, ENCODER).getAbsolutePath());
        transducer.setDecoder(new File(dir, DECODER).getAbsolutePath());
        transducer.setJoiner(new File(dir, JOINER).getAbsolutePath());
        OnlineModelConfig model = new OnlineModelConfig();
        model.setTransducer(transducer);
        model.setTokens(new File(dir, TOKENS).getAbsolutePath());
        model.setNumThreads(1);
        model.setProvider("cpu");
        FeatureConfig features = new FeatureConfig();
        features.setSampleRate(SAMPLE_RATE);
        features.setFeatureDim(80);
        KeywordSpotterConfig config = new KeywordSpotterConfig();
        config.setFeatConfig(features);
        config.setModelConfig(model);
        config.setMaxActivePaths(4);
        config.setKeywordsFile(keywords.getAbsolutePath());
        config.setKeywordsScore(1f);
        config.setKeywordsThreshold(threshold(sensitivity));
        config.setNumTrailingBlanks(1);
        // A null AssetManager makes the engine read the absolute paths above.
        spotter = new KeywordSpotter(null, config);
        stream = spotter.createStream("");
    }

    /** Feeds 16 kHz mono samples in [-1, 1]; returns the spotted label or null. */
    String accept(float[] samples, int count) {
        stream.acceptWaveform(count == samples.length ? samples : java.util.Arrays.copyOf(samples, count), SAMPLE_RATE);
        while (spotter.isReady(stream)) {
            spotter.decode(stream);
            String keyword = spotter.getResult(stream).getKeyword();
            if (keyword != null && !keyword.isEmpty()) {
                spotter.reset(stream);
                return keyword;
            }
        }
        return null;
    }

    @Override public void close() {
        stream.release();
        spotter.release();
    }

    static float threshold(String sensitivity) {
        if (VoiceSettings.WAKE_LOW.equals(sensitivity)) return .35f;
        if (VoiceSettings.WAKE_HIGH.equals(sensitivity)) return .15f;
        return .25f;
    }

    /** Model token inventory, used to reject wake words before they reach the engine. */
    static synchronized Set<String> vocabulary(Context context) throws IOException {
        if (vocabulary != null) return vocabulary;
        Set<String> tokens = new HashSet<>();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                context.getAssets().open(ASSET_DIR + "/" + TOKENS), StandardCharsets.UTF_8))) {
            for (String line; (line = reader.readLine()) != null;) {
                String[] parts = line.trim().split("\\s+");
                if (parts.length == 2 && !parts[0].startsWith("<")) tokens.add(parts[0]);
            }
        }
        vocabulary = Collections.unmodifiableSet(tokens);
        return vocabulary;
    }

    private static File modelDir(Context context) throws IOException {
        File dir = new File(context.getNoBackupFilesDir(), "kws");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("无法创建唤醒模型目录");
        // Assets only change with the APK, so the copy is refreshed once per install or update.
        String stamp;
        try { stamp = String.valueOf(context.getPackageManager().getPackageInfo(context.getPackageName(), 0).lastUpdateTime); }
        catch (android.content.pm.PackageManager.NameNotFoundException impossible) { throw new IOException(impossible); }
        File marker = new File(dir, "installed");
        if (marker.isFile() && stamp.equals(new String(java.nio.file.Files.readAllBytes(marker.toPath()), StandardCharsets.UTF_8))) return dir;
        for (String name : new String[]{ENCODER, DECODER, JOINER, TOKENS}) {
            try (InputStream input = context.getAssets().open(ASSET_DIR + "/" + name)) { write(new File(dir, name), read(input)); }
        }
        write(marker, stamp.getBytes(StandardCharsets.UTF_8));
        return dir;
    }

    // InputStream.readAllBytes needs API 33.
    private static byte[] read(InputStream input) throws IOException {
        java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[1 << 16];
        for (int count; (count = input.read(buffer)) != -1;) bytes.write(buffer, 0, count);
        return bytes.toByteArray();
    }

    private static void write(File target, byte[] bytes) throws IOException {
        File partial = new File(target.getPath() + ".part");
        try (OutputStream output = new FileOutputStream(partial)) { output.write(bytes); }
        if (!partial.renameTo(target)) throw new IOException("无法写入唤醒模型文件");
    }
}
