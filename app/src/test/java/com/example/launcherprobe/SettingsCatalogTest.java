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

    @Test public void npmInputIsNormalizedWithoutAcceptingOptionsOrCommands() {
        assertEquals("npm:demo", SettingsCatalog.normalizeNpmSource(" demo "));
        assertEquals("npm:@scope/demo@1.2.3-beta.1", SettingsCatalog.normalizeNpmSource("npm:@scope/demo@1.2.3-beta.1"));
        assertEquals("npm:demo@^2.0.0", SettingsCatalog.normalizeNpmSource("demo@^2.0.0"));
        for (String source : new String[]{"", "--help", "npm:", "../demo", "demo;id", "git:owner/repo", "demo | id"})
            assertThrows(IllegalArgumentException.class, () -> SettingsCatalog.normalizeNpmSource(source));
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

    @Test public void catalogSortsAreForwardedBeforePagination() {
        for (String sort : new String[]{"downloads", "recent", "name"}) {
            HttpUrl url = SettingsCatalog.searchUrl("memory", "extension", sort, 100);
            assertEquals(sort.equals("downloads") ? null : sort, url.queryParameter("sort"));
            assertEquals("3", url.queryParameter("page"));
        }
        assertEquals("https://pi.dev/packages", SettingsCatalog.searchUrl("  ", "", "downloads", -10).toString());
        assertEquals("https://pi.dev/packages?sort=recent", SettingsCatalog.searchUrl("", "", "recent", 0).toString());
        assertEquals("https://pi.dev/packages?name=memory&type=skill", SettingsCatalog.searchUrl("memory", "skill", "downloads", 0).toString());
        assertThrows(IllegalArgumentException.class, () -> SettingsCatalog.searchUrl("", "", "unknown", 0));
        assertThrows(IllegalArgumentException.class, () -> SettingsCatalog.searchUrl("", "invalid", "name", 0));
    }

    @Test public void catalogPreservesServerOrderAndFilteredPagination() throws Exception {
        String html = "<span class='packages-count'>51-52 / 52 (of 5353)</span>"
                + card("z-package", 300) + card("@author/a-package", 10);
        JSONObject result = SettingsCatalog.readCatalog(response(200, html));
        assertEquals(52, result.getInt("total"));
        assertEquals(50, result.getInt("offset"));
        assertEquals(50, result.getInt("pageSize"));
        assertEquals(2, result.getJSONArray("objects").length());
        JSONObject first = result.getJSONArray("objects").getJSONObject(0);
        assertEquals("z-package", first.getJSONObject("package").getString("name"));
        assertEquals(300, first.getJSONObject("downloads").getLong("monthly"));
        JSONObject item = result.getJSONArray("objects").getJSONObject(1).getJSONObject("package");
        assertEquals("npm:@author/a-package@1.2.3-beta.1", SettingsCatalog.installSource(item));
        assertEquals("Tools & memory <safe>", item.getString("description"));
        assertEquals("Author & co", item.getJSONObject("publisher").getString("username"));
        assertTrue(SettingsCatalog.keyword(item, "extension"));
        assertTrue(SettingsCatalog.keyword(item, "skill"));
    }

    @Test public void emptyCatalogIsDistinctFromUnrecognizedOrIncompleteHtml() throws Exception {
        JSONObject empty = SettingsCatalog.parseCatalog("<span class='packages-count'>0 / 5353</span>");
        assertEquals(0, empty.getInt("total"));
        assertEquals(0, empty.getJSONArray("objects").length());
        assertThrows(IOException.class, () -> SettingsCatalog.parseCatalog("<html>Service unavailable</html>"));
        assertThrows(IOException.class, () -> SettingsCatalog.parseCatalog("<span class='packages-count'>1-2 / 2</span>" + card("demo", 1)));
        assertThrows(IllegalArgumentException.class, () -> SettingsCatalog.parseCatalog("<span class='packages-count'>1-1 / 1</span>" + card("--help", 1)));
        assertThrows(IOException.class, () -> SettingsCatalog.readCatalog(response(403, "Denied")));
    }

    private static String card(String name, long downloads) {
        return "<article data-package-card='true' data-package-name='" + name + "' data-package-types='extension skill' data-package-downloads='" + downloads + "'>"
                + "<div class='packages-card-body'><p class='packages-desc'>Tools &amp; memory &lt;safe&gt;</p>"
                + "<div class='packages-meta'><span>Author &amp; co</span><span>1K/mo</span></div>"
                + "<div class='packages-links'><a href='https://github.com/earendil-works/pi/issues/new?package-name=" + name + "&amp;package-version=1.2.3-beta.1'>report</a></div></div></article>";
    }

    @Test public void searchEncodesUserTextAndBodyLimitAppliesWithoutContentLength() throws Exception {
        HttpUrl url = SettingsCatalog.searchUrl("中文 &page=999 #", "theme", "name", 50);
        assertEquals("pi.dev", url.host());
        assertEquals("/packages", url.encodedPath());
        assertEquals("2", url.queryParameter("page"));
        assertEquals("中文 &page=999 #", url.queryParameter("name"));
        assertEquals("theme", url.queryParameter("type"));
        assertEquals("name", url.queryParameter("sort"));
        assertNull(url.fragment());
        assertEquals(4, url.querySize());
        assertEquals("{\"total\":0}", SettingsCatalog.readBounded(new ByteArrayInputStream("{\"total\":0}".getBytes(StandardCharsets.UTF_8))));
        assertEquals(SettingsCatalog.MAX_BYTES, SettingsCatalog.readBounded(new ByteArrayInputStream(new byte[SettingsCatalog.MAX_BYTES])).length());
        assertThrows(IOException.class, () -> SettingsCatalog.readBounded(new ByteArrayInputStream(new byte[SettingsCatalog.MAX_BYTES + 1])));
    }
}
