package com.example.launcherprobe;

import static org.junit.Assert.*;
import android.content.Context;
import org.json.JSONObject;
import org.json.JSONArray;
import org.junit.Before;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implements;
import org.robolectric.annotation.Implementation;
import org.robolectric.util.ReflectionHelpers;
import java.util.List;
import java.util.Collections;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ExecutorService;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, instrumentedPackages = "com.example.launcherprobe",
        shadows = {HostAtomicFile.class, TaskExecutionRecoveryTest.BridgeShadow.class})
public class TaskExecutionRecoveryTest {
    Context context;
    ChatCoordinator coordinator;
    @Before public void setup() {
        context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("chat", Context.MODE_PRIVATE).edit().clear().commit();
        context.getSharedPreferences("chat_submissions", Context.MODE_PRIVATE).edit().clear().commit();
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
        ReflectionHelpers.setStaticField(ChatExecutionService.class, "foreground", false);
        ReflectionHelpers.setStaticField(ChatExecutionService.class, "activeCount", 0);
        coordinator = ChatCoordinator.get(context);
        BridgeShadow.prompts = 0;
        BridgeShadow.started = new CountDownLatch(1);
    }
    @After public void cleanup() throws Exception {
        ExecutorService executor = ReflectionHelpers.getField(coordinator, "executor");
        executor.shutdownNow();
        assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS));
        ChatExecutionService.setActiveCount(context, 0);
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
    }
    private ChatCoordinator.SessionRun interruptedTool() throws Exception {
        ChatStore store = coordinator.store();
        store.save(List.of(new AgentLoop.Message("user", "user", "Send payment once", null, Collections.emptyList(), false)));
        ChatCoordinator.SessionRun run = coordinator.registerRun(store.activeId(), null);
        run.persistence = new PiTurnPersistence(store, store.activeId(), "user", "reply", store.load());
        coordinator.onPiEvent(new JSONObject().put("type","message").put("message", new JSONObject()
                .put("role","assistant").put("content","").put("toolCalls",new JSONArray().put(new JSONObject()
                .put("id","call").put("name","pay").put("arguments","{}")))),run);
        coordinator.onPiEvent(new JSONObject().put("type","tool_start").put("toolCallId","call").put("name","pay"),run);
        return run;
    }
    private void reopen() {
        ExecutorService old = ReflectionHelpers.getField(coordinator, "executor");
        old.shutdownNow();
        ReflectionHelpers.setStaticField(ChatCoordinator.class, "instance", null);
        coordinator = ChatCoordinator.get(context);
    }
    @Test public void processDeathIsSurfacedWithoutRestartingOrReplaying() throws Exception {
        interruptedTool();
        String id = coordinator.store().activeId();
        new ChatStore(context);
        assertEquals("running", context.getSharedPreferences("chat",0).getString("run_status_"+id,""));
        assertTrue(coordinator.running(id));
        reopen();
        JSONObject snapshot = coordinator.snapshot();
        assertFalse(snapshot.getBoolean("running"));
        assertEquals("interrupted",snapshot.getJSONObject("execution").getString("phase"));
        assertEquals("pay",snapshot.getJSONObject("execution").getString("toolName"));
        assertTrue(snapshot.getJSONObject("recovery").getBoolean("needed"));
        assertTrue(snapshot.getString("error").contains("工具可能已完成"));
        assertEquals(0,BridgeShadow.prompts);
        assertEquals("运行已中断 · 查看对话恢复",TaskCardModel.status(coordinator.taskCard(id)));
        assertThrows(Exception.class,()->coordinator.store().piResume(coordinator.store().load()));
    }
    @Test public void recoveryRequiresExplicitSelectedLeafAndPreservesDraftAndUnknownTool() throws Exception {
        interruptedTool(); reopen();
        ChatStore store=coordinator.store();
        String id=store.activeId(),leaf=store.tree(id).leaf();
        store.saveDraft("My next instruction");
        assertThrows(IllegalStateException.class,()->coordinator.prepareRecovery(id,"stale"));
        coordinator.prepareRecovery(id,leaf);
        coordinator.prepareRecovery(id,leaf);
        assertEquals("My next instruction",store.draft());
        assertEquals(0,BridgeShadow.prompts);
        assertEquals(leaf,store.tree(id).leaf());
        List<AgentLoop.Message> acknowledged=store.load();
        store.selectNode(id,"user");
        assertThrows(IllegalStateException.class,()->store.piResume(id,acknowledged,true));
        assertThrows(IllegalStateException.class,()->store.piResume(id,store.load(),true));
        store.selectNode(id,leaf);
        assertTrue(context.getSharedPreferences("chat",0).getBoolean("pi_pending_"+id+"_user",false));
        String request=coordinator.send(id,"Inspect the current state","recovery-submission");
        assertTrue(BridgeShadow.started.await(5,TimeUnit.SECONDS));
        assertNotNull(request);
        assertEquals(1,BridgeShadow.prompts);
        assertTrue(BridgeShadow.prompt.contains(ChatStore.RECOVERY_PROMPT));
        assertTrue(BridgeShadow.prompt.endsWith("Inspect the current state"));
        assertFalse(BridgeShadow.prompt.contains("Send payment once"));
        assertTrue(ChatStore.piHistory(BridgeShadow.prior).toString().contains("历史工具调用（未重新执行）"));
        assertFalse(store.recoveryPrepared(id));
        assertThrows(IllegalStateException.class,()->coordinator.prepareRecovery(id,leaf));
        assertThrows(IllegalStateException.class,()->coordinator.send(id,"Inspect the current state","recovery-submission"));
        assertEquals(1,BridgeShadow.prompts);
        java.util.Map<String,ChatCoordinator.SessionRun> runs=ReflectionHelpers.getField(coordinator,"activeRuns");
        ChatCoordinator.SessionRun recovered=runs.get(id);
        coordinator.onPiEvent(new JSONObject().put("type","message").put("message",new JSONObject()
                .put("role","assistant").put("content","Checked; awaiting confirmation")),recovered);
        coordinator.onPiEvent(new JSONObject().put("type","context").put("entries",new JSONArray()
                .put(new JSONObject().put("type","session").put("id","recovered").put("version",3))),recovered);
        coordinator.onPiEvent(new JSONObject().put("type","end").put("status","completed"),recovered);
        assertFalse(store.needsRecovery(id));
        assertNotNull(store.piResume(store.load()));
        assertTrue(context.getSharedPreferences("chat",0).getBoolean("pi_pending_"+id+"_user",false));
        assertNull(coordinator.send(id,"Inspect the current state","recovery-submission"));
        assertEquals(1,BridgeShadow.prompts);
        String recoveredLeaf=store.tree(id).leaf();
        store.selectNode(id,leaf);
        assertTrue(store.needsRecovery(id));
        assertThrows(Exception.class,()->store.piResume(store.load()));
        store.selectNode(id,recoveredLeaf);
        assertFalse(store.needsRecovery(id));
    }
    @Test public void lostRuntimeBeforeAnyObservedToolStillRequiresAcknowledgement() throws Exception {
        ChatStore store=coordinator.store();
        store.save(List.of(new AgentLoop.Message("unobserved-user","user","External request",null,Collections.emptyList(),false)));
        String id=store.activeId();
        ChatCoordinator.SessionRun run=coordinator.registerRun(id,null);
        run.persistence=new PiTurnPersistence(store,id,"unobserved-user","unobserved-reply",store.load());
        coordinator.onPiEvent(new JSONObject().put("type","error").put("reason","runtime_disconnected").put("message","Disconnected"),run);
        coordinator.onPiEvent(new JSONObject().put("type","end").put("status","error"),run);
        assertTrue(store.needsRecovery(id));
        assertTrue(context.getSharedPreferences("chat",0).getBoolean("pi_pending_"+id+"_unobserved-user",false));
        assertThrows(IllegalStateException.class,()->coordinator.send(id,"Continue",null));
        assertEquals("interrupted",coordinator.snapshot().getJSONObject("execution").getString("phase"));
        assertEquals(0,BridgeShadow.prompts);
        coordinator.prepareRecovery(id,store.tree(id).leaf());
        assertEquals(0,BridgeShadow.prompts);
        assertTrue(store.recoveryPrepared(id));
    }
    @Test public void phasesAndWaitsTrackEventsAndStopRejectsLateRetry() throws Exception {
        TaskExecutionState state=new TaskExecutionState();
        state.accept(new JSONObject().put("type","status").put("phase","thinking"));
        assertEquals("thinking",state.snapshot().getString("phase"));
        state.accept(new JSONObject().put("type","tool_start").put("toolCallId","a").put("name","shower"));
        state.accept(new JSONObject().put("type","tool_end").put("toolCallId","old"));
        assertEquals("tool",state.snapshot().getString("phase"));
        state.accept(new JSONObject().put("type","shower_wait").put("callId","wait").put("waiting",true));
        assertEquals("waiting_shower",state.snapshot().getString("phase"));
        state.accept(new JSONObject().put("type","shower_wait").put("callId","old").put("waiting",false));
        assertEquals("waiting_shower",state.snapshot().getString("phase"));
        state.accept(new JSONObject().put("type","shower_wait").put("callId","wait").put("waiting",false));
        state.accept(new JSONObject().put("type","tool_end").put("toolCallId","a"));
        assertEquals("thinking",state.snapshot().getString("phase"));
        state.accept(new JSONObject().put("type","status").put("phase","retrying").put("attempt",2).put("maxAttempts",3));
        assertTrue(state.snapshot().getString("message").contains("2/3"));
        state.stop();
        state.accept(new JSONObject().put("type","status").put("phase","retrying"));
        assertEquals("stopping",state.snapshot().getString("phase"));
        state.finish("interrupted");
        state.accept(new JSONObject().put("type","text_delta").put("delta","late"));
        assertEquals("interrupted",state.snapshot().getString("phase"));
    }
    @Test public void lateOldRunCannotChangeNewStatusOrClearRecovery() throws Exception {
        ChatCoordinator.SessionRun old=interruptedTool();
        coordinator.onPiEvent(new JSONObject().put("type","end").put("status","error"),old);
        String id=coordinator.store().activeId();
        ChatCoordinator.SessionRun next=coordinator.registerRun(id,null);
        coordinator.onPiEvent(new JSONObject().put("type","status").put("phase","retrying"),old);
        coordinator.finish(old,"completed","");
        assertTrue(coordinator.running(id));
        assertEquals(next.requestId,coordinator.snapshot().getString("requestId"));
        assertEquals("starting",coordinator.snapshot().getJSONObject("execution").getString("phase"));
        coordinator.cancel(id);
        assertEquals("stopping",coordinator.snapshot().getJSONObject("execution").getString("phase"));
        coordinator.onPiEvent(new JSONObject().put("type","status").put("phase","retrying"),next);
        assertEquals("stopping",coordinator.snapshot().getJSONObject("execution").getString("phase"));
        assertEquals("stopping",coordinator.snapshot().getJSONArray("activeRuns").getJSONObject(0).getString("status"));
    }
    @Implements(value=PiAgentBridge.class,isInAndroidSdk=false)
    public static class BridgeShadow {
        static int prompts;
        static String prompt;
        static List<AgentLoop.Message> prior;
        static CountDownLatch started;
        @Implementation protected void __constructor__(Context context) { }
        @Implementation protected static PiAgentBridge get(Context context) {
            return ReflectionHelpers.callConstructor(PiAgentBridge.class,ReflectionHelpers.ClassParameter.from(Context.class,context));
        }
        @Implementation protected void prompt(String id,String conversationId,String configuration,String text,
                List<ChatAttachment> files,String sdkHistory,List<AgentLoop.Message> history,
                PiConfigStore store,PiAgentBridge.Listener listener) {
            prompts++; prompt=text; prior=history; started.countDown();
        }
        @Implementation protected void abort(String request) { }
    }
}
