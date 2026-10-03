package com.example.launcherprobe;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.UUID;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Isolated, backup-excluded host records; tokens are AES-GCM encrypted with a nonexportable key. */
final class RemoteTerminalStore {
    private static final String ALIAS = "remote_terminal.tokens.v1";
    private final AtomicFile file;

    RemoteTerminalStore(Context context) {
        file = new AtomicFile(new File(context.getNoBackupFilesDir(), "remote_terminal_hosts_v1.json"));
    }

    private JSONObject read() throws Exception {
        if (!file.getBaseFile().exists()) return new JSONObject();
        return new JSONObject(new String(file.readFully(), StandardCharsets.UTF_8));
    }

    private void write(JSONObject records) throws Exception {
        FileOutputStream stream = file.startWrite();
        try {
            stream.write(records.toString().getBytes(StandardCharsets.UTF_8));
            file.finishWrite(stream);
        } catch (Exception failure) {
            file.failWrite(stream);
            throw failure;
        }
    }

    private SecretKey key(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(ALIAS)) {
            if (!create) throw new IllegalStateException("Terminal credentials unavailable; remove host and pair again");
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            return generator.generateKey();
        }
        return (SecretKey) store.getKey(ALIAS, null);
    }

    static JSONObject publicHost(JSONObject record) throws Exception {
        JSONObject host = new JSONObject();
        for (String field : new String[] { "id", "name", "address", "port", "fingerprint" })
            host.put(field, record.get(field));
        return host;
    }

    JSONArray hosts() throws Exception {
        JSONObject records = read();
        JSONArray hosts = new JSONArray();
        java.util.Iterator<String> ids = records.keys();
        while (ids.hasNext()) hosts.put(publicHost(records.getJSONObject(ids.next())));
        return hosts;
    }

    JSONObject host(String id) throws Exception {
        JSONObject record = read().optJSONObject(id);
        if (record == null) throw new IllegalArgumentException("Unknown host");
        return record;
    }

    JSONObject save(JSONObject descriptor, String name, String token) throws Exception {
        JSONObject records = read();
        String id = descriptor.getString("fingerprint");
        JSONObject old = records.optJSONObject(id);
        JSONObject record = new JSONObject().put("id", id).put("name", name)
                .put("address", descriptor.getString("address")).put("port", descriptor.getInt("port"))
                .put("fingerprint", id)
                .put("clientId", old == null ? UUID.randomUUID().toString() : old.getString("clientId"));
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key(true));
        cipher.updateAAD(id.getBytes(StandardCharsets.UTF_8));
        record.put("tokenIv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP));
        record.put("tokenCiphertext", Base64.encodeToString(
                cipher.doFinal(token.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP));
        records.put(id, record);
        write(records);
        return record;
    }

    String token(JSONObject record) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(false),
                new GCMParameterSpec(128, Base64.decode(record.getString("tokenIv"), Base64.NO_WRAP)));
        cipher.updateAAD(record.getString("id").getBytes(StandardCharsets.UTF_8));
        return new String(cipher.doFinal(Base64.decode(record.getString("tokenCiphertext"), Base64.NO_WRAP)),
                StandardCharsets.UTF_8);
    }

    void remove(String id) throws Exception {
        JSONObject records = read();
        records.remove(id);
        write(records);
    }
}
