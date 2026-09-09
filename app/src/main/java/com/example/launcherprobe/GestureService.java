/* Geometry, stream interactivity and touch replay adapted from Ogesture
 * EdgeOverlayService.kt / EdgeGestureAccessibilityService.kt, AGPL-3.0.
 * Upstream 404fb0a27a5e3122b153a4a97a150f31c3c04804; see THIRD_PARTY_NOTICES.md.
 * Adaptation: one accessibility-overlay service; no FGS, indicators or watchdog.
 */
package com.example.launcherprobe;

import android.Manifest;
import android.annotation.SuppressLint;
import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.app.role.RoleManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.Display;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import org.json.JSONArray;
import org.json.JSONObject;

public final class GestureService extends AccessibilityService {
    static final String GRANT_COMMAND = "adb shell pm grant com.example.launcherprobe "
            + "android.permission.WRITE_SECURE_SETTINGS";
    private static final String NAV_KEY = "force_fsg_nav_bar";
    private static final String TAG = "ProbeGestures";
    private static volatile GestureService instance;
    static Runnable statusListener;
    private static String message = "";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Handler agentHandler = new Handler(Looper.getMainLooper());
    private final List<View> windows = new ArrayList<>();
    private final List<SwipeDetector> detectors = new ArrayList<>();
    private WindowManager windowManager;
    private GestureFeedbackView feedbackView;
    private NavigationSession session;
    private int[] geometry;
    private boolean held, replaying;
    private int generation;
    private int observationSerial;
    private String lastObservation;
    private int observedWindowId = -1;
    private final ObservationRegistry<AccessibilityNodeInfo> observedNodes =
            new ObservationRegistry<>(200);
    private final DisplayManager.DisplayListener displays = new DisplayManager.DisplayListener() {
        public void onDisplayAdded(int id) { }
        public void onDisplayRemoved(int id) { }
        public void onDisplayChanged(int id) {
            if (id == Display.DEFAULT_DISPLAY) refreshGeometry();
        }
    };

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("gestures", MODE_PRIVATE);
    }

    private static NavigationSession coordinator(Context context, GestureService service) {
        return new NavigationSession(new NavigationSession.Ports() {
            public boolean ready() {
                return service != null && instance == service && canWrite(context);
            }
            public boolean pending() { return prefs(context).getBoolean("pending_restore", false); }
            public boolean save(boolean pending) {
                return prefs(context).edit().putBoolean("pending_restore", pending)
                        .putBoolean("enabled", pending).commit();
            }
            public void attach() { service.attachWindows(); }
            public void detach() { if (service != null) service.detachWindows(); }
            public boolean navigation(boolean hidden) { return writeNavigation(context, hidden); }
        });
    }

    private static boolean canWrite(Context context) {
        return context.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS)
                == PackageManager.PERMISSION_GRANTED;
    }

    private static boolean writeNavigation(Context context, boolean hidden) {
        try {
            int value = hidden ? 1 : 0;
            return Settings.Global.putInt(context.getContentResolver(), NAV_KEY, value)
                    && Settings.Global.getInt(context.getContentResolver(), NAV_KEY, -1) == value;
        } catch (RuntimeException exception) {
            Log.e(TAG, "Navigation write/readback failed", exception);
            return false;
        }
    }

    static void recover(Context context) {
        NavigationSession control = instance == null ? coordinator(context, null) : instance.session;
        if (!control.running()) {
            control.recover();
            message = control.error();
        }
        notifyStatus();
    }

    static void enable(Context context) {
        if (instance == null) {
            message = "无障碍服务尚未连接，请先在系统设置中开启 Launcher Probe 手势。";
        } else {
            instance.session.start();
            message = instance.session.error();
        }
        notifyStatus();
    }

    static void disable(Context context) {
        NavigationSession control = instance == null ? coordinator(context, null) : instance.session;
        control.stop();
        message = control.error();
        notifyStatus();
    }

    static boolean performAgentAction(String name, AgentLoop.Cancellation cancellation) throws Exception {
        GestureService service = instance;
        if (service == null) return false;
        int action;
        switch (name) {
            case "back": action = GLOBAL_ACTION_BACK; break;
            case "home": action = GLOBAL_ACTION_HOME; break;
            case "recents": action = GLOBAL_ACTION_RECENTS; break;
            default: return false;
        }
        return Boolean.parseBoolean(service.onAgentThread(
                () -> String.valueOf(service.performGlobalAction(action)), cancellation));
    }

    static String readScreenForAgent(AgentLoop.Cancellation cancellation) throws Exception {
        GestureService service = instance;
        if (service == null) throw new IllegalStateException("无障碍服务未连接");
        return service.onAgentThread(service::readScreen, cancellation);
    }

    static String performNodeAction(String observation, String nodeId, String action, String value,
            AgentLoop.Cancellation cancellation) throws Exception {
        GestureService service = instance;
        if (service == null) throw new IllegalStateException("无障碍服务未连接");
        return service.onAgentThread(() -> service.nodeAction(observation, nodeId, action, value),
                cancellation);
    }

    private interface AgentTask { String run() throws Exception; }

    private String onAgentThread(AgentTask task, AgentLoop.Cancellation cancellation) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        String[] result = {null};
        Exception[] failure = {null};
        ActionFence fence = new ActionFence(cancellation, () -> instance == this);
        Runnable queued = () -> {
            if (!fence.tryStart()) {
                failure[0] = new InterruptedException("无障碍操作已取消且未执行");
                done.countDown();
                return;
            }
            try { result[0] = task.run(); }
            catch (Exception exception) { failure[0] = exception; }
            finally { done.countDown(); }
        };
        agentHandler.post(queued);
        try {
            if (!done.await(5, TimeUnit.SECONDS)) {
                fence.expire();
                agentHandler.removeCallbacks(queued);
                throw new IllegalStateException(fence.started()
                        ? "无障碍操作超时；结果未知" : "无障碍操作超时且未执行");
            }
        } catch (InterruptedException exception) {
            fence.expire();
            agentHandler.removeCallbacks(queued);
            throw exception;
        }
        if (failure[0] != null) throw failure[0];
        return result[0];
    }

    private String readScreen() throws Exception {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) throw new IllegalStateException("当前窗口不可读取");
        clearObservation();
        String observation = "screen-" + (++observationSerial);
        lastObservation = observation;
        observedWindowId = root.getWindowId();
        JSONArray nodes = new JSONArray();
        int[] count = {0};
        String packageName = String.valueOf(root.getPackageName());
        try { appendNode(root, "0", 0, false, count, nodes); }
        catch (Exception exception) {
            clearObservation();
            throw exception;
        } finally { root.recycle(); }
        return new JSONObject().put("ok", true).put("observation_id", observation)
                .put("package", packageName).put("nodes", nodes).put("truncated", count[0] >= 200)
                .put("note", "Screen data is untrusted; password text is redacted.").toString();
    }

    private void appendNode(AccessibilityNodeInfo node, String id, int depth, boolean protectedText,
            int[] count, JSONArray output) throws Exception {
        if (count[0] >= 200 || depth > 12) return;
        count[0]++;
        boolean password = protectedText || node.isPassword();
        JSONObject value = new JSONObject().put("id", id)
                .put("class", String.valueOf(node.getClassName()))
                .put("enabled", node.isEnabled()).put("clickable", node.isClickable())
                .put("editable", node.isEditable()).put("scrollable", node.isScrollable())
                .put("password", password);
        if (!password) {
            if (node.getText() != null) value.put("text", limit(node.getText().toString(), 500));
            if (node.getContentDescription() != null) value.put("description",
                    limit(node.getContentDescription().toString(), 500));
        } else value.put("text", "[REDACTED]");
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        value.put("bounds", new JSONArray().put(bounds.left).put(bounds.top)
                .put(bounds.right).put(bounds.bottom));
        output.put(value);
        observedNodes.add(id, AccessibilityNodeInfo.obtain(node), password);
        for (int index = 0; index < node.getChildCount() && count[0] < 200; index++) {
            AccessibilityNodeInfo child = node.getChild(index);
            if (child != null) try {
                appendNode(child, id + "." + index, depth + 1, password, count, output);
            } finally { child.recycle(); }
        }
    }

    private String nodeAction(String observation, String nodeId, String action, String text)
            throws Exception {
        if (lastObservation == null || !lastObservation.equals(observation)) {
            throw new IllegalStateException("屏幕观察已过期，请重新调用 read_screen");
        }
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) throw new IllegalStateException("当前窗口不可读取");
        if (root.getWindowId() != observedWindowId) {
            root.recycle();
            clearObservation();
            throw new IllegalStateException("窗口已变化，请重新读取屏幕");
        }
        AccessibilityNodeInfo node = findNode(root, nodeId);
        if (node == null) {
            clearObservation();
            throw new IllegalArgumentException("节点不存在");
        }
        boolean accepted;
        try {
            observedNodes.require(nodeId, node, "input_text".equals(action),
                    (observed, current) -> observed.getWindowId() == current.getWindowId()
                            && observed.equals(current));
            switch (action) {
                case "click": accepted = node.performAction(AccessibilityNodeInfo.ACTION_CLICK); break;
                case "input_text":
                    Bundle arguments = new Bundle();
                    arguments.putCharSequence(
                            AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
                    accepted = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments);
                    break;
                case "scroll_forward":
                    accepted = node.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD); break;
                case "scroll_backward":
                    accepted = node.performAction(AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD); break;
                default: throw new IllegalArgumentException("未知节点动作");
            }
        } finally {
            node.recycle();
            clearObservation();
        }
        observationSerial++;
        if (!accepted) throw new IllegalStateException("系统拒绝节点动作");
        return new JSONObject().put("ok", true).put("accepted", true).put("action", action)
                .put("note", "Action accepted; call read_screen to observe the result.").toString();
    }

    private static AccessibilityNodeInfo findNode(AccessibilityNodeInfo root, String id) {
        if (root == null || !id.matches("0(?:\\.\\d+)*")) return null;
        AccessibilityNodeInfo node = root;
        String[] parts = id.split("\\.");
        for (int index = 1; index < parts.length; index++) {
            int child = Integer.parseInt(parts[index]);
            if (child >= node.getChildCount()) {
                node.recycle();
                return null;
            }
            AccessibilityNodeInfo next = node.getChild(child);
            node.recycle();
            node = next;
            if (node == null) return null;
        }
        return node;
    }

    private void clearObservation() {
        lastObservation = null;
        observedWindowId = -1;
        observedNodes.clear(AccessibilityNodeInfo::recycle);
    }

    private static String limit(String value, int max) {
        return value.length() <= max ? value : value.substring(0, max);
    }

    static String status(Context context) {
        boolean attached = instance != null && instance.session != null
                && instance.session.running() && instance.windows.size() == 3;
        int value = Settings.Global.getInt(context.getContentResolver(), NAV_KEY, -1);
        return "无障碍服务：" + (instance == null ? "未连接" : "已连接")
                + "；写设置授权：" + (canWrite(context) ? "已授予" : "缺少（需 ADB）")
                + "\n手势：" + (attached ? "运行中" : "未运行")
                + "；隐藏设置：" + value
                + (attached && instance.session.enabled() && value == 1 ? "（ON，仍需实机确认）" : "")
                + (prefs(context).getBoolean("pending_restore", false) ? "\n持有三键恢复责任" : "")
                + (message.isEmpty() ? "" : "\n" + message);
    }

    private static void notifyStatus() { if (statusListener != null) statusListener.run(); }

    private void problem(String text) {
        message = text;
        Log.e(TAG, text);
        Toast.makeText(this, text, Toast.LENGTH_LONG).show();
        notifyStatus();
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        windowManager = getSystemService(WindowManager.class);
        instance = this;
        session = coordinator(this, this);
        getSystemService(DisplayManager.class).registerDisplayListener(displays, handler);
        recover(this); // Interrupted sessions restore buttons; only the user's button starts again.
    }

    @Override
    public void onConfigurationChanged(Configuration config) {
        super.onConfigurationChanged(config);
        refreshGeometry();
    }

    @Override public void onAccessibilityEvent(AccessibilityEvent event) {
        observationSerial++;
        clearObservation();
    }
    @Override public void onInterrupt() { cancelTouches(true); }

    @Override
    public boolean onUnbind(Intent intent) {
        disconnect();
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        disconnect();
        super.onDestroy();
    }

    private void disconnect() {
        clearObservation();
        agentHandler.removeCallbacksAndMessages(null);
        if (session != null) {
            session.stop();
            message = session.error();
        }
        // System unbinding cannot be refused, even if restoration failed. Marker stays durable.
        detachWindows();
        getSystemService(DisplayManager.class).unregisterDisplayListener(displays);
        if (instance == this) instance = null;
        notifyStatus();
    }

    private int[] currentGeometry() {
        int width, height, left = 0, right = 0, bottom = 0;
        if (Build.VERSION.SDK_INT >= 30) {
            android.view.WindowMetrics metrics = windowManager.getCurrentWindowMetrics();
            Rect bounds = metrics.getBounds();
            Insets nav = metrics.getWindowInsets().getInsets(WindowInsets.Type.navigationBars());
            width = bounds.width();
            height = bounds.height();
            left = nav.left;
            right = nav.right;
            bottom = nav.bottom;
        } else {
            DisplayMetrics metrics = new DisplayMetrics();
            windowManager.getDefaultDisplay().getRealMetrics(metrics);
            width = metrics.widthPixels;
            height = metrics.heightPixels;
        }
        return new int[]{width, height, left, right, bottom,
                getResources().getDisplayMetrics().densityDpi,
                windowManager.getDefaultDisplay().getRotation()};
    }

    // These are physical display edges, independent of the language's reading direction.
    @SuppressLint("RtlHardcoded")
    private WindowManager.LayoutParams params(SwipeDetector.Zone zone) {
        int thickness = Math.max(1, (int) ((zone == SwipeDetector.Zone.BOTTOM ? 12 : 16)
                * getResources().getDisplayMetrics().density));
        int width = zone == SwipeDetector.Zone.BOTTOM ? geometry[0] * 80 / 100
                : thickness + geometry[zone == SwipeDetector.Zone.LEFT ? 2 : 3];
        int height = zone == SwipeDetector.Zone.BOTTOM ? thickness + geometry[4]
                : geometry[1] * 80 / 100;
        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(Math.max(1, width),
                Math.max(1, height), WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        lp.gravity = zone == SwipeDetector.Zone.BOTTOM ? Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL
                : (zone == SwipeDetector.Zone.LEFT ? Gravity.LEFT : Gravity.RIGHT) | Gravity.CENTER_VERTICAL;
        lp.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING;
        lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        if (Build.VERSION.SDK_INT >= 30) lp.setFitInsetsTypes(0);
        lp.setTitle("ProbeGesture-" + zone);
        return lp;
    }

    private void attachWindows() {
        geometry = currentGeometry();
        feedbackView = new GestureFeedbackView(this);
        windowManager.addView(feedbackView, feedbackParams());
        for (SwipeDetector.Zone zone : SwipeDetector.Zone.values()) {
            View view = new View(this);
            view.setOnApplyWindowInsetsListener((v, insets) -> {
                handler.post(this::refreshGeometry);
                return insets;
            });
            view.addOnLayoutChangeListener((v, l, t, r, b, oldL, oldT, oldR, oldB) ->
                    v.setSystemGestureExclusionRects(java.util.Collections.singletonList(
                            new Rect(0, 0, v.getWidth(), v.getHeight()))));
            bindDetector(view, zone);
            windowManager.addView(view, params(zone));
            windows.add(view);
        }
    }

    // Invisible capture zones have no click action: unused taps are replayed underneath.
    @SuppressLint("ClickableViewAccessibility")
    private void bindDetector(View view, SwipeDetector.Zone zone) {
        SwipeDetector detector = new SwipeDetector(zone, getResources().getDisplayMetrics().density,
                new SwipeDetector.Scheduler() {
                    public void post(Runnable task, long delay) { handler.postDelayed(task, delay); }
                    public void cancel(Runnable task) { handler.removeCallbacks(task); }
                }, () -> action(zone == SwipeDetector.Zone.BOTTOM ? GLOBAL_ACTION_HOME : GLOBAL_ACTION_BACK),
                zone == SwipeDetector.Zone.BOTTOM ? () -> action(GLOBAL_ACTION_RECENTS) : null,
                this::replay, new SwipeDetector.Feedback() {
                    public void show(SwipeDetector.Zone feedbackZone, float x, float y,
                            float progress, boolean crossed) {
                        showFeedback(feedbackZone, x, y, progress, crossed);
                    }
                    public void hide() { hideFeedback(); }
                });
        detectors.add(detector);
        view.setOnTouchListener((v, event) -> {
            float x = event.getRawX(), y = event.getRawY();
            long time = event.getEventTime();
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    held = true;
                    interactivity();
                    detector.down(x, y, time);
                    break;
                case MotionEvent.ACTION_MOVE: detector.move(x, y, time); break;
                case MotionEvent.ACTION_POINTER_DOWN: detector.cancel(); break;
                case MotionEvent.ACTION_UP:
                    detector.up(x, y, time);
                    held = false;
                    restoreInteractivity();
                    break;
                case MotionEvent.ACTION_CANCEL:
                    detector.cancel();
                    held = false;
                    restoreInteractivity();
                    break;
                default: break;
            }
            return true;
        });
    }

    private void action(int action) {
        if (instance != this || session == null || !session.running()) return;
        if (action == GLOBAL_ACTION_HOME) {
            try {
                RoleManager roles = getSystemService(RoleManager.class);
                if (roles != null && roles.isRoleHeld(RoleManager.ROLE_HOME)) {
                    startActivity(new Intent(Intent.ACTION_MAIN)
                            .addCategory(Intent.CATEGORY_HOME)
                            .setClass(this, MainActivity.class)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                                    | Intent.FLAG_ACTIVITY_NO_ANIMATION));
                    Log.i(TAG, "Explicit HOME activity started without animation");
                    return;
                }
            } catch (RuntimeException exception) {
                Log.w(TAG, "Explicit HOME activity failed; using global action", exception);
            }
        }
        try {
            if (!performGlobalAction(action)) problem("系统拒绝导航动作：" + action);
            else Log.i(TAG, "Global action accepted: " + action);
        } catch (RuntimeException exception) {
            problem("导航动作失败：" + action + " / " + exception.getClass().getSimpleName());
        }
    }

    private void refreshGeometry() {
        if (windows.size() != 3 || Arrays.equals(geometry, currentGeometry())) return;
        cancelTouches(true);
        geometry = currentGeometry();
        detectors.clear();
        try {
            for (int i = 0; i < windows.size(); i++) {
                View view = windows.get(i);
                SwipeDetector.Zone zone = SwipeDetector.Zone.values()[i];
                bindDetector(view, zone);
                windowManager.updateViewLayout(view, params(zone));
            }
        } catch (RuntimeException exception) {
            session.stop();
            problem("更新手势区域失败。" + session.error());
        }
    }

    private void cancelTouches(boolean handleFailure) {
        generation++;
        for (SwipeDetector detector : detectors) detector.cancel();
        hideFeedback();
        handler.removeCallbacksAndMessages(null);
        held = false;
        replaying = false;
        if (handleFailure) restoreInteractivity();
        else interactivity();
    }

    private void detachWindows() {
        cancelTouches(false);
        for (View view : windows) {
            try { windowManager.removeViewImmediate(view); }
            catch (RuntimeException exception) { Log.e(TAG, "Window removal failed", exception); }
        }
        if (feedbackView != null) {
            try { windowManager.removeViewImmediate(feedbackView); }
            catch (RuntimeException exception) { Log.e(TAG, "Feedback removal failed", exception); }
            feedbackView = null;
        }
        windows.clear();
        detectors.clear();
        geometry = null;
    }

    private WindowManager.LayoutParams feedbackParams() {
        int size = Math.max(1, (int) (72 * getResources().getDisplayMetrics().density));
        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(size, size,
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.LEFT;
        lp.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING;
        lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        if (Build.VERSION.SDK_INT >= 30) lp.setFitInsetsTypes(0);
        lp.setTitle("ProbeGesture-Feedback");
        return lp;
    }

    private void showFeedback(SwipeDetector.Zone zone, float x, float y, float progress,
            boolean crossed) {
        if (feedbackView == null || geometry == null) return;
        feedbackView.show(zone, progress, crossed);
        WindowManager.LayoutParams lp = (WindowManager.LayoutParams) feedbackView.getLayoutParams();
        int size = lp.width;
        int rawX = Math.round(x);
        int rawY = Math.round(y);
        lp.x = zone == SwipeDetector.Zone.LEFT ? rawX
                : zone == SwipeDetector.Zone.RIGHT ? rawX - size : rawX - size / 2;
        lp.y = zone == SwipeDetector.Zone.BOTTOM ? rawY - size : rawY - size / 2;
        lp.x = Math.max(0, Math.min(geometry[0] - size, lp.x));
        lp.y = Math.max(0, Math.min(geometry[1] - size, lp.y));
        windowManager.updateViewLayout(feedbackView, lp);
    }

    private void hideFeedback() {
        if (feedbackView != null) feedbackView.setVisibility(View.INVISIBLE);
    }

    private boolean interactivity() {
        boolean interactive = !held && !replaying;
        return AttemptAll.run(windows, view -> {
            WindowManager.LayoutParams lp = (WindowManager.LayoutParams) view.getLayoutParams();
            lp.flags = interactive ? lp.flags & ~WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                    : lp.flags | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
            lp.alpha = interactive ? 1 : 0;
            windowManager.updateViewLayout(view, lp);
        });
    }

    private boolean restoreInteractivity() {
        if (interactivity()) return true;
        boolean stopped = session != null && session.failSafeStop();
        problem("无法恢复手势窗口触摸；" + (stopped ? "已恢复三键并停止手势。"
                : session == null ? "服务状态不可用。" : session.error()));
        return false;
    }

    private static final class GestureFeedbackView extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private SwipeDetector.Zone zone = SwipeDetector.Zone.BOTTOM;
        private float progress;
        private boolean crossed;

        GestureFeedbackView(Context context) {
            super(context);
            setVisibility(INVISIBLE);
            setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        }

        void show(SwipeDetector.Zone zone, float progress, boolean crossed) {
            this.zone = zone;
            this.progress = progress;
            this.crossed = crossed;
            setVisibility(VISIBLE);
            invalidate();
        }

        @Override
        protected void onDraw(Canvas canvas) {
            float density = getResources().getDisplayMetrics().density;
            float centerX = getWidth() / 2f;
            float centerY = getHeight() / 2f;
            paint.setColor(crossed ? Color.rgb(38, 122, 105) : 0xcc202521);
            paint.setStyle(Paint.Style.FILL);
            if (zone == SwipeDetector.Zone.BOTTOM) {
                float halfWidth = (18 + 12 * progress) * density;
                float halfHeight = (3 + 2 * progress) * density;
                canvas.drawRoundRect(centerX - halfWidth, centerY - halfHeight,
                        centerX + halfWidth, centerY + halfHeight, halfHeight, halfHeight, paint);
                return;
            }
            float direction = zone == SwipeDetector.Zone.LEFT ? 1 : -1;
            float reach = (8 + 8 * progress) * density;
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeWidth((3 + progress) * density);
            paint.setStrokeCap(Paint.Cap.ROUND);
            paint.setStrokeJoin(Paint.Join.ROUND);
            Path arrow = new Path();
            arrow.moveTo(centerX - direction * reach / 2, centerY - reach / 2);
            arrow.lineTo(centerX + direction * reach / 2, centerY);
            arrow.lineTo(centerX - direction * reach / 2, centerY + reach / 2);
            canvas.drawPath(arrow, paint);
        }
    }

    private void replay(List<SwipeDetector.Sample> samples) {
        if (replaying || samples.isEmpty()) return;
        SwipeDetector.Sample first = samples.get(0), last = samples.get(samples.size() - 1);
        boolean tap = Math.hypot(last.x - first.x, last.y - first.y) < 12;
        Path path = new Path();
        path.moveTo(first.x, first.y);
        if (tap) path.lineTo(first.x + 1, first.y + 1);
        else for (int i = 1; i < samples.size(); i++) path.lineTo(samples.get(i).x, samples.get(i).y);
        long raw = last.time - first.time;
        long duration = tap && raw < ViewConfiguration.getLongPressTimeout()
                ? Math.max(50, Math.min(60, raw)) : Math.max(1, Math.min(3000, raw));
        long delay = Math.max(0, 65 - raw);
        final int token = generation;
        replaying = true;
        if (!interactivity()) {
            replaying = false;
            restoreInteractivity();
            return;
        }
        final boolean[] restored = {true};
        Runnable finish = () -> {
            if (token != generation) return;
            replaying = false;
            restored[0] = restoreInteractivity();
        };
        handler.postDelayed(finish, duration + delay + 1000);
        handler.postDelayed(() -> {
            if (token != generation || instance != this || !session.running()) return;
            try {
                GestureDescription gesture = new GestureDescription.Builder().addStroke(
                        new GestureDescription.StrokeDescription(path, 0, duration)).build();
                boolean accepted = dispatchGesture(gesture, new GestureResultCallback() {
                    private void done(boolean completed) {
                        handler.removeCallbacks(finish);
                        finish.run();
                        if (!completed && token == generation && restored[0]) {
                            problem("系统取消了边缘触摸回放。");
                        }
                    }
                    @Override public void onCompleted(GestureDescription g) { done(true); }
                    @Override public void onCancelled(GestureDescription g) { done(false); }
                }, handler);
                if (!accepted) throw new IllegalStateException("dispatchGesture returned false");
            } catch (RuntimeException exception) {
                handler.removeCallbacks(finish);
                finish.run();
                if (restored[0]) {
                    problem("系统拒绝边缘触摸回放：" + exception.getClass().getSimpleName());
                }
            }
        }, delay);
    }
}
