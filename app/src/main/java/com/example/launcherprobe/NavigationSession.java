package com.example.launcherprobe;

/** Main-thread-only ordering of persistent ROM settings and the three gesture windows. */
final class NavigationSession {
    interface Ports {
        boolean ready();
        boolean pending();
        boolean save(boolean pending);
        void attach();
        void detach();
        boolean navigation(boolean hidden);
    }

    private final Ports ports;
    private boolean running;
    private boolean enabled;
    private String error = "";

    NavigationSession(Ports ports) { this.ports = ports; }
    boolean running() { return running; }
    boolean enabled() { return enabled; }
    String error() { return error; }

    boolean start() {
        if (running) return enabled;
        error = "";
        if (!ports.ready()) return fail("需要已连接的无障碍服务及 ADB 写设置授权。");
        if (ports.pending() && !recover()) return false;
        try {
            ports.attach();
        } catch (RuntimeException exception) {
            ports.detach();
            return fail("无法创建完整手势区域：" + exception.getClass().getSimpleName());
        }
        if (!ports.save(true)) {
            ports.detach();
            return fail("无法保存恢复标记；未隐藏系统按键。");
        }
        running = true;
        if (!ports.navigation(true)) {
            if (stop()) return fail("隐藏系统按键失败，已恢复三键并停止手势。");
            return false;
        }
        enabled = true;
        return true;
    }

    boolean failSafeStop() {
        enabled = false;
        return stop();
    }

    boolean stop() {
        error = "";
        if (!running && !ports.pending()) return true;
        if (!ports.navigation(false)) {
            return fail("恢复三键失败；保留现有手势。请恢复授权或使用 ADB 救援。");
        }
        enabled = false;
        if (!ports.save(false)) {
            return fail("三键已恢复，但恢复标记写入失败；暂时保留手势，请重试停用。");
        }
        ports.detach();
        running = false;
        return true;
    }

    boolean recover() {
        if (running) return true;
        return stop();
    }

    private boolean fail(String message) { error = message; return false; }
}
