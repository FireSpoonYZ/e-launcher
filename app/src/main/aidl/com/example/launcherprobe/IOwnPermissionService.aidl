package com.example.launcherprobe;

interface IOwnPermissionService {
    String grantOwnWriteSecureSettings() = 1;
    String setOwnDefaultHome() = 2;
    String startShowerServer(String handoffToken) = 3;
    String stopShowerServer() = 4;
    void destroy() = 16777114;
}
