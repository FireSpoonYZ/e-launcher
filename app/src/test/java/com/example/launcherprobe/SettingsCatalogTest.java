package com.example.launcherprobe;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import okhttp3.HttpUrl;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class SettingsCatalogTest {
    @Test public void registryMetadataCannotBecomeAnArbitraryInstallSource() throws Exception {
        JSONObject item = new JSONObject("{\"name\":\"@author/demo\",\"version\":\"1.2.3-beta.1\",\"keywords\":[\"pi-package\",\"skill\"]}");
        assertEquals("npm:@author/demo@1.2.3-beta.1", SettingsCatalog.installSource(item));
        assertTrue(SettingsCatalog.keyword(item, "skill"));
        assertFalse(SettingsCatalog.keyword(item, "extension"));
        assertTrue(SettingsCatalog.matchesSource("npm:@author/demo@^1.0.0", "@author/demo"));
        assertFalse(SettingsCatalog.matchesSource("npm:@author/demo-other", "@author/demo"));
        assertFalse(SettingsCatalog.matchesSource("git:author/demo", "@author/demo"));
        for (String name : new String[]{"--help", "git:host/repo", "demo; touch bad", "../demo"}) {
            item.put("name", name);
            assertThrows(IllegalArgumentException.class, () -> SettingsCatalog.installSource(item));
        }
        item.put("name", "demo").put("version", "1.0.0; touch bad");
        assertThrows(IllegalArgumentException.class, () -> SettingsCatalog.installSource(item));
    }

    @Test public void release404IsEmptyButOtherHttpErrorsRemainErrors() throws Exception {
        assertNull(SettingsCatalog.read(response(404, "{}"), true));
        assertThrows(IOException.class, () -> SettingsCatalog.read(response(404, "{}"), false));
        assertThrows(IOException.class, () -> SettingsCatalog.read(response(403, "{\"message\":\"rate limited\"}"), true));
        assertEquals("v2", SettingsCatalog.read(response(200, "{\"tag_name\":\"v2\"}"), true).getString("tag_name"));
    }

    private static okhttp3.Call response(int code, String body) {
        okhttp3.OkHttpClient client = new okhttp3.OkHttpClient.Builder().addInterceptor(chain ->
                new okhttp3.Response.Builder().request(chain.request()).protocol(okhttp3.Protocol.HTTP_1_1)
                        .code(code).message("fixture").body(okhttp3.ResponseBody.create(okhttp3.MediaType.parse("application/json"), body)).build()).build();
        return client.newCall(new okhttp3.Request.Builder().url("https://example.invalid/").build());
    }

    @Test public void searchEncodesUserTextAndBodyLimitAppliesWithoutContentLength() throws Exception {
        HttpUrl url = SettingsCatalog.searchUrl("中文 &from=999 #", "theme", 20);
        assertEquals("20", url.queryParameter("from"));
        assertEquals("keywords:pi-package keywords:theme 中文 &from=999 #", url.queryParameter("text"));
        assertNull(url.fragment());
        assertEquals(3, url.querySize());
        assertEquals("{\"total\":0}", SettingsCatalog.readBounded(new ByteArrayInputStream("{\"total\":0}".getBytes(StandardCharsets.UTF_8))));
        assertEquals(SettingsCatalog.MAX_BYTES, SettingsCatalog.readBounded(new ByteArrayInputStream(new byte[SettingsCatalog.MAX_BYTES])).length());
        assertThrows(IOException.class, () -> SettingsCatalog.readBounded(new ByteArrayInputStream(new byte[SettingsCatalog.MAX_BYTES + 1])));
    }
}
