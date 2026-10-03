package com.example.launcherprobe;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import static org.junit.Assert.assertEquals;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class MinimumAndroidVersionTest {
    @Test public void packageDeclaresAndroid13MinimumWithoutChangingTarget() {
        var info = RuntimeEnvironment.getApplication().getApplicationInfo();
        assertEquals(33, info.minSdkVersion);
        assertEquals(36, info.targetSdkVersion);
    }
}
