package com.example.launcherprobe;

import net.sourceforge.pinyin4j.PinyinHelper;
import net.sourceforge.pinyin4j.format.HanyuPinyinCaseType;
import net.sourceforge.pinyin4j.format.HanyuPinyinOutputFormat;
import net.sourceforge.pinyin4j.format.HanyuPinyinToneType;
import net.sourceforge.pinyin4j.format.HanyuPinyinVCharType;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * Converts user wake words into the sherpa-onnx KWS keyword format: initials and toned finals separated by
 * spaces, then "@label". Chinese characters are converted with pinyin4j; users may instead type the tokens
 * directly to fix a polyphonic character, e.g. "n ǐ h ǎo x iǎo y ì".
 */
final class WakeWords {
    static final int MIN_SYLLABLES = 2, MAX_SYLLABLES = 8, MAX_WORDS = 4;
    private static final String[] INITIALS = {"zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h",
            "j", "q", "x", "r", "z", "c", "s", "y", "w"};
    private static final HanyuPinyinOutputFormat FORMAT = new HanyuPinyinOutputFormat();
    static {
        FORMAT.setCaseType(HanyuPinyinCaseType.LOWERCASE);
        FORMAT.setToneType(HanyuPinyinToneType.WITH_TONE_MARK);
        FORMAT.setVCharType(HanyuPinyinVCharType.WITH_U_UNICODE);
    }

    private WakeWords() { }

    /** Splits a settings value into individual wake words (comma, 、 or newline separated). */
    static List<String> split(String value) {
        List<String> words = new ArrayList<>();
        for (String part : (value == null ? "" : value).split("[,，、;；\\n]")) {
            String word = part.trim();
            if (!word.isEmpty() && !words.contains(word)) words.add(word);
        }
        if (words.isEmpty()) throw new IllegalArgumentException("请至少填写一个唤醒词");
        if (words.size() > MAX_WORDS) throw new IllegalArgumentException("最多设置 " + MAX_WORDS + " 个唤醒词");
        return words;
    }

    /** One keywords.txt line per word; throws with a user-facing message when a word cannot be spotted. */
    static String keywordsFile(List<String> words, Set<String> vocabulary) {
        StringBuilder out = new StringBuilder();
        for (String word : words) out.append(tokens(word, vocabulary)).append(" @").append(label(word)).append('\n');
        return out.toString();
    }

    static String tokens(String word, Set<String> vocabulary) {
        // The assistant name mixes Chinese and the letter E, pronounced yi.
        String value = word.trim().replace("小E", "小伊").replace("小e", "小伊");
        List<String> tokens = new ArrayList<>();
        int syllables = 0;
        if (value.codePoints().anyMatch(WakeWords::isHan)) {
            for (int i = 0; i < value.length(); i++) {
                char c = value.charAt(i);
                if (Character.isWhitespace(c)) continue;
                if (!isHan(c)) throw new IllegalArgumentException("唤醒词只能是汉字，或直接填写拼音记号：" + word);
                String syllable = pinyin(c);
                if (syllable == null) throw new IllegalArgumentException("无法识别的字「" + c + "」：" + word);
                tokens.addAll(syllable(syllable));
                syllables++;
            }
        } else {
            for (String token : value.split("\\s+")) {
                if (token.isEmpty()) continue;
                tokens.add(token);
                if (!isInitial(token)) syllables++;
            }
        }
        if (syllables < MIN_SYLLABLES) throw new IllegalArgumentException("唤醒词至少需要 " + MIN_SYLLABLES + " 个字：" + word);
        if (syllables > MAX_SYLLABLES) throw new IllegalArgumentException("唤醒词最多 " + MAX_SYLLABLES + " 个字：" + word);
        for (String token : tokens) {
            if (!vocabulary.contains(token)) throw new IllegalArgumentException("唤醒模型不支持读音「" + token + "」：" + word);
        }
        return String.join(" ", tokens);
    }

    /** Result labels cannot contain spaces. */
    static String label(String word) { return word.trim().replaceAll("\\s+", "_"); }

    static List<String> syllable(String pinyin) {
        List<String> parts = new ArrayList<>();
        for (String initial : INITIALS) {
            if (pinyin.startsWith(initial) && pinyin.length() > initial.length()) {
                parts.add(initial);
                parts.add(pinyin.substring(initial.length()));
                return parts;
            }
        }
        parts.add(pinyin);
        return parts;
    }

    private static String pinyin(char c) {
        try {
            String[] values = PinyinHelper.toHanyuPinyinStringArray(c, FORMAT);
            // pinyin4j marks some third tones with a breve (ă) where pinyin and the model use a caron (ǎ).
            return values == null || values.length == 0 ? null : values[0].replace('ă', 'ǎ').replace('ĕ', 'ě')
                    .replace('ĭ', 'ǐ').replace('ŏ', 'ǒ').replace('ŭ', 'ǔ');
        } catch (Exception invalid) { return null; }
    }

    private static boolean isInitial(String token) {
        for (String initial : INITIALS) if (initial.equals(token)) return true;
        return false;
    }

    private static boolean isHan(int codePoint) { return Character.UnicodeScript.of(codePoint) == Character.UnicodeScript.HAN; }
}
