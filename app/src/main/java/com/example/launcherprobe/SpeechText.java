package com.example.launcherprobe;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/** Turns assistant Markdown into text a speech engine can read, and splits it into engine-sized chunks. */
final class SpeechText {
    private static final Pattern FENCE = Pattern.compile("(?s)```.*?(```|$)|~~~.*?(~~~|$)");
    private static final Pattern IMAGE = Pattern.compile("!\\[([^\\]]*)]\\([^)]*\\)");
    private static final Pattern LINK = Pattern.compile("\\[([^\\]]+)]\\([^)]*\\)");
    private static final Pattern URL = Pattern.compile("https?://\\S+");
    private static final Pattern HTML = Pattern.compile("</?[A-Za-z][^>]*>");
    private static final Pattern HEADING = Pattern.compile("(?m)^\\s{0,3}#{1,6}\\s*");
    private static final Pattern QUOTE = Pattern.compile("(?m)^\\s*>+\\s?");
    private static final Pattern BULLET = Pattern.compile("(?m)^\\s*(?:[-*+]|\\d+[.)])\\s+(?:\\[[ xX]]\\s*)?");
    private static final Pattern RULE = Pattern.compile("(?m)^\\s*(?:[-*_]\\s*){3,}$");
    private static final Pattern TABLE_RULE = Pattern.compile("(?m)^\\s*\\|?\\s*:?-{2,}:?\\s*(\\|\\s*:?-{2,}:?\\s*)*\\|?\\s*$");
    private static final Pattern EMPHASIS = Pattern.compile("(\\*\\*|__|\\*|~~|`)");
    private static final Pattern MATH = Pattern.compile("\\$\\$?|\\\\[()\\[\\]]");

    private SpeechText() { }

    static String plain(String markdown) {
        if (markdown == null) return "";
        String text = FENCE.matcher(markdown).replaceAll("\n代码略。\n");
        text = IMAGE.matcher(text).replaceAll("$1");
        text = LINK.matcher(text).replaceAll("$1");
        text = URL.matcher(text).replaceAll("");
        text = HTML.matcher(text).replaceAll("");
        text = TABLE_RULE.matcher(text).replaceAll("");
        text = RULE.matcher(text).replaceAll("");
        text = HEADING.matcher(text).replaceAll("");
        text = QUOTE.matcher(text).replaceAll("");
        text = BULLET.matcher(text).replaceAll("");
        text = EMPHASIS.matcher(text).replaceAll("");
        text = MATH.matcher(text).replaceAll("");
        text = text.replace('|', ' ');
        StringBuilder out = new StringBuilder();
        for (String line : text.split("\n")) {
            String value = line.replaceAll("[ \\t\\u00A0]+", " ").trim();
            if (value.isEmpty()) continue;
            if (out.length() > 0) out.append(endsSentence(out) ? "\n" : "。\n");
            out.append(value);
        }
        return out.toString();
    }

    /** Splits at sentence boundaries; a sentence longer than max is split at max. */
    static List<String> chunks(String text, int max) {
        List<String> result = new ArrayList<>();
        StringBuilder current = new StringBuilder(), sentence = new StringBuilder();
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            sentence.append(c);
            boolean boundary = "。！？!?；;\n".indexOf(c) >= 0 || (c == '.' && (i + 1 == text.length() || Character.isWhitespace(text.charAt(i + 1))));
            if (boundary || sentence.length() >= max || i + 1 == text.length()) {
                if (current.length() + sentence.length() > max && current.length() > 0) { add(result, current); current.setLength(0); }
                current.append(sentence); sentence.setLength(0);
            }
        }
        add(result, current);
        return result;
    }

    private static void add(List<String> result, CharSequence value) {
        String chunk = value.toString().trim();
        if (!chunk.isEmpty()) result.add(chunk);
    }

    private static boolean endsSentence(StringBuilder out) {
        char last = out.charAt(out.length() - 1);
        return "。！？!?；;：:，,.".indexOf(last) >= 0;
    }
}
