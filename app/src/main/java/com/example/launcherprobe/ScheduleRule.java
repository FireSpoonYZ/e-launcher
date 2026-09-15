package com.example.launcherprobe;

import org.json.JSONException;
import org.json.JSONObject;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;

/** Wall-clock recurrence; a missing monthly date is skipped, never clamped. */
final class ScheduleRule {
    final String repeat;
    final LocalTime time;
    final int weekday;
    final int monthDay;

    ScheduleRule(String repeat, String time, int weekday, int monthDay) {
        if (!("daily".equals(repeat) || "weekly".equals(repeat) || "monthly".equals(repeat)))
            throw new IllegalArgumentException("请选择每天、每周或每月");
        if (time == null || !time.matches("(?:[01][0-9]|2[0-3]):[0-5][0-9]"))
            throw new IllegalArgumentException("请选择有效的执行时间");
        if (weekday < 1 || weekday > 7) throw new IllegalArgumentException("请选择周一至周日");
        if (monthDay < 1 || monthDay > 31) throw new IllegalArgumentException("请选择 1 至 31 日");
        this.repeat = repeat;
        this.time = LocalTime.parse(time);
        this.weekday = weekday;
        this.monthDay = monthDay;
    }

    static ScheduleRule fromJson(JSONObject value) {
        String repeat = text(value, "repeat");
        return new ScheduleRule(repeat, text(value, "time"),
                "weekly".equals(repeat) ? integer(value, "weekday") : 1,
                "monthly".equals(repeat) ? integer(value, "monthDay") : 1);
    }

    long nextAfter(long after, ZoneId zone) {
        Instant instant = Instant.ofEpochMilli(after);
        for (LocalDate day = instant.atZone(zone).toLocalDate(); ; day = day.plusDays(1)) {
            if ("weekly".equals(repeat) && day.getDayOfWeek().getValue() != weekday) continue;
            if ("monthly".equals(repeat) && day.getDayOfMonth() != monthDay) continue;
            // java.time shifts DST gaps forward and chooses the first offset in an overlap.
            long candidate = day.atTime(time).atZone(zone).toInstant().toEpochMilli();
            if (candidate > after) return candidate;
        }
    }

    JSONObject json() throws JSONException {
        return new JSONObject().put("repeat", repeat).put("time", time.toString())
                .put("weekday", weekday).put("monthDay", monthDay);
    }

    static String text(JSONObject value, String key) {
        Object raw = value.opt(key);
        if (!(raw instanceof String)) throw new IllegalArgumentException(key + " 必须是文本");
        return (String) raw;
    }

    static int integer(JSONObject value, String key) {
        Object raw = value.opt(key);
        if (!(raw instanceof Number) || ((Number) raw).doubleValue() != ((Number) raw).intValue())
            throw new IllegalArgumentException(key + " 必须是整数");
        return ((Number) raw).intValue();
    }
}
