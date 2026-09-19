package com.example.launcherprobe;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Path;
import android.opengl.GLES30;
import android.opengl.GLSurfaceView;
import android.opengl.GLUtils;
import android.util.Log;

import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.nio.charset.StandardCharsets;

import javax.microedition.khronos.egl.EGLConfig;
import javax.microedition.khronos.opengles.GL10;

/** GLES 3 equivalent of the desktop Horizon material, followed by a separate high-resolution e mask. */
final class VoiceFluidShader implements GLSurfaceView.Renderer {
    private static final int MATERIAL_SIZE = 256;
    private static final String VERTEX = """
            #version 300 es
            layout(location=0) in vec2 aPosition;
            out vec3 vGenerated;
            void main() {
                vGenerated = vec3(aPosition * 0.5 + 0.5, 0.5);
                gl_Position = vec4(aPosition, 0.0, 1.0);
            }
            """;
    private static final String COMPOSITE = """
            #version 300 es
            precision highp float;
            in vec3 vGenerated;
            uniform sampler2D uMaterial;
            uniform sampler2D uMask;
            uniform float uScale;
            out vec4 fragColor;
            void main() {
                vec2 uv = (vGenerated.xy - 0.5) / uScale + 0.5;
                float mask = texture(uMask, vec2(uv.x, 1.0-uv.y)).a;
                vec3 color = texture(uMaterial, uv).rgb;
                fragColor = vec4(color * mask, mask);
            }
            """;
    private final Context context;
    private final Path mask;
    private int material, composite, framebuffer, watercolor, interior, maskTexture, vertexBuffer;
    private int width, height;
    private int wave, base, amplitude, flow, edge, noise, scale;
    private final int[] offsets = new int[3];
    private volatile float waveFrame, baseFrame, inputActivity, audioLevel;
    private boolean ready;

    VoiceFluidShader(Context context, Path mask) {
        this.context = context.getApplicationContext();
        this.mask = new Path(mask);
    }

    void apply(float waveSeconds, float seconds, float activity, float level) {
        waveFrame = waveSeconds * 24;
        baseFrame = seconds * 24;
        inputActivity = activity;
        audioLevel = level;
    }

