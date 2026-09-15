package com.example.launcherprobe;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

import java.time.Instant;
import java.time.ZoneId;

public class ScheduleRuleTest {
    private static final ZoneId UTC = ZoneId.of("UTC");
    private static long at(String value) { return Instant.parse(value).toEpochMilli(); }

    @Test public void dailyUsesTheNextStrictlyFutureLocalTime() {
        ScheduleRule rule = new ScheduleRule("daily", "08:00", 1, 1);
        assertEquals(at("2026-09-15T08:00:00Z"), rule.nextAfter(at("2026-09-15T07:59:59Z"), UTC));
        assertEquals(at("2026-09-16T08:00:00Z"), rule.nextAfter(at("2026-09-15T08:00:00Z"), UTC));
        assertEquals(at("2026-09-16T00:00:00Z"), rule.nextAfter(at("2026-09-15T00:00:00Z"), ZoneId.of("Asia/Shanghai")));
    }

    @Test public void weeklyHandlesWeekAndYearBoundaries() {
        ScheduleRule friday = new ScheduleRule("weekly", "18:00", 5, 1);
        assertEquals(at("2026-09-18T18:00:00Z"), friday.nextAfter(at("2026-09-15T09:00:00Z"), UTC));
        assertEquals(at("2026-09-25T18:00:00Z"), friday.nextAfter(at("2026-09-18T18:00:00Z"), UTC));
        ScheduleRule monday = new ScheduleRule("weekly", "00:00", 1, 1);
        assertEquals(at("2027-01-04T00:00:00Z"), monday.nextAfter(at("2026-12-31T23:59:59Z"), UTC));
    }

    @Test public void monthlySkipsMissingDatesAndHonorsLeapYears() {
        ScheduleRule last31 = new ScheduleRule("monthly", "20:00", 1, 31);
        assertEquals(at("2026-05-31T20:00:00Z"), last31.nextAfter(at("2026-04-01T00:00:00Z"), UTC));
        assertEquals(at("2027-01-31T20:00:00Z"), last31.nextAfter(at("2026-12-31T20:00:00Z"), UTC));
        ScheduleRule day29 = new ScheduleRule("monthly", "08:00", 1, 29);
        assertEquals(at("2027-03-29T08:00:00Z"), day29.nextAfter(at("2027-02-01T00:00:00Z"), UTC));
        assertEquals(at("2028-02-29T08:00:00Z"), day29.nextAfter(at("2028-02-01T00:00:00Z"), UTC));
    }

    @Test public void dstGapsShiftForwardAndOverlapsDoNotRunTwice() {
        ZoneId zone = ZoneId.of("America/New_York");
        ScheduleRule gap = new ScheduleRule("daily", "02:30", 1, 1);
        assertEquals(at("2026-03-08T07:30:00Z"), gap.nextAfter(at("2026-03-08T05:00:00Z"), zone));
        ScheduleRule overlap = new ScheduleRule("daily", "01:30", 1, 1);
        assertEquals(at("2026-11-01T05:30:00Z"), overlap.nextAfter(at("2026-11-01T04:00:00Z"), zone));
        assertEquals(at("2026-11-02T06:30:00Z"), overlap.nextAfter(at("2026-11-01T05:30:00Z"), zone));
    }

    @Test public void rejectsUnsupportedOrMalformedRules() {
        for (String repeat : new String[] {"workday", "weekend", "once", "", "DAILY"})
            assertThrows(IllegalArgumentException.class, () -> new ScheduleRule(repeat, "08:00", 1, 1));
        for (String time : new String[] {"24:00", "8:00", "12:60", "12:00:00", "", "-1:00"})
            assertThrows(IllegalArgumentException.class, () -> new ScheduleRule("daily", time, 1, 1));
        assertThrows(IllegalArgumentException.class, () -> new ScheduleRule("weekly", "08:00", 0, 1));
        assertThrows(IllegalArgumentException.class, () -> new ScheduleRule("monthly", "08:00", 1, 32));
    }
}
