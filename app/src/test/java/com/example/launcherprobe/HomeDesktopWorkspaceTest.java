package com.example.launcherprobe;

import static org.junit.Assert.*;

import android.app.Dialog;
import android.content.Context;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.content.pm.ResolveInfo;
import android.graphics.drawable.GradientDrawable;
import android.os.Looper;
import android.view.DragEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.GridLayout;
import android.widget.LinearLayout;

import androidx.activity.ComponentActivity;
import androidx.dynamicanimation.animation.SpringAnimation;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowToast;
import org.robolectric.util.ReflectionHelpers;

import java.time.Duration;
import java.util.List;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = {29, 35})
public class HomeDesktopWorkspaceTest {
    @Test public void blankHoldEntersEditOnlyAfter800ms() {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get());
            View empty = scene.emptyCell();
            float[] point = scene.pointOn(empty);
            scene.touch(MotionEvent.ACTION_DOWN, point[0], point[1]);
            Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(450));
            assertFalse(scene.editing());
            assertEquals(View.GONE, scene.tools().getVisibility());
            Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(349));
            assertFalse(scene.editing());
            Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(20));
            assertTrue(scene.editing());
            assertEquals(View.VISIBLE, scene.tools().getVisibility());
        }
    }

    @Test public void blankTapAndMoveDoNotEnterEdit() {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get());
            View empty = scene.emptyCell();
            float[] point = scene.pointOn(empty);
            scene.touch(MotionEvent.ACTION_DOWN, point[0], point[1]);
            Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(450));
            scene.touch(MotionEvent.ACTION_UP, point[0], point[1]);
            Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(900));
            assertFalse(scene.editing());
            assertEquals(View.GONE, scene.tools().getVisibility());

            scene.touch(MotionEvent.ACTION_DOWN, point[0], point[1]);
            scene.touch(MotionEvent.ACTION_MOVE, point[0] + 80, point[1]);
            Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(900));
            scene.touch(MotionEvent.ACTION_UP, point[0] + 80, point[1]);
            scene.finishSpring();
            assertFalse(scene.editing());
            assertEquals(View.GONE, scene.tools().getVisibility());
        }
    }

    @Test public void emptySlotClickDoesNotOpenAppPickerAndHasNoVacantFrame() {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get());
            scene.desktop.enterEdit();
            scene.layout();
            View empty = scene.emptyCell();
            assertFalse(empty.getBackground() instanceof GradientDrawable);
            float[] point = scene.pointOn(empty);
            scene.touch(MotionEvent.ACTION_DOWN, point[0], point[1]);
            scene.touch(MotionEvent.ACTION_UP, point[0], point[1]);
            Shadows.shadowOf(Looper.getMainLooper()).idle();
            assertNull(ReflectionHelpers.getField(scene.desktop, "appDialog"));
            assertTrue(scene.editing());
        }
    }

    @Test public void iconAndDockLongPressDoNotEnterEdit() {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get());
            scene.appCell().performLongClick();
            assertFalse(scene.editing());
            assertEquals(View.GONE, scene.tools().getVisibility());
            scene.dockCell(0).performLongClick();
            assertFalse(scene.editing());
            assertEquals(View.GONE, scene.tools().getVisibility());
        }
    }

    @Test public void widgetHoldAndExternalDragStartDoNotEnterEdit() {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get());
            View clock = scene.widgetAt(4);
            float[] point = scene.pointOn(clock);
            scene.touch(MotionEvent.ACTION_DOWN, point[0], point[1]);
            Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(450));
            assertFalse(scene.editing());
            assertEquals(View.GONE, scene.tools().getVisibility());
            scene.touch(MotionEvent.ACTION_CANCEL, point[0], point[1]);

            Object token = new Object();
            scene.desktop.acceptExternalDrag(token, HomeLayout.Item.app(
                    scene.app.activityInfo.packageName, scene.app.activityInfo.name));
            DragEvent started = dragEvent(DragEvent.ACTION_DRAG_STARTED, token);
            assertTrue(scene.desktop.dispatchDragEvent(started));
            assertFalse(scene.editing());
            assertEquals(View.GONE, scene.tools().getVisibility());
            Dialog picker = ReflectionHelpers.getField(scene.desktop, "appDialog");
            assertNull(picker);
            assertNull(firstDescribed(scene.desktop, "从桌面移除", "Remove from Home"));
        }
    }

    @Test public void draggingHomeAppOntoRemoveChipRemovesEntry() {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get());
            Object state = dragItem(scene.model.get(0), 0, -1);
            assertTrue(scene.desktop.dispatchDragEvent(dragEvent(DragEvent.ACTION_DRAG_STARTED, state)));
            assertFalse(scene.editing());
            assertEquals(View.GONE, scene.tools().getVisibility());
            scene.layout();
            View chip = firstDescribed(scene.desktop, "从桌面移除", "Remove from Home");
            assertNotNull(chip);
            assertEquals(View.VISIBLE, chip.getVisibility());
            assertTrue(chip.getWidth() > 0);
            float x = chip.getLeft() + chip.getWidth() / 2f;
            float y = chip.getTop() + chip.getHeight() / 2f;
            assertTrue(scene.desktop.dispatchDragEvent(dragEvent(DragEvent.ACTION_DROP, state, x, y)));
            scene.desktop.dispatchDragEvent(dragEvent(DragEvent.ACTION_DRAG_ENDED, state));
            assertNull(scene.model.get(0));
            assertFalse(scene.editing());
            assertEquals(View.GONE, scene.tools().getVisibility());
            assertEquals(View.GONE, chip.getVisibility());
        }
    }

    @Test public void dragCancelLeavesHomeAppInPlace() {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get());
            Object state = dragItem(scene.model.get(0), 0, -1);
            assertTrue(scene.desktop.dispatchDragEvent(dragEvent(DragEvent.ACTION_DRAG_STARTED, state)));
            scene.layout();
            View chip = firstDescribed(scene.desktop, "从桌面移除", "Remove from Home");
            assertNotNull(chip);
            scene.desktop.dispatchDragEvent(dragEvent(DragEvent.ACTION_DRAG_ENDED, state));
            assertNotNull(scene.model.get(0));
            assertEquals(HomeLayout.Item.APP, scene.model.get(0).type);
            assertFalse(scene.editing());
            assertEquals(View.GONE, chip.getVisibility());
        }
    }

    @Test public void droppingHomeAppOnOriginalSlotIsNoOp() {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get());
            Object state = dragItem(scene.model.get(0), 0, -1);
            assertTrue(scene.desktop.dispatchDragEvent(dragEvent(DragEvent.ACTION_DRAG_STARTED, state)));
            scene.layout();
            View cell = scene.appCell();
            int[] cellOrigin = new int[2], deskOrigin = new int[2];
            cell.getLocationOnScreen(cellOrigin);
            scene.desktop.getLocationOnScreen(deskOrigin);
            float x = cellOrigin[0] - deskOrigin[0] + cell.getWidth() / 2f;
            float y = cellOrigin[1] - deskOrigin[1] + cell.getHeight() / 2f;
            assertTrue(scene.desktop.dispatchDragEvent(dragEvent(DragEvent.ACTION_DROP, state, x, y)));
            scene.desktop.dispatchDragEvent(dragEvent(DragEvent.ACTION_DRAG_ENDED, state));
            assertNotNull(scene.model.get(0));
            assertEquals(HomeLayout.Item.APP, scene.model.get(0).type);
            assertFalse(scene.editing());
            assertEquals(View.GONE, scene.tools().getVisibility());
            assertNull(ShadowToast.getLatestToast());
        }
    }

    @Test public void horizontalSwipeOnAiWidgetChangesPage() throws Exception {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get(), true);
            HomeTaskCards cards = new HomeTaskCards(scene.activity, scene.pager, id -> {}, id -> {}, id -> {});
            cards.update(new JSONArray()
                    .put(new JSONObject().put("conversationId", "a").put("title", "A").put("modelState", "idle"))
                    .put(new JSONObject().put("conversationId", "b").put("title", "B").put("modelState", "idle")));
            scene.desktop.setAiWidget(cards);
            scene.layout();
            View widget = scene.widgetAt(0);
            float[] point = scene.pointOn(widget);
            assertEquals(0, scene.page());
            scene.touch(MotionEvent.ACTION_DOWN, point[0], point[1]);
            scene.touch(MotionEvent.ACTION_MOVE, point[0] - 60, point[1]);
            scene.touch(MotionEvent.ACTION_MOVE, point[0] - 450, point[1]);
            scene.touch(MotionEvent.ACTION_UP, point[0] - 450, point[1]);
            scene.finishSpring();
            assertEquals(1, scene.page());
            assertEquals(0f, scene.grid().getTranslationX(), .01f);
            assertEquals("a", cards.selectedId());
            assertEquals(PagerState.Page.HOME, scene.pager.page());
        }
    }

    @Test public void horizontalSwipeOnClockWidgetDoesNotChangePage() {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get());
            View clock = scene.widgetAt(4);
            float[] point = scene.pointOn(clock);
            scene.touch(MotionEvent.ACTION_DOWN, point[0], point[1]);
            scene.touch(MotionEvent.ACTION_MOVE, point[0] - 60, point[1]);
            scene.touch(MotionEvent.ACTION_MOVE, point[0] - 450, point[1]);
            scene.touch(MotionEvent.ACTION_UP, point[0] - 450, point[1]);
            scene.finishSpring();
            assertEquals(0, scene.page());
        }
    }

    @Test public void horizontalSwipeOnNonOverflowingTodoStripChangesPage() throws Exception {
        try (var controller = Robolectric.buildActivity(ComponentActivity.class).setup()) {
            Scene scene = new Scene(controller.get(), true);
            HomeTaskCards cards = new HomeTaskCards(scene.activity, scene.pager, id -> {}, id -> {}, id -> {});
            JSONObject todo = new JSONObject()
                    .put("package", "@juicesharp/rpiv-todo")
                    .put("tasks", new JSONArray()
                            .put(new JSONObject().put("id", "t1").put("subject", "One").put("status", "completed"))
                            .put(new JSONObject().put("id", "t2").put("subject", "Two").put("status", "in_progress"))
                            .put(new JSONObject().put("id", "t3").put("subject", "Three").put("status", "pending")));
            cards.update(new JSONArray()
                    .put(new JSONObject().put("conversationId", "a").put("title", "A").put("modelState", "working").put("todo", todo))
                    .put(new JSONObject().put("conversationId", "b").put("title", "B").put("modelState", "idle").put("todo", new JSONObject(todo.toString()))));
            scene.desktop.setAiWidget(cards);
            scene.layout();
            View strip = cards.findViewWithTag("todo-strip");
            assertNotNull(strip);
            assertFalse(strip.canScrollHorizontally(1) || strip.canScrollHorizontally(-1));
            float[] point = scene.pointOn(strip);
            assertEquals(0, scene.page());
            scene.touch(MotionEvent.ACTION_DOWN, point[0], point[1]);
            scene.touch(MotionEvent.ACTION_MOVE, point[0] - 12, point[1]);
            scene.touch(MotionEvent.ACTION_MOVE, point[0] - 60, point[1]);
            scene.touch(MotionEvent.ACTION_MOVE, point[0] - 450, point[1]);
            scene.touch(MotionEvent.ACTION_UP, point[0] - 450, point[1]);
            scene.finishSpring();
            assertEquals(1, scene.page());
            assertEquals(0f, scene.grid().getTranslationX(), .01f);
            assertEquals("a", cards.selectedId());
            assertEquals(PagerState.Page.HOME, scene.pager.page());
        }
    }

    private static Object dragItem(HomeLayout.Item item, int slot, int dockIndex) {
        try {
            Class<?> type = Class.forName("com.example.launcherprobe.HomeDesktop$DragItem");
            var ctor = type.getDeclaredConstructor(HomeLayout.Item.class, int.class, int.class);
            ctor.setAccessible(true);
            return ctor.newInstance(item, slot, dockIndex);
        } catch (ReflectiveOperationException failure) {
            throw new RuntimeException(failure);
        }
    }

    private static DragEvent dragEvent(int action, Object localState) {
        return dragEvent(action, localState, 0, 0);
    }

    private static DragEvent dragEvent(int action, Object localState, float x, float y) {
        try {
            java.lang.reflect.Method obtain = DragEvent.class.getDeclaredMethod("obtain");
            obtain.setAccessible(true);
            DragEvent event = (DragEvent) obtain.invoke(null);
            ReflectionHelpers.setField(event, "mAction", action);
            ReflectionHelpers.setField(event, "mLocalState", localState);
            ReflectionHelpers.setField(event, "mX", x);
            ReflectionHelpers.setField(event, "mY", y);
            return event;
        } catch (ReflectiveOperationException failure) {
            throw new RuntimeException(failure);
        }
    }

    private static final class Scene {
        final ComponentActivity activity;
        final PagerRoot pager;
        final HomeDesktop desktop;
        final HomeLayout model;
        final ResolveInfo app;
        long time;
        long downTime;

        Scene(ComponentActivity activity) {
            this(activity, false);
        }

        Scene(ComponentActivity activity, boolean aiOnFirstPage) {
            this.activity = activity;
            activity.getSharedPreferences(HomeLayout.PREFERENCES, Context.MODE_PRIVATE).edit().clear().commit();
            activity.getSharedPreferences(DesktopPreferences.STORE, Context.MODE_PRIVATE).edit().clear().commit();
            app = new ResolveInfo();
            app.activityInfo = new ActivityInfo();
            app.activityInfo.packageName = activity.getPackageName();
            app.activityInfo.name = "TestApp";
            app.activityInfo.applicationInfo = new ApplicationInfo(activity.getApplicationInfo());
            app.nonLocalizedLabel = "Test App";
            app.icon = android.R.drawable.sym_def_app_icon;
            model = HomeLayout.load(activity, List.of(app));
            for (int slot = 0; slot < model.size(); slot++) model.remove(slot);
            model.addPage();
            if (aiOnFirstPage) {
                model.set(0, HomeLayout.Item.widget(HomeLayout.Item.AI_WIDGET, 4, 3, -1, null));
            } else {
                model.set(0, HomeLayout.Item.app(app.activityInfo.packageName, app.activityInfo.name));
                model.set(4, HomeLayout.Item.widget(HomeLayout.Item.CLOCK, 4, 1, -1, null));
                model.setDock(0, HomeLayout.Item.app(app.activityInfo.packageName, app.activityInfo.name));
            }
            pager = new PagerRoot(activity, new View(activity), PagerState.Page.HOME, page -> {});
            FrameLayout home = new FrameLayout(activity);
            desktop = new HomeDesktop(activity, pager, model, List.of(app), new LauncherShortcuts(activity), home);
            home.addView(desktop, new FrameLayout.LayoutParams(-1, -1));
            pager.setHome(home);
            activity.setContentView(pager);
            layout();
            assertTrue(Motion.enabled());
        }

        void layout() {
            pager.measure(View.MeasureSpec.makeMeasureSpec(1000, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(1600, View.MeasureSpec.EXACTLY));
            pager.layout(0, 0, 1000, 1600);
        }

        GridLayout grid() { return ReflectionHelpers.getField(desktop, "grid"); }
        LinearLayout tools() { return ReflectionHelpers.getField(desktop, "tools"); }
        LinearLayout dock() { return ReflectionHelpers.getField(desktop, "dock"); }
        int page() { return ReflectionHelpers.getField(desktop, "currentPage"); }
        boolean editing() { return ReflectionHelpers.getField(desktop, "editing"); }

        View appCell() {
            View cell = firstDescribed(grid(), "Open Test App", "打开 Test App");
            assertNotNull("home app cell", cell);
            return cell;
        }

        View dockCell(int index) {
            View cell = dock().getChildAt(index);
            assertNotNull("dock cell", cell);
            return cell;
        }

        View emptyCell() {
            GridLayout workspace = grid();
            for (int i = 0; i < workspace.getChildCount(); i++) {
                View child = workspace.getChildAt(i);
                Object tag = child.getTag();
                if (tag instanceof Integer slot && model.get(slot) == null) return child;
            }
            fail("empty workspace cell");
            return null;
        }

        View widgetAt(int slot) {
            java.util.HashMap<Integer, View> cells = ReflectionHelpers.getField(desktop, "homeCells");
            View cell = cells.get(slot);
            assertNotNull("widget at " + slot, cell);
            return cell;
        }

        float[] pointOn(View view) {
            int[] viewOrigin = new int[2];
            int[] pagerOrigin = new int[2];
            view.getLocationOnScreen(viewOrigin);
            pager.getLocationOnScreen(pagerOrigin);
            return new float[]{
                    viewOrigin[0] - pagerOrigin[0] + view.getWidth() / 2f,
                    viewOrigin[1] - pagerOrigin[1] + view.getHeight() / 2f
            };
        }

        void touch(int action, float x, float y) {
            time += 20;
            if (action == MotionEvent.ACTION_DOWN) downTime = time;
            MotionEvent event = MotionEvent.obtain(downTime, time, action, x, y, 0);
            pager.dispatchTouchEvent(event);
            event.recycle();
        }

        void finishSpring() {
            SpringAnimation animation = ReflectionHelpers.getField(desktop, "pageSpring");
            if (animation == null) return;
            for (long frame = 16; animation.isRunning() && frame <= 4000; frame += 16) {
                animation.doAnimationFrame(frame);
            }
        }
    }

    private static View firstDescribed(View view, String... texts) {
        CharSequence description = view.getContentDescription();
        if (description != null) {
            String value = description.toString();
            for (String text : texts) if (value.contains(text)) return view;
        }
        if (view instanceof ViewGroup group) {
            for (int i = 0; i < group.getChildCount(); i++) {
                View found = firstDescribed(group.getChildAt(i), texts);
                if (found != null) return found;
            }
        }
        return null;
    }
}
