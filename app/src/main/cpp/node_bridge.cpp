#include <jni.h>
#include <node.h>
#include <cstdlib>
#include <string>
#include <thread>
#include <vector>
#include <android/log.h>

extern "C" JNIEXPORT void JNICALL
Java_com_example_launcherprobe_PiAgentBridge_startNode(JNIEnv* env, jclass, jstring script_, jstring socket_, jstring home_) {
    const char* scriptChars = env->GetStringUTFChars(script_, nullptr);
    const char* socketChars = env->GetStringUTFChars(socket_, nullptr);
    const char* homeChars = env->GetStringUTFChars(home_, nullptr);
    std::string script(scriptChars), socket(socketChars), home(homeChars);
    env->ReleaseStringUTFChars(script_, scriptChars);
    env->ReleaseStringUTFChars(socket_, socketChars);
    env->ReleaseStringUTFChars(home_, homeChars);
    std::thread([script, socket, home]() {
        setenv("HOME", home.c_str(), 1);
        setenv("TMPDIR", home.c_str(), 1);
        std::vector<std::string> values = {"node", script, socket};
        std::vector<char*> argv;
        for (auto& value : values) argv.push_back(value.data());
        int result = node::Start(static_cast<int>(argv.size()), argv.data());
        __android_log_print(ANDROID_LOG_ERROR, "PiNode", "node::Start exited: %d", result);
    }).detach();
}
