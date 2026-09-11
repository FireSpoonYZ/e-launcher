package com.example.launcherprobe;

interface IOwnPermissionService {
    String grantOwnWriteSecureSettings() = 1;
    String setOwnDefaultHome() = 2;
    void destroy() = 16777114;
}
