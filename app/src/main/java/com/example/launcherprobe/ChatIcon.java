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
            case "sparkles":
                paint.setStyle(Paint.Style.FILL);
                Path star = new Path();
                star.moveTo(10, 1);
                star.cubicTo(11.5f, 1, 11, 6.5f, 13, 8);
                star.cubicTo(14.5f, 9, 19, 9, 19, 10.5f);
                star.cubicTo(19, 12, 14.5f, 12, 13, 13.5f);
                star.cubicTo(11, 15, 11.5f, 20, 10, 20);
                star.cubicTo(8.5f, 20, 9, 15, 7, 13.5f);
                star.cubicTo(5.5f, 12, 1, 12, 1, 10.5f);
                star.cubicTo(1, 9, 5.5f, 9, 7, 8);
                star.cubicTo(9, 6.5f, 8.5f, 1, 10, 1); star.close();
                canvas.drawPath(star, paint);
                path(canvas, 19, 15, 20.2f, 18, 23, 19, 20.2f, 20, 19, 23, 17.8f, 20, 15, 19, 17.8f, 18);
                paint.setStyle(Paint.Style.STROKE); break;
            case "up":
                path(canvas, 5, 15, 12, 8, 19, 15); break;
            case "down":
                path(canvas, 5, 9, 12, 16, 19, 9); break;
            case "check":
                path(canvas, 5, 12, 10, 17, 20, 7); break;
            case "grid":
                paint.setStyle(Paint.Style.FILL);
                canvas.drawRoundRect(3, 3, 10, 10, 2, 2, paint); canvas.drawRoundRect(14, 3, 21, 10, 2, 2, paint);
                canvas.drawRoundRect(3, 14, 10, 21, 2, 2, paint); canvas.drawRoundRect(14, 14, 21, 21, 2, 2, paint);
                paint.setStyle(Paint.Style.STROKE); break;
            case "link":
                canvas.save(); canvas.rotate(45, 12, 12);
                canvas.drawRoundRect(8, 2, 16, 13, 4, 4, paint);
                canvas.drawRoundRect(8, 11, 16, 22, 4, 4, paint); canvas.restore(); break;
            case "paper-plane":
                path(canvas, 3, 10, 21, 3, 14, 21, 10, 14, 3, 10);
                line(canvas, 10, 14, 21, 3); break;
            case "desktop":
                paint.setStyle(Paint.Style.FILL);
                path(canvas, 2, 10, 12, 2, 22, 10, 19, 10, 19, 22, 14, 22, 14, 15, 10, 15, 10, 22, 5, 22, 5, 10);
                paint.setStyle(Paint.Style.STROKE); break;
            case "dock":
                paint.setStyle(Paint.Style.FILL); canvas.drawRoundRect(3, 3, 21, 21, 3, 3, paint);
                int dockColor = paint.getColor(); paint.setColor(0xffffffff);
                canvas.drawCircle(8, 16, 2, paint); canvas.drawCircle(16, 16, 2, paint);
                paint.setColor(dockColor); paint.setStyle(Paint.Style.STROKE); break;
            case "folder":
                path(canvas, 3, 8, 21, 8, 21, 21, 3, 21, 3, 4, 10, 4, 12, 7, 21, 7, 21, 8); break;
            case "gesture":
                Path finger = new Path(); finger.moveTo(9, 13); finger.lineTo(9, 4);
                finger.cubicTo(9, 1, 13, 1, 13, 4); finger.lineTo(13, 11);
                finger.lineTo(16, 10); finger.lineTo(21, 13); finger.lineTo(20, 20);
                finger.cubicTo(19, 24, 12, 23, 10, 21); finger.lineTo(4, 14);
                finger.cubicTo(2, 11, 5, 9, 7, 12); finger.lineTo(9, 14); canvas.drawPath(finger, paint); break;
            case "palette":
                Path palette = new Path(); palette.moveTo(12, 3);
                palette.cubicTo(24, 3, 25, 16, 17, 15); palette.cubicTo(12, 14, 17, 21, 11, 21);
                palette.cubicTo(0, 21, 0, 3, 12, 3); canvas.drawPath(palette, paint);
                paint.setStyle(Paint.Style.FILL);
                canvas.drawCircle(7, 9, 1.3f, paint); canvas.drawCircle(12, 7, 1.3f, paint); canvas.drawCircle(17, 10, 1.3f, paint);
                paint.setStyle(Paint.Style.STROKE); break;
            case "cloud":
            case "cloud-upload":
                Path cloud = new Path(); cloud.moveTo(6, 19);
                cloud.cubicTo(-1, 19, 0, 9, 7, 10); cloud.cubicTo(6, 1, 19, 1, 18, 10);
                cloud.cubicTo(25, 9, 25, 19, 18, 19); cloud.close(); canvas.drawPath(cloud, paint);
                if ("cloud-upload".equals(name)) { line(canvas, 12, 18, 12, 10); path(canvas, 9, 13, 12, 10, 15, 13); }
                break;
            case "lock":
                canvas.drawRoundRect(5, 10, 19, 22, 2, 2, paint);
                canvas.drawArc(8, 2, 16, 15, 180, 180, false, paint); line(canvas, 12, 15, 12, 18); break;
            case "list":
                for (int y = 6; y <= 18; y += 6) { canvas.drawCircle(4, y, .8f, paint); line(canvas, 9, y, 21, y); } break;
            case "tree":
                canvas.drawCircle(12, 4, 2.5f, paint);
                canvas.drawCircle(5, 19, 2.5f, paint);
                canvas.drawCircle(19, 19, 2.5f, paint);
                line(canvas, 12, 6.5f, 12, 11);
                path(canvas, 5, 16.5f, 5, 11, 19, 11, 19, 16.5f); break;
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
            case "mic-off":
            case "mic":
                canvas.drawRoundRect(9, 3, 15, 14, 3, 3, paint);
                canvas.drawArc(6, 6, 18, 18, 0, 180, false, paint);
                line(canvas, 12, 18, 12, 21);
                if ("mic-off".equals(name)) line(canvas, 4, 3, 20, 21);
                break;
            case "gauge":
                canvas.drawArc(3, 5, 21, 23, 180, 180, false, paint);
                line(canvas, 12, 14, 17, 10);
                canvas.drawCircle(12, 14, 1.5f, paint); break;
            case "search":
                canvas.drawCircle(10, 10, 6, paint); line(canvas, 15, 15, 21, 21); break;
            case "bubble":
                canvas.drawRoundRect(3, 4, 21, 18, 6, 6, paint); path(canvas, 7, 18, 5, 22, 11, 18); break;
            case "compose":
                path(canvas, 10, 4, 5, 4, 4, 5, 4, 19, 5, 20, 19, 20, 20, 19, 20, 12);
                path(canvas, 10, 14, 11, 10, 19, 2, 22, 5, 14, 13, 10, 14); break;
            case "file":
                path(canvas, 14, 3, 5, 3, 5, 21, 19, 21, 19, 8, 14, 3, 14, 8, 19, 8);
                line(canvas, 8, 12, 16, 12); line(canvas, 8, 16, 14, 16); break;
            case "camera":
                path(canvas, 3, 7, 7, 7, 9, 4, 15, 4, 17, 7, 21, 7, 21, 20, 3, 20, 3, 7);
                canvas.drawCircle(12, 13, 4, paint); break;
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
            case "external":
                path(canvas, 10, 4, 5, 4, 4, 5, 4, 19, 5, 20, 19, 20, 20, 19, 20, 14);
                path(canvas, 15, 3, 21, 3, 21, 9); line(canvas, 12, 12, 21, 3); break;
            case "question-bubble":
                path(canvas, 4, 21, 4, 5, 6, 3, 20, 3, 22, 5, 22, 17, 20, 19, 7, 19, 4, 21);
                line(canvas, 8, 8, 18, 8); line(canvas, 8, 12, 15, 12); break;
            case "radio-off":
                canvas.drawCircle(12, 12, 8, paint); break;
            case "radio-on":
                paint.setStyle(Paint.Style.FILL);
                canvas.drawCircle(12, 12, 9, paint);
                int radioColor = paint.getColor();
                paint.setColor(0xfff0fbfd); canvas.drawCircle(12, 12, 3.2f, paint);
                paint.setColor(radioColor); paint.setStyle(Paint.Style.STROKE); break;
            case "checkbox-off":
            case "checkbox-on":
                canvas.drawRoundRect(4, 4, 20, 20, 3, 3, paint);
                if ("checkbox-on".equals(name)) path(canvas, 7, 12, 11, 16, 17, 8);
                break;
            case "pencil":
                path(canvas, 4, 20, 5, 14, 17, 2, 22, 7, 10, 19, 4, 20);
                line(canvas, 14, 5, 19, 10); break;
            case "arrow-left":
                line(canvas, 4, 12, 21, 12); path(canvas, 11, 5, 4, 12, 11, 19); break;
            case "arrow-right":
                line(canvas, 3, 12, 20, 12); path(canvas, 13, 5, 20, 12, 13, 19); break;
            case "previous":
                path(canvas, 15, 5, 8, 12, 15, 19); break;
            case "next":
                path(canvas, 9, 5, 16, 12, 9, 19); break;
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
