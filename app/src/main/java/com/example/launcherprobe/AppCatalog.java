package com.example.launcherprobe;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;

/** Current-user installed apps exposed to the read-only Pi tools. */
final class AppCatalog {
    private final PackageManager packages;

    AppCatalog(Context context) {
        packages = context.getPackageManager();
    }

    JSONArray execute(JSONObject arguments) throws Exception {
        if (arguments == null) throw new IllegalArgumentException("缺少应用查询参数");
        return switch (arguments.optString("action", "")) {
            case "list" -> select(installed(), null);
            case "search" -> {
                Object value = arguments.opt("query");
                if (!(value instanceof String query) || query.trim().isEmpty()) {
                    throw new IllegalArgumentException("query 必须是非空关键词");
                }
                yield select(installed(), query);
            }
            default -> throw new IllegalArgumentException("未知应用查询 action");
        };
    }

    private List<ApplicationInfo> installed() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return packages.getInstalledApplications(PackageManager.ApplicationInfoFlags.of(0));
        }
        return installedLegacy();
    }

    @SuppressWarnings("deprecation")
    private List<ApplicationInfo> installedLegacy() {
        return packages.getInstalledApplications(0);
    }

    private JSONArray select(List<ApplicationInfo> installed, String query) throws Exception {
        JSONArray result = new JSONArray();
        for (ApplicationInfo app : installed) {
            String label = app.loadLabel(packages).toString();
            if (query == null || AppSearch.matches(label, app.packageName, query)) {
                result.put(new JSONObject().put("label", label).put("packageName", app.packageName));
            }
        }
        return result;
    }
}
