package com.example.launcherprobe;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/** Validated cached annual data plus the APK fallback; recurrence never waits for network. */
final class ScheduleCalendar {
    static final String UNSUPPORTED = "所在国家或地区暂不支持法定节假日查询";
    static final ScheduleCalendar EMPTY = new ScheduleCalendar();
    private static final Set<String> CHINA_ZONES = Set.of("Asia/Shanghai", "Asia/Urumqi",
            "Asia/Chongqing", "Asia/Harbin", "Asia/Kashgar", "PRC");
    private final Set<Integer> years = new TreeSet<>();
    private final Map<LocalDate, Boolean> offDays = new HashMap<>();
    private final Map<Integer, JSONObject> annualData = new java.util.TreeMap<>();

    static boolean supports(ZoneId zone) { return CHINA_ZONES.contains(zone.getId()); }

    static ScheduleCalendar load(Context context) {
        ScheduleCalendar calendar = EMPTY;
        try (java.io.InputStream input = context.getAssets().open("cn-holidays.json")) {
            calendar = parse(new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8)));
        } catch (Exception failure) {
            Log.e("ScheduledTasks", "Holiday snapshot unavailable; using explicit weekday fallback", failure);
        }
        java.io.File directory = new java.io.File(context.getFilesDir(), "schedule-calendar");
        java.io.File[] files = directory.listFiles((dir, name) -> name.matches("[0-9]{4}\\.json"));
        if (files != null) {
            java.util.Arrays.sort(files);
            for (java.io.File file : files) {
                try (java.io.InputStream input = new android.util.AtomicFile(file).openRead()) {
                    JSONObject year = new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
                    if (!file.getName().equals(ScheduleRule.integer(year, "year") + ".json"))
                        throw new IllegalArgumentException("Calendar cache filename/year mismatch");
                    calendar = calendar.withYear(year);
                } catch (Exception failure) {
                    Log.e("ScheduledTasks", "Ignoring invalid holiday cache " + file.getName(), failure);
                }
            }
        }
        return calendar;
    }

    ScheduleCalendar withYear(JSONObject entry) throws Exception {
        int year = ScheduleRule.integer(entry, "year");
        Map<Integer, JSONObject> merged = new java.util.TreeMap<>(annualData);
        merged.put(year, entry);
        JSONArray annual = new JSONArray();
        for (JSONObject value : merged.values()) annual.put(value);
        return parse(new JSONObject().put("years", annual));
    }

    String version() {
        StringBuilder value = new StringBuilder();
        for (Map.Entry<Integer, JSONObject> year : annualData.entrySet())
            value.append(year.getKey()).append(":").append(year.getValue().optString("sourceBlobSha",
                    year.getValue().optString("sourceCommit"))).append(";");
        return value.toString();
    }

    static ScheduleCalendar parse(JSONObject value) throws Exception {
        if (value.has("sourceCommit") && !ScheduleRule.text(value, "sourceCommit").matches("[a-f0-9]{40}"))
            throw new IllegalArgumentException("Invalid calendar source commit");
        ScheduleCalendar calendar = new ScheduleCalendar();
        JSONArray annual = value.getJSONArray("years");
        if (annual.length() == 0) throw new IllegalArgumentException("Missing verified coverage");
        for (int i = 0; i < annual.length(); i++) {
            JSONObject entry = annual.getJSONObject(i);
            int year = ScheduleRule.integer(entry, "year");
            if (year < 2007 || year > 2100 || !calendar.years.add(year))
                throw new IllegalArgumentException("Invalid calendar coverage");
            entry = new JSONObject(entry.toString());
            if (value.has("sourceCommit")) entry.put("sourceCommit", value.getString("sourceCommit"));
            if (entry.has("sourceCommit")) {
                if (!ScheduleRule.text(entry, "sourceCommit").matches("[a-f0-9]{40}"))
                    throw new IllegalArgumentException("Invalid calendar source commit");
            } else if (!ScheduleCalendarRefresh.url(year).equals(ScheduleRule.text(entry, "sourceUrl"))
                    || !ScheduleRule.text(entry, "sourceBlobSha").matches("[a-f0-9]{40}")
                    || !(entry.opt("fetchedAt") instanceof Number)) {
                throw new IllegalArgumentException("Invalid calendar download provenance");
            }
            calendar.annualData.put(year, entry);
            JSONArray papers = entry.getJSONArray("papers");
            if (papers.length() == 0) throw new IllegalArgumentException("Unpublished calendar");
            for (int j = 0; j < papers.length(); j++) {
                Object paper = papers.get(j);
                if (!(paper instanceof String) || !((String) paper).startsWith("https://www.gov.cn/"))
                    throw new IllegalArgumentException("Missing official calendar source");
            }
            JSONArray days = entry.getJSONArray("days");
            if (days.length() == 0) throw new IllegalArgumentException("Empty annual calendar");
            Set<LocalDate> seen = new HashSet<>();
            for (int j = 0; j < days.length(); j++) {
                JSONObject day = days.getJSONObject(j);
                String date = ScheduleRule.text(day, "date");
                if (!date.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}"))
                    throw new IllegalArgumentException("Invalid calendar date");
                LocalDate local = LocalDate.parse(date);
                Object off = day.get("isOffDay");
                if (!(off instanceof Boolean) || Math.abs(local.getYear() - year) > 1 || !seen.add(local))
                    throw new IllegalArgumentException("Invalid calendar day");
                Boolean previous = calendar.offDays.put(local, (Boolean) off);
                if (previous != null && !previous.equals(off))
                    throw new IllegalArgumentException("Conflicting calendar day");
            }
        }
        return calendar;
    }

    boolean isWorkday(LocalDate day, ZoneId zone) {
        if (CHINA_ZONES.contains(zone.getId())) {
            Boolean off = offDays.get(day);
            if (off != null) return !off;
        }
        return day.getDayOfWeek().getValue() <= 5;
    }

    /** Notices describe every year searched, not just the year of the selected occurrence. */
    void describe(JSONObject result, ScheduleRule rule, long after, long next, ZoneId zone) throws Exception {
        if (!rule.isStatutory()) return;
        String fallback = "statutoryWorkday".equals(rule.repeat) ? "周一至周五" : "周六日";
        result.put("calendarFallback", "暂按" + fallback + "执行");
        if (!CHINA_ZONES.contains(zone.getId())) {
            result.put("calendarNotice", UNSUPPORTED);
            return;
        }
        if (!years.isEmpty()) {
            String coverage = years.toString().replace("[", "").replace("]", "");
            result.put("calendarCoverage", "中国大陆 · " + coverage + " 年节假日安排");
        }
        int first = Instant.ofEpochMilli(after).atZone(zone).getYear();
        int last = Instant.ofEpochMilli(next).atZone(zone).getYear();
        for (int year = first; year <= last; year++) {
            if (!years.contains(year)) {
                result.put("calendarNotice", year + " 年法定节假日数据暂未公布或未更新");
                return;
            }
        }
        result.remove("calendarFallback");
    }
}
