package com.example.launcherprobe;

import android.animation.ObjectAnimator;
import android.animation.PropertyValuesHolder;
import android.animation.StateListAnimator;
import android.animation.ValueAnimator;
import android.view.View;
import android.view.animation.Interpolator;
import android.view.animation.PathInterpolator;
import android.widget.LinearLayout;

import androidx.dynamicanimation.animation.DynamicAnimation;
import androidx.dynamicanimation.animation.FloatValueHolder;
import androidx.dynamicanimation.animation.SpringAnimation;
import androidx.dynamicanimation.animation.SpringForce;

/** Shared durations, springs, and press feedback for native views. */
final class Motion {
    static final Interpolator EASE = new PathInterpolator(.2f, 0f, 0f, 1f);
    static final long PRESS = 90, RELEASE = 140, LOCAL = 220, PAGE = 280;

    static boolean enabled() {
        return ValueAnimator.areAnimatorsEnabled();
    }

    static long duration(long milliseconds) {
        return enabled() ? milliseconds : 0;
    }

    static SpringForce spatial(float finalPosition) {
        return new SpringForce(finalPosition)
                .setDampingRatio(SpringForce.DAMPING_RATIO_NO_BOUNCY)
                .setStiffness(500f);
    }

    static SpringAnimation spring(FloatValueHolder holder, float start, float end, float velocity,
            DynamicAnimation.OnAnimationUpdateListener update,
            DynamicAnimation.OnAnimationEndListener ended) {
        holder.setValue(start);
        SpringAnimation animation = new SpringAnimation(holder);
        animation.setSpring(spatial(end));
        animation.setStartVelocity(velocity);
        if (update != null) animation.addUpdateListener(update);
        if (ended != null) animation.addEndListener(ended);
        if (!enabled() || start == end) {
            holder.setValue(end);
            if (update != null) update.onAnimationUpdate(animation, end, 0);
            if (ended != null) ended.onAnimationEnd(animation, false, end, 0);
            return animation;
        }
        animation.start();
        return animation;
    }

    static SpringAnimation spring(View view, DynamicAnimation.ViewProperty property, float end, float velocity,
            DynamicAnimation.OnAnimationEndListener ended) {
        SpringAnimation animation = new SpringAnimation(view, property, end);
        animation.setSpring(spatial(end));
        animation.setStartVelocity(velocity);
        if (ended != null) animation.addEndListener(ended);
        if (!enabled()) {
            property.setValue(view, end);
            if (ended != null) ended.onAnimationEnd(animation, false, end, 0);
            return animation;
        }
        animation.start();
        return animation;
    }

    static void press(View view) {
        StateListAnimator states = new StateListAnimator();
        ObjectAnimator pressed = ObjectAnimator.ofPropertyValuesHolder(view,
                PropertyValuesHolder.ofFloat(View.SCALE_X, .96f),
                PropertyValuesHolder.ofFloat(View.SCALE_Y, .96f));
        pressed.setDuration(duration(PRESS));
        states.addState(new int[]{android.R.attr.state_pressed, android.R.attr.state_enabled}, pressed);
        ObjectAnimator released = ObjectAnimator.ofPropertyValuesHolder(view,
                PropertyValuesHolder.ofFloat(View.SCALE_X, 1f),
                PropertyValuesHolder.ofFloat(View.SCALE_Y, 1f));
        released.setDuration(duration(RELEASE));
        states.addState(new int[]{}, released);
        view.setStateListAnimator(states);
    }

    static void enter(View view, int offsetPx) {
        view.animate().cancel();
        if (!enabled()) {
            view.setAlpha(1f);
            view.setTranslationY(0);
            return;
        }
        view.setAlpha(0f);
        view.setTranslationY(offsetPx);
        view.animate().alpha(1f).translationY(0).setDuration(LOCAL).setInterpolator(EASE).start();
    }

    static void expand(LinearLayout parent) {
        if (enabled()) {
            android.transition.TransitionManager.beginDelayedTransition(parent,
                    new android.transition.AutoTransition().setDuration(180));
        }
    }

    static boolean crossed(float progress, float velocity, float minFling, boolean reverse) {
        if (reverse) {
            if (velocity <= -minFling) return true;
            if (velocity >= minFling) return false;
        } else {
            if (velocity >= minFling) return true;
            if (velocity <= -minFling) return false;
        }
        return progress >= .28f;
    }

    private Motion() { }
}
