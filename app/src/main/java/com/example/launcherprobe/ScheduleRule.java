package com.example.launcherprobe;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.Arrays;

/** Wall-clock recurrence; a missing monthly date is skipped, never clamped. */
final class ScheduleRule {
    final String repeat;
    final LocalTime time;
    final int weekday;
    final int monthDay;
    final int[] weekdays;
    final long runAt;

    ScheduleRule(String repeat, String time, int weekday, int monthDay) {
        this(repeat, time, new int[]{weekday}, monthDay, 0);
    }

    private ScheduleRule(String repeat, String time, int[] weekdays, int monthDay, long runAt) {
        if (!("once".equals(repeat) || "daily".equals(repeat) || "weekly".equals(repeat) || "monthly".equals(repeat)
                || "statutoryWorkday".equals(repeat) || "statutoryHoliday".equals(repeat)))
            throw new IllegalArgumentException("请选择有效的重复方式");
        if (weekdays.length == 0 || weekdays.length > 7) throw new IllegalArgumentException("请至少选择一个执行日");
        weekdays = weekdays.clone();
        Arrays.sort(weekdays);
        for (int i = 0; i < weekdays.length; i++) {
            if (weekdays[i] < 1 || weekdays[i] > 7 || (i > 0 && weekdays[i] == weekdays[i - 1]))
                throw new IllegalArgumentException("执行日需为不重复的周一至周日");
        }
        int weekday = weekdays[0];
        if (time == null) throw new IllegalArgumentException("请选择有效的执行时间");
        validateTime(time);
        if (monthDay < 1 || monthDay > 31) throw new IllegalArgumentException("请选择 1 至 31 日");
        this.repeat = "weekly".equals(repeat) && weekdays.length == 7 ? "daily" : repeat;
        this.weekdays = weekdays;
        this.time = LocalTime.parse(time);
        this.weekday = weekday;
        this.monthDay = monthDay;
        this.runAt = runAt;
    }

    static ScheduleRule fromJson(JSONObject value) {
        return fromJson(value, System.currentTimeMillis(), ZoneId.systemDefault());
    }

    static ScheduleRule fromJson(JSONObject value, long now, ZoneId zone) {
        String repeat = text(value, "repeat");
        if (value.has("date") && value.has("delayMinutes"))
            throw new IllegalArgumentException("date 与 delayMinutes 不能同时指定");
        if (!"once".equals(repeat) && (value.has("date") || value.has("delayMinutes") || value.has("runAt")))
            throw new IllegalArgumentException("日期、延后分钟和 runAt 仅用于一次性任务");
        long runAt = value.has("runAt") ? positiveLong(value, "runAt") : 0;
        String time;
        if (value.has("delayMinutes")) {
            long minutes = positiveLong(value, "delayMinutes");
            try { runAt = Math.addExact(now, Math.multiplyExact(minutes, 60_000L)); }
            catch (ArithmeticException failure) { throw new IllegalArgumentException("延后分钟超出支持范围"); }
            if (runAt <= 0) throw new IllegalArgumentException("执行时间必须为正数");
            if (value.has("time")) validateTime(text(value, "time"));
            time = Instant.ofEpochMilli(runAt).atZone(zone).toLocalTime()
                    .withSecond(0).withNano(0).toString();
        } else {
            time = text(value, "time");
            validateTime(time);
            if (value.has("date")) {
                String date = text(value, "date");
                if (!date.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}"))
                    throw new IllegalArgumentException("date 必须为 YYYY-MM-DD");
                try { runAt = LocalDate.parse(date).atTime(LocalTime.parse(time)).atZone(zone).toInstant().toEpochMilli(); }
                catch (java.time.DateTimeException failure) { throw new IllegalArgumentException("请选择有效的执行日期"); }
                if (runAt <= now) throw new IllegalArgumentException("执行日期和时间必须在未来");
            }
        }
        int[] days = {1};
        if ("weekly".equals(repeat)) {
            if (value.has("weekdays")) {
                Object raw = value.opt("weekdays");
                if (!(raw instanceof JSONArray)) throw new IllegalArgumentException("weekdays 必须是数组");
                JSONArray array = (JSONArray) raw;
                if (array.length() == 0 || array.length() > 7) throw new IllegalArgumentException("请至少选择一个执行日，最多七个");
                days = new int[array.length()];
                for (int i = 0; i < days.length; i++) {
                    Object day = array.opt(i);
                    if (!(day instanceof Number) || ((Number) day).doubleValue() != ((Number) day).intValue())
                        throw new IllegalArgumentException("执行日必须是整数");
                    days[i] = ((Number) day).intValue();
                }
            } else days = new int[]{integer(value, "weekday")};
        }
        return new ScheduleRule(repeat, time, days,
                "monthly".equals(repeat) ? integer(value, "monthDay") : 1, runAt);
    }

