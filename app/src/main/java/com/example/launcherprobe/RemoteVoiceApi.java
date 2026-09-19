package com.example.launcherprobe;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.MediaType;
import okhttp3.MultipartBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

import org.json.JSONObject;

/** OpenAI-compatible /audio/transcriptions and /audio/speech clients. */
final class RemoteVoiceApi {
    static final int SAMPLE_RATE = 16_000;
    private static final int MAX_ERROR_BODY = 300;
    private static final OkHttpClient CLIENT = new OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS).readTimeout(120, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS).build();

    private RemoteVoiceApi() { }

    static Call transcribeCall(VoiceSettings.Remote remote, byte[] wav, String language) {
        requireConfigured(remote);
        MultipartBody.Builder body = new MultipartBody.Builder().setType(MultipartBody.FORM)
                .addFormDataPart("file", "speech.wav", RequestBody.create(MediaType.get("audio/wav"), wav))
                .addFormDataPart("model", remote.model)
                .addFormDataPart("response_format", "json");
        String iso = isoLanguage(language);
        if (!iso.isEmpty()) body.addFormDataPart("language", iso);
        return CLIENT.newCall(request(remote, "/audio/transcriptions").post(body.build()).build());
    }

    static String transcription(Call call) throws IOException {
        try (Response response = call.execute()) {
            String body = bodyText(response);
            if (!response.isSuccessful()) throw failure(response.code(), body);
            try { return new JSONObject(body).optString("text", "").trim(); }
            catch (org.json.JSONException notJson) { return body.trim(); }
        }
    }

    static Call speechCall(VoiceSettings.Remote remote, String text, float speed) {
        requireConfigured(remote);
        try {
            JSONObject json = new JSONObject().put("model", remote.model).put("input", text)
                    .put("response_format", "kokoro".equalsIgnoreCase(remote.model) ? "pcm" : "mp3");
            if ("kokoro".equalsIgnoreCase(remote.model)) json.put("stream", true);
            if (!remote.voice.isEmpty()) json.put("voice", remote.voice);
            if (Math.abs(speed - 1f) > .01f) json.put("speed", speed);
            return CLIENT.newCall(request(remote, "/audio/speech")
                    .post(RequestBody.create(MediaType.get("application/json"), json.toString())).build());
        } catch (org.json.JSONException impossible) { throw new IllegalStateException(impossible); }
    }

    /** Opens speech without buffering the body. The caller owns and closes the response. */
    static Response speechResponse(Call call) throws IOException {
        Response response = call.execute();
        try {
            if (!response.isSuccessful()) throw failure(response.code(), bodyText(response));
            ResponseBody body = response.body();
            MediaType type = body == null ? null : body.contentType();
            if (body == null) throw new IOException("语音合成返回了空音频");
            if (type != null && ("json".equals(type.subtype()) || "text".equals(type.type())))
                throw failure(response.code(), bodyText(response));
        } catch (IOException failure) {
            response.close();
            throw failure;
        }
        return response;
    }

    static byte[] audio(Call call) throws IOException {
        try (Response response = call.execute()) {
            ResponseBody body = response.body();
            if (!response.isSuccessful()) throw failure(response.code(), bodyText(response));
            byte[] bytes = body == null ? new byte[0] : body.bytes();
            if (bytes.length == 0) throw new IOException("语音合成返回了空音频");
            MediaType type = body.contentType();
            if (type != null && ("json".equals(type.subtype()) || "text".equals(type.type())))
                throw failure(response.code(), new String(bytes, java.nio.charset.StandardCharsets.UTF_8));
            return bytes;
        }
    }

    /** 16-bit mono PCM → RIFF WAV. */
    static byte[] wav(short[] samples, int count) {
        ByteBuffer buffer = ByteBuffer.allocate(44 + count * 2).order(ByteOrder.LITTLE_ENDIAN);
        buffer.put(new byte[]{'R', 'I', 'F', 'F'}).putInt(36 + count * 2).put(new byte[]{'W', 'A', 'V', 'E'})
                .put(new byte[]{'f', 'm', 't', ' '}).putInt(16).putShort((short) 1).putShort((short) 1)
                .putInt(SAMPLE_RATE).putInt(SAMPLE_RATE * 2).putShort((short) 2).putShort((short) 16)
                .put(new byte[]{'d', 'a', 't', 'a'}).putInt(count * 2);
        for (int i = 0; i < count; i++) buffer.putShort(samples[i]);
        return buffer.array();
    }

    /** Whisper-style APIs take ISO-639-1 codes, not full locale tags. */
    static String isoLanguage(String tag) {
        if (tag == null || tag.isEmpty()) return "";
        String primary = tag.split("[-_]")[0].toLowerCase(java.util.Locale.ROOT);
        return primary.length() == 2 ? primary : "";
    }

    private static Request.Builder request(VoiceSettings.Remote remote, String path) {
        Request.Builder builder = new Request.Builder().url(remote.baseUrl + path);
        if (!remote.apiKey.isEmpty()) builder.header("Authorization", "Bearer " + remote.apiKey);
        return builder;
    }

    private static void requireConfigured(VoiceSettings.Remote remote) {
        if (!remote.configured()) throw new IllegalStateException("远程语音模型尚未配置接口地址和模型");
    }

    private static String bodyText(Response response) throws IOException {
        ResponseBody body = response.body();
        return body == null ? "" : body.string();
    }

    private static IOException failure(int code, String body) {
        String detail = body;
        try {
            JSONObject json = new JSONObject(body);
            Object error = json.opt("error");
            detail = error instanceof JSONObject ? ((JSONObject) error).optString("message", body)
                    : error != null ? String.valueOf(error) : json.optString("message", json.optString("detail", body));
        } catch (org.json.JSONException ignored) { }
        detail = detail.trim();
        if (detail.length() > MAX_ERROR_BODY) detail = detail.substring(0, MAX_ERROR_BODY) + "…";
        return new IOException("语音服务返回 HTTP " + code + (detail.isEmpty() ? "" : "：" + detail));
    }
}
