package com.example.launcherprobe;

interface IOwnPermissionService {
    String grantOwnWriteSecureSettings() = 1;
    String startShowerServer(String handoffToken) = 3;
    String stopShowerServer() = 4;
    String setOwnDefaultAssistant() = 5;
    void destroy() = 16777114;
}
