package com.example.launcherprobe;

import java.nio.file.Files;
import java.nio.file.Path;
import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.xpath.XPath;
import javax.xml.xpath.XPathFactory;
import org.junit.Before;
import org.junit.Test;
import org.w3c.dom.Document;
import static org.junit.Assert.*;

public class AssistantManifestTest {
    private Document manifest;
    private XPath xpath;

    @Before public void loadManifest() throws Exception {
        Path source = Path.of("src/main/AndroidManifest.xml");
        if (!Files.isRegularFile(source)) source = Path.of("app/src/main/AndroidManifest.xml");
        manifest = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(source.toFile());
        xpath = XPathFactory.newInstance().newXPath();
    }

    @Test public void onlyOrdinaryAssistantEntryRemainsWithoutHomeOrWidgetHosting() throws Exception {
        assertEquals("1", value("count(/manifest/application/activity[@android:name='.MainActivity']/intent-filter)"));
        present("/manifest/application/activity[@android:name='.MainActivity']/intent-filter/action[@android:name='android.intent.action.MAIN']");
        present("/manifest/application/activity[@android:name='.MainActivity']/intent-filter/category[@android:name='android.intent.category.LAUNCHER']");
        absent("//category[@android:name='android.intent.category.HOME']");
        absent("//action[@android:name='android.content.pm.action.CONFIRM_PIN_SHORTCUT']");
        absent("//service[@android:permission='android.permission.BIND_ACCESSIBILITY_SERVICE']");
        absent("//activity[@android:name='.AppSwitcherActivity' or @android:name='.DesktopSettingsActivity']");
        absent("//uses-permission[@android:name='android.permission.KILL_BACKGROUND_PROCESSES' or @android:name='android.permission.BIND_APPWIDGET']");
        present("/manifest/queries/intent/category[@android:name='android.intent.category.LAUNCHER']");
        present("//uses-permission[@android:name='android.permission.WRITE_SECURE_SETTINGS']");
    }

    @Test public void widgetIsPrivateAndRegisteredForSystemUpdates() throws Exception {
        String widget = "/manifest/application/receiver[@android:name='.TaskWidgetProvider']";
        assertEquals("false", value("string(" + widget + "/@android:exported)"));
        present(widget + "/intent-filter/action[@android:name='android.appwidget.action.APPWIDGET_UPDATE']");
        present(widget + "/meta-data[@android:name='android.appwidget.provider' and @android:resource='@xml/task_widget_info']");
    }

    @Test public void voiceShareShizukuAndBackgroundTaskIdentityArePreserved() throws Exception {
        for (String name : new String[] {"LauncherVoiceInteractionService", "LauncherVoiceSessionService",
                "LauncherRecognitionService", "WakeWordService", "ChatExecutionService"}) {
            present("/manifest/application/service[@android:name='." + name + "']");
        }
        present("//service[@android:name='.LauncherVoiceInteractionService' and @android:permission='android.permission.BIND_VOICE_INTERACTION']");
        present("//service[@android:name='.LauncherVoiceSessionService' and @android:permission='android.permission.BIND_VOICE_INTERACTION']");
        present("//provider[@android:name='rikka.shizuku.ShizukuProvider' and @android:permission='android.permission.INTERACT_ACROSS_USERS_FULL']");
        present("//activity[@android:name='.ShareReceiverActivity']/intent-filter/action[@android:name='android.intent.action.SEND']");
        present("//activity[@android:name='.ShareReceiverActivity']/intent-filter/action[@android:name='android.intent.action.SEND_MULTIPLE']");
        present("//activity[@android:name='.ShareReceiverActivity']/intent-filter/action[@android:name='android.intent.action.PROCESS_TEXT']");
        present("//receiver[@android:name='.ScheduledTaskReceiver']/intent-filter/action[@android:name='android.intent.action.BOOT_COMPLETED']");
        present("//uses-permission[@android:name='android.permission.SCHEDULE_EXACT_ALARM']");
        present("//uses-permission[@android:name='android.permission.POST_NOTIFICATIONS']");
    }

    private void present(String expression) throws Exception { assertNotEquals(expression, "0", value("count(" + expression + ")")); }
    private void absent(String expression) throws Exception { assertEquals(expression, "0", value("count(" + expression + ")")); }
    private String value(String expression) throws Exception {
        // Namespace-unaware DOM keeps the literal android: prefix in attributes.
        return xpath.evaluate(expression.replaceAll("@android:([A-Za-z]+)", "@*[name()='android:$1']"), manifest);
    }
}
