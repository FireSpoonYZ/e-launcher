package com.example.launcherprobe;

/** Pixel-free page state and settle rules shared by the native pager and checks. */
final class PagerState {
    enum Page { CHAT, HOME }

    static float endpoint(Page page, float width) {
        return page == Page.CHAT ? Math.max(0, width) : 0;
    }

    static float clamp(float track, float width) {
        return Math.max(0, Math.min(Math.max(0, width), track));
    }

    static Page settle(Page current, float track, float width, float velocityX,
            float minimumFlingVelocity, boolean cancelled) {
        if (cancelled || width <= 0) return current;
        if (velocityX >= minimumFlingVelocity) return Page.CHAT;
        if (velocityX <= -minimumFlingVelocity) return Page.HOME;
        if (current == Page.HOME) return track >= width * .28f ? Page.CHAT : Page.HOME;
        return track <= width * .72f ? Page.HOME : Page.CHAT;
    }

    private PagerState() { }
}