    @Override public void onSurfaceCreated(GL10 unused, EGLConfig config) {
        ready = false;
        try {
            String source;
            try (InputStream input = context.getResources().openRawResource(R.raw.voice_horizon)) {
                java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
                byte[] block = new byte[4096];
                int count;
                while ((count = input.read(block)) != -1) bytes.write(block, 0, count);
                source = new String(bytes.toByteArray(), StandardCharsets.UTF_8);
            }
            material = program(VERTEX, source);
            composite = program(VERTEX, COMPOSITE);
            int[] names = new int[1];
            GLES30.glGenBuffers(1, names, 0);
            vertexBuffer = names[0];
            float[] vertices = {-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1};
            FloatBuffer buffer = ByteBuffer.allocateDirect(vertices.length * 4).order(ByteOrder.nativeOrder()).asFloatBuffer();
            buffer.put(vertices).position(0);
            GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, vertexBuffer);
            GLES30.glBufferData(GLES30.GL_ARRAY_BUFFER, vertices.length * 4, buffer, GLES30.GL_STATIC_DRAW);

            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inScaled = false;
            options.inPremultiplied = false;
            Bitmap image = BitmapFactory.decodeResource(context.getResources(), R.raw.voice_watercolor, options);
            Matrix flip = new Matrix();
            flip.setScale(1, -1);
            Bitmap flipped = Bitmap.createBitmap(image, 0, 0, image.getWidth(), image.getHeight(), flip, false);
            watercolor = texture(flipped, true);
            flipped.recycle();
            if (image != flipped) image.recycle();
            Bitmap letter = Bitmap.createBitmap(512, 512, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(letter);
            canvas.scale(512f / 106, 512f / 106);
            canvas.translate(5, 2);
            Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
            paint.setColor(Color.WHITE);
            canvas.drawPath(mask, paint);
            maskTexture = texture(letter, false);
            letter.recycle();
            interior = texture(null, false);
            GLES30.glTexImage2D(GLES30.GL_TEXTURE_2D, 0, GLES30.GL_RGBA8, MATERIAL_SIZE, MATERIAL_SIZE,
                    0, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, null);
            GLES30.glGenFramebuffers(1, names, 0);
            framebuffer = names[0];
            GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, framebuffer);
            GLES30.glFramebufferTexture2D(GLES30.GL_FRAMEBUFFER, GLES30.GL_COLOR_ATTACHMENT0,
                    GLES30.GL_TEXTURE_2D, interior, 0);
            if (GLES30.glCheckFramebufferStatus(GLES30.GL_FRAMEBUFFER) != GLES30.GL_FRAMEBUFFER_COMPLETE)
                throw new IllegalStateException("Horizon framebuffer incomplete");
            wave = uniform(material, "uWaveFrame");
            base = uniform(material, "uBaseShaderFrame");
            amplitude = uniform(material, "uWaveAmplitude");
            flow = uniform(material, "uTextureFlowFrame");
            edge = uniform(material, "uTextureEdgeWarp");
            noise = uniform(material, "uListeningTextureNoiseScale");
            for (int i = 0; i < 3; i++) offsets[i] = uniform(material, "uSpeakingWatercolorOffset" + i);
            GLES30.glUseProgram(material);
            GLES30.glUniform1ui(uniform(material, "uPaletteIndex"), 0);
            GLES30.glUniform1i(uniform(material, "uImage_0"), 0);
            GLES30.glUseProgram(composite);
            GLES30.glUniform1i(uniform(composite, "uMaterial"), 0);
            GLES30.glUniform1i(uniform(composite, "uMask"), 1);
            scale = uniform(composite, "uScale");
            ready = true;
            Log.i("VoiceOrb", "Horizon GLES material ready: " + GLES30.glGetString(GLES30.GL_RENDERER));
        } catch (Exception error) {
            Log.e("VoiceOrb", "Horizon renderer initialization failed", error);
        }
    }

    @Override public void onSurfaceChanged(GL10 unused, int width, int height) {
        this.width = width;
        this.height = height;
    }

    @Override public void onDrawFrame(GL10 unused) {
        if (!ready) {
            GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0);
            GLES30.glClearColor(0, 0, 0, 0);
            GLES30.glClear(GLES30.GL_COLOR_BUFFER_BIT);
            return;
        }
        float level = audioLevel, active = inputActivity, time = waveFrame;
        GLES30.glDisable(GLES30.GL_BLEND);
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, vertexBuffer);
        GLES30.glEnableVertexAttribArray(0);
        GLES30.glVertexAttribPointer(0, 2, GLES30.GL_FLOAT, false, 0, 0);
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, framebuffer);
        GLES30.glViewport(0, 0, MATERIAL_SIZE, MATERIAL_SIZE);
        GLES30.glUseProgram(material);
        bind(0, watercolor);
        GLES30.glUniform1f(wave, time);
        GLES30.glUniform1f(base, baseFrame);
        GLES30.glUniform1f(amplitude, 1 + level * .5f);
        GLES30.glUniform1f(flow, time);
        GLES30.glUniform1f(edge, active * level * .102f);
        GLES30.glUniform1f(noise, 1 + active * level * 1.2f);
        for (int i = 0; i < 3; i++) {
            float phase = time / 24 * (.72f + i * .28f);
            GLES30.glUniform2f(offsets[i], (float) Math.sin(phase * .65f) * level * .03f,
                    (float) Math.cos(phase * .65f) * level * .03f);
        }
        GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 6);
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0);
        GLES30.glViewport(0, 0, width, height);
        GLES30.glClearColor(0, 0, 0, 0);
        GLES30.glClear(GLES30.GL_COLOR_BUFFER_BIT);
        GLES30.glUseProgram(composite);
        bind(0, interior);
        bind(1, maskTexture);
        GLES30.glUniform1f(scale, 1 + level * .035f);
        GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 6);
    }

    private static void bind(int unit, int texture) {
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0 + unit);
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texture);
    }

    private static int texture(Bitmap bitmap, boolean repeat) {
        int[] name = new int[1];
        GLES30.glGenTextures(1, name, 0);
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, name[0]);
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, repeat ? GLES30.GL_LINEAR_MIPMAP_LINEAR : GLES30.GL_LINEAR);
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR);
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_S, repeat ? GLES30.GL_REPEAT : GLES30.GL_CLAMP_TO_EDGE);
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_T, repeat ? GLES30.GL_REPEAT : GLES30.GL_CLAMP_TO_EDGE);
        if (bitmap != null) {
            GLUtils.texImage2D(GLES30.GL_TEXTURE_2D, 0, bitmap, 0);
            if (repeat) GLES30.glGenerateMipmap(GLES30.GL_TEXTURE_2D);
        }
        return name[0];
    }

    private static int uniform(int program, String name) { return GLES30.glGetUniformLocation(program, name); }

    private static int program(String vertex, String fragment) {
        int v = compile(GLES30.GL_VERTEX_SHADER, vertex), f = compile(GLES30.GL_FRAGMENT_SHADER, fragment);
        int program = GLES30.glCreateProgram();
        GLES30.glAttachShader(program, v);
        GLES30.glAttachShader(program, f);
        GLES30.glLinkProgram(program);
        GLES30.glDeleteShader(v);
        GLES30.glDeleteShader(f);
        int[] status = new int[1];
        GLES30.glGetProgramiv(program, GLES30.GL_LINK_STATUS, status, 0);
        if (status[0] == 0) throw new IllegalStateException(GLES30.glGetProgramInfoLog(program));
        return program;
    }

    private static int compile(int type, String source) {
        int shader = GLES30.glCreateShader(type);
        GLES30.glShaderSource(shader, source);
        GLES30.glCompileShader(shader);
        int[] status = new int[1];
        GLES30.glGetShaderiv(shader, GLES30.GL_COMPILE_STATUS, status, 0);
        if (status[0] == 0) throw new IllegalStateException(GLES30.glGetShaderInfoLog(shader));
        return shader;
    }
}
