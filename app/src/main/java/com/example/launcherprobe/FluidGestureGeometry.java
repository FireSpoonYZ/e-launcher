package com.example.launcherprobe;

/** Pure geometry for the edge-attached fluid gesture shape. */
final class FluidGestureGeometry {
    private FluidGestureGeometry() { }

    static float depth(float inwardDistance, float density) {
        float max = 40f * density;
        float resistance = 28f * density;
        return max * (1f - (float) Math.exp(-Math.max(0f, inwardDistance) / resistance));
    }

    static float halfWidth(float depth) {
        return 2.8f * Math.max(0f, depth);
    }

    /** Writes local (along-edge, inward) points for two C1-continuous cubic curves. */
    static void points(float depth, float[] out) {
        float d = Math.max(0f, depth);
        float h = halfWidth(d);
        out[0] = -h;
        out[1] = 0f;
        out[2] = -.55f * h;
        out[3] = 0f;
        out[4] = -.25f * h;
        out[5] = d;
        out[6] = 0f;
        out[7] = d;
        out[8] = .25f * h;
        out[9] = d;
        out[10] = .55f * h;
        out[11] = 0f;
        out[12] = h;
        out[13] = 0f;
    }
}
