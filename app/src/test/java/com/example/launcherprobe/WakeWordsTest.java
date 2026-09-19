package com.example.launcherprobe;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

import org.junit.Test;

import static org.junit.Assert.*;

public class WakeWordsTest {
    // Lines published with sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20 and the wenetspeech 3.3M model.
    private static final String[][] OFFICIAL = {
            {"文森特卡索", "w én s ēn t è k ǎ s uǒ"}, {"周望军", "zh ōu w àng j ūn"}, {"朱丽楠", "zh ū l ì n án"},
            {"蒋友伯", "j iǎng y ǒu b ó"}, {"女儿", "n ǚ ér"}, {"法国", "f ǎ g uó"}, {"见面会", "j iàn m iàn h uì"},
            {"落实", "l uò sh í"}, {"你好军哥", "n ǐ h ǎo j ūn g ē"}, {"小爱同学", "x iǎo ài t óng x ué"},
            {"你好问问", "n ǐ h ǎo w èn w èn"}, {"小艺小艺", "x iǎo y ì x iǎo y ì"}, {"小米小米", "x iǎo m ǐ x iǎo m ǐ"},
            {"林美丽", "l ín m ěi l ì"},
    };

    @Test public void chineseMatchesOfficialKeywordTokens() {
        Set<String> vocabulary = new HashSet<>();
        for (String[] line : OFFICIAL) vocabulary.addAll(Arrays.asList(line[1].split(" ")));
        for (String[] line : OFFICIAL) assertEquals(line[0], line[1], WakeWords.tokens(line[0], vocabulary));
        assertEquals("x iǎo ài t óng x ué @小爱同学\nn ǚ ér @女儿\n",
                WakeWords.keywordsFile(Arrays.asList("小爱同学", "女儿"), vocabulary));
    }

    @Test public void typedTokensOverridePolyphonicReadings() {
        Set<String> vocabulary = new HashSet<>(Arrays.asList("n", "ǐ", "h", "ǎo", "ào"));
        assertEquals("n ǐ h ào", WakeWords.tokens(" n ǐ  h ào ", vocabulary));
        assertEquals("n_ǐ_h_ào", WakeWords.label("n ǐ h ào"));
    }

    @Test public void rejectsWordsTheModelCannotSpot() {
        Set<String> vocabulary = new HashSet<>(Arrays.asList("n", "ǐ", "h", "ǎo"));
        assertThrows(IllegalArgumentException.class, () -> WakeWords.tokens("你", vocabulary));
        assertThrows(IllegalArgumentException.class, () -> WakeWords.tokens("你好E", vocabulary));
        assertThrows(IllegalArgumentException.class, () -> WakeWords.tokens("你好呀", vocabulary));
        assertThrows(IllegalArgumentException.class, () -> WakeWords.tokens("n ǐ h ǎo zz", vocabulary));
        assertThrows(IllegalArgumentException.class, () -> WakeWords.tokens("你好你好你好你好你好", vocabulary));
        assertThrows(IllegalArgumentException.class, () -> WakeWords.split(" ，\n"));
        assertThrows(IllegalArgumentException.class, () -> WakeWords.split("一一,二二,三三,四四,五五"));
        assertEquals(Arrays.asList("小易小易", "你好小易"), WakeWords.split("小易小易，你好小易\n小易小易"));
        assertEquals(Collections.singletonList("x"), WakeWords.syllable("x"));
    }
}
