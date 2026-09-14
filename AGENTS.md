# 项目开发说明

## Android 构建

Windows 上使用仓库根目录的 Gradle Wrapper。常规编译：

```powershell
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:JAVA_HOME = "$env:ProgramFiles\Microsoft\jdk-21.0.9.10-hotspot"
.\gradlew.bat build --no-daemon --console=plain
```

后台构建统一加上 `--no-daemon --console=plain`，避免长期驻留的 Gradle Daemon 影响后台工具结束判定，并使用普通文本日志。通过 PowerShell 包装构建命令时，末尾加上 `exit $LASTEXITCODE`，将 Gradle 退出码传给后台工具。

完整检查用 `scripts/verify.ps1`，该脚本要求 `JAVA_HOME` 指向 JDK 21，未设置 `ANDROID_HOME` 时使用 `%LOCALAPPDATA%\Android\Sdk`，并通过 `gradlew.bat` 执行 assemble、lint 和单元测试。

不要提交 `local.properties`。需要代理时写在用户级 `~/.gradle/gradle.properties`。

## 临时文件

设计稿、真机截图、录像、日志和一次性脚本放在仓库外的临时目录，不在项目中建立 `design/` 或 `evidence/`。构建与测试的生成文件放在已忽略的 `build/` 目录；可重复运行的验证脚本保留在 `scripts/`。
