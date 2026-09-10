package com.example.launcherprobe;

import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.drawable.Drawable;

/** Small native line icons, in a 24 dp coordinate space. */
final class ChatIcon extends Drawable {
    private final String name;
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);

    ChatIcon(String name, int color) {
        this.name = name;
        paint.setColor(color);
        paint.setStrokeWidth(1.7f);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeCap(Paint.Cap.ROUND);
        paint.setStrokeJoin(Paint.Join.ROUND);
    }

    @Override public void draw(Canvas canvas) {
        canvas.save();
        canvas.translate(getBounds().left, getBounds().top);
        canvas.scale(getBounds().width() / 24f, getBounds().height() / 24f);
        switch (name) {
            case "menu":
                line(canvas, 3, 7, 21, 7); line(canvas, 3, 16, 16, 16); break;
            case "close":
                line(canvas, 6, 6, 18, 18); line(canvas, 18, 6, 6, 18); break;
            case "plus":
                line(canvas, 5, 12, 19, 12); line(canvas, 12, 5, 12, 19); break;
            case "send":
                line(canvas, 12, 19, 12, 5); path(canvas, 6, 11, 12, 5, 18, 11); break;
            case "stop":
                paint.setStyle(Paint.Style.FILL);
                canvas.drawRoundRect(6, 6, 18, 18, 2, 2, paint);
                paint.setStyle(Paint.Style.STROKE); break;
            case "mic":
                canvas.drawRoundRect(9, 3, 15, 14, 3, 3, paint);
                canvas.drawArc(6, 6, 18, 18, 0, 180, false, paint);
                line(canvas, 12, 18, 12, 21); break;
            case "search":
                canvas.drawCircle(10, 10, 6, paint); line(canvas, 15, 15, 21, 21); break;
            case "compose":
                path(canvas, 10, 4, 5, 4, 4, 5, 4, 19, 5, 20, 19, 20, 20, 19, 20, 12);
                path(canvas, 10, 14, 11, 10, 19, 2, 22, 5, 14, 13, 10, 14); break;
            case "copy":
                canvas.drawRoundRect(8, 3, 20, 16, 2, 2, paint);
                path(canvas, 8, 8, 4, 8, 4, 21, 15, 21, 15, 17); break;
            case "share":
                path(canvas, 5, 13, 5, 21, 19, 21, 19, 13);
                line(canvas, 12, 15, 12, 3); path(canvas, 7, 8, 12, 3, 17, 8); break;
            case "home":
                path(canvas, 3, 11, 12, 3, 21, 11);
                path(canvas, 6, 9, 6, 21, 18, 21, 18, 9); break;
            case "settings":
                canvas.drawCircle(12, 12, 6, paint); canvas.drawCircle(12, 12, 2, paint);
                for (int i = 0; i < 8; i++) {
                    canvas.save(); canvas.rotate(i * 45, 12, 12);
                    line(canvas, 12, 3, 12, 6); canvas.restore();
                }
                break;
            case "more":
                paint.setStyle(Paint.Style.FILL);
                for (int x = 5; x <= 19; x += 7) canvas.drawCircle(x, 12, 1.4f, paint);
                paint.setStyle(Paint.Style.STROKE); break;
            default: break;
        }
        canvas.restore();
    }

    private void line(Canvas canvas, float x, float y, float endX, float endY) {
        canvas.drawLine(x, y, endX, endY, paint);
    }

    private void path(Canvas canvas, float... points) {
        Path path = new Path();
        path.moveTo(points[0], points[1]);
        for (int i = 2; i < points.length; i += 2) path.lineTo(points[i], points[i + 1]);
        canvas.drawPath(path, paint);
    }

    @Override public void setAlpha(int alpha) { paint.setAlpha(alpha); invalidateSelf(); }
    @Override public void setColorFilter(ColorFilter filter) { paint.setColorFilter(filter); invalidateSelf(); }
    @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
}
