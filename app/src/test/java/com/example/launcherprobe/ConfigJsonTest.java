package com.example.launcherprobe;

import java.io.IOException;
import java.util.Arrays;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class ConfigJsonTest {
    @Test public void settingValuesAcceptEveryJsonTypeWithoutLosingNumberPrecision() throws Exception {
        assertEquals("titles/small-model", ConfigJson.parse("\"titles/small-model\""));
        assertEquals("", ConfigJson.parse("\"\""));
        assertEquals(Boolean.TRUE, ConfigJson.parse("true"));
        assertEquals(Boolean.FALSE, ConfigJson.parse("false"));
        assertNull(ConfigJson.parse("null"));
        assertEquals("12345678901234567890.123e+8", ConfigJson.parse("12345678901234567890.123e+8").toString());
        assertEquals(Arrays.asList("a", "b"), ConfigJson.parse("[\"a\",\"b\"]"));
        assertEquals("value", ConfigJson.object("{\"key\":\"value\"}").get("key"));
    }

    @Test public void parsingStillRejectsInvalidJsonAndMultipleValues() {
        for (String source : new String[]{"", " ", "bare text", "true false", "true,false", "{} {}",
                "1]", "[1,]", "//comment\ntrue", "{\"a\":1,\"a\":2}", "{unquoted:1}"}) {
            assertThrows(source, IOException.class, () -> ConfigJson.parse(source));
        }
        assertThrows(IOException.class, () -> ConfigJson.object("\"not a settings document\""));
        assertThrows(IOException.class, () -> ConfigJson.format("[]"));
    }
}