    boolean isStatutory() {
        return "statutoryWorkday".equals(repeat) || "statutoryHoliday".equals(repeat);
    }

    long nextAfter(long after, ZoneId zone) {
        return nextAfter(after, zone, ScheduleCalendar.EMPTY);
    }

    long nextAfter(long after, ZoneId zone, ScheduleCalendar calendar) {
        if (runAt > 0) return runAt > after ? runAt : 0;
        Instant instant = Instant.ofEpochMilli(after);
        for (LocalDate day = instant.atZone(zone).toLocalDate(); ; day = day.plusDays(1)) {
            if ("weekly".equals(repeat) && Arrays.binarySearch(weekdays, day.getDayOfWeek().getValue()) < 0) continue;
            if ("monthly".equals(repeat) && day.getDayOfMonth() != monthDay) continue;
            if (isStatutory() && calendar.isWorkday(day, zone) != "statutoryWorkday".equals(repeat)) continue;
            // java.time shifts DST gaps forward and chooses the first offset in an overlap.
            long candidate = day.atTime(time).atZone(zone).toInstant().toEpochMilli();
            if (candidate > after) return candidate;
        }
    }

    JSONObject json() throws JSONException {
        JSONObject value = new JSONObject().put("repeat", repeat).put("time", time.toString())
                .put("weekday", weekday).put("monthDay", monthDay);
        if (runAt > 0) value.put("runAt", runAt);
        if ("weekly".equals(repeat)) {
            JSONArray days = new JSONArray();
            for (int day : weekdays) days.put(day);
            value.put("weekdays", days);
        }
        return value;
    }

    private static void validateTime(String time) {
        if (!time.matches("(?:[01][0-9]|2[0-3]):[0-5][0-9]"))
            throw new IllegalArgumentException("请选择有效的执行时间");
    }

    static long positiveLong(JSONObject value, String key) {
        Object raw = value.opt(key);
        if (!(raw instanceof Number)) throw new IllegalArgumentException(key + " 必须是正整数");
        try {
            long result = new BigDecimal(raw.toString()).longValueExact();
            if (result > 0) return result;
        } catch (NumberFormatException | ArithmeticException ignored) { }
        throw new IllegalArgumentException(key + " 必须是支持范围内的正整数");
    }

    static String text(JSONObject value, String key) {
        Object raw = value.opt(key);
        if (!(raw instanceof String)) throw new IllegalArgumentException(key + " 必须是文本");
        return (String) raw;
    }

    static boolean bool(JSONObject value, String key, boolean fallback) {
        if (!value.has(key)) return fallback;
        Object raw = value.opt(key);
        if (!(raw instanceof Boolean)) throw new IllegalArgumentException(key + " 必须是布尔值");
        return (Boolean) raw;
    }

    static int integer(JSONObject value, String key) {
        Object raw = value.opt(key);
        if (!(raw instanceof Number) || ((Number) raw).doubleValue() != ((Number) raw).intValue())
            throw new IllegalArgumentException(key + " 必须是整数");
        return ((Number) raw).intValue();
    }
}
