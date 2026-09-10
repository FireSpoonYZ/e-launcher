package com.example.launcherprobe;

import android.content.Context;
import android.net.Uri;
import android.text.Spanned;
import android.widget.TextView;

import java.util.HashMap;
import java.util.Map;
import java.util.function.Consumer;
import java.util.regex.Pattern;

import org.commonmark.node.Node;

import io.noties.markwon.AbstractMarkwonPlugin;
import io.noties.markwon.Markwon;
import io.noties.markwon.MarkwonConfiguration;
import io.noties.markwon.ext.latex.JLatexMathNode;
import io.noties.markwon.ext.latex.JLatexMathPlugin;
import io.noties.markwon.ext.strikethrough.StrikethroughPlugin;
import io.noties.markwon.ext.tables.TablePlugin;
import io.noties.markwon.ext.tasklist.TaskListPlugin;
import io.noties.markwon.image.AsyncDrawableSpan;
import io.noties.markwon.inlineparser.BackslashInlineProcessor;
import io.noties.markwon.inlineparser.InlineProcessor;
import io.noties.markwon.inlineparser.MarkwonInlineParserPlugin;

/** Native Markdown; math delimiters are parsed as nodes, never rewritten inside code. */
final class ResponseMarkdown {
    static Markwon create(Context context, Consumer<Uri> openLink) {
        return Markwon.builder(context)
                .usePlugin(io.noties.markwon.movement.MovementMethodPlugin.link())
                .usePlugin(TablePlugin.create(context))
                .usePlugin(StrikethroughPlugin.create())
                .usePlugin(TaskListPlugin.create(context))
                .usePlugin(MarkwonInlineParserPlugin.create(builder -> builder
                        .excludeInlineProcessor(BackslashInlineProcessor.class)
                        .addInlineProcessor(new MathDelimiter('\\', Pattern.compile(
                                "\\\\\\(([\\s\\S]+?)\\\\\\)|\\\\\\[([\\s\\S]+?)\\\\\\]")))
                        .addInlineProcessor(new BackslashInlineProcessor())
                        .addInlineProcessor(new MathDelimiter('$', Pattern.compile(
                                "\\$(?!\\$)([^\\s$](?:[^$\\n]*?[^\\s$])?)\\$(?![\\d$])")))))
                .usePlugin(JLatexMathPlugin.create(16 * context.getResources().getDisplayMetrics().scaledDensity,
                        builder -> builder.inlinesEnabled(true)))
                .usePlugin(new AbstractMarkwonPlugin() {
                    @Override public void beforeSetText(TextView view, Spanned next) {
                        if (!(view.getText() instanceof Spanned)) return;
                        Spanned previous = (Spanned) view.getText();
                        Map<Integer, AsyncDrawableSpan> ready = new HashMap<>();
                        for (AsyncDrawableSpan span : previous.getSpans(0, previous.length(), AsyncDrawableSpan.class)) {
                            if (span.getDrawable().hasResult()) ready.put(previous.getSpanStart(span), span);
                        }
                        // Keep completed formulas visible while more text streams into the same view.
                        for (AsyncDrawableSpan span : next.getSpans(0, next.length(), AsyncDrawableSpan.class)) {
                            AsyncDrawableSpan old = ready.get(next.getSpanStart(span));
                            if (old != null && old.getDrawable().getDestination().equals(span.getDrawable().getDestination())
                                    && previous.getSpanEnd(old) == next.getSpanEnd(span)) {
                                span.getDrawable().setResult(old.getDrawable().getResult());
                            }
                        }
                    }

                    @Override public void configureConfiguration(MarkwonConfiguration.Builder builder) {
                        builder.linkResolver((view, link) -> {
                            if (isWebLink(link)) openLink.accept(Uri.parse(link));
                        });
                    }
                })
                .build();
    }

    static boolean isWebLink(String link) {
        Uri uri = Uri.parse(link);
        return ("https".equalsIgnoreCase(uri.getScheme()) || "http".equalsIgnoreCase(uri.getScheme()))
                && uri.getHost() != null && !uri.getHost().isEmpty();
    }

    /** Markwon supplies $$; accept the other common model-output delimiters too. */
    private static final class MathDelimiter extends InlineProcessor {
        private final char character;
        private final Pattern pattern;

        MathDelimiter(char character, Pattern pattern) {
            this.character = character;
            this.pattern = pattern;
        }

        @Override public char specialCharacter() { return character; }

        @Override protected Node parse() {
            String source = match(pattern);
            if (source == null) return null;
            int delimiter = character == '$' ? 1 : 2;
            JLatexMathNode node = new JLatexMathNode();
            node.latex((source.startsWith("\\[") ? "\\displaystyle " : "")
                    + source.substring(delimiter, source.length() - delimiter));
            return node;
        }
    }
}
