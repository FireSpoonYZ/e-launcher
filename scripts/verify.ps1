$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location (Split-Path $PSScriptRoot -Parent)
$env:JAVA_HOME = "$env:LOCALAPPDATA\e-launcher-tools\jdk-17"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
$gradle = "$env:LOCALAPPDATA\e-launcher-tools\gradle-8.11.1\bin\gradle.bat"

# Pure Java production code, no Android stubs or test dependencies.
$classes = '.pi\test-classes'
New-Item -ItemType Directory -Force $classes | Out-Null
& "$env:JAVA_HOME\bin\javac.exe" '-J-Duser.language=en' -encoding UTF-8 -d $classes `
    app/src/main/java/com/example/launcherprobe/AgentLoop.java `
    app/src/main/java/com/example/launcherprobe/ActionFence.java `
    app/src/main/java/com/example/launcherprobe/AgentHistory.java `
    app/src/main/java/com/example/launcherprobe/AttemptAll.java `
    app/src/main/java/com/example/launcherprobe/AppSearch.java `
    app/src/main/java/com/example/launcherprobe/ExactText.java `
    app/src/main/java/com/example/launcherprobe/ObservationRegistry.java `
    app/src/main/java/com/example/launcherprobe/ProviderConfig.java `
    app/src/main/java/com/example/launcherprobe/ReasoningEffort.java `
    app/src/main/java/com/example/launcherprobe/RunEpoch.java `
    app/src/main/java/com/example/launcherprobe/SwipeDetector.java `
    app/src/main/java/com/example/launcherprobe/NavigationSession.java `
    app/src/main/java/com/example/launcherprobe/SearchConfig.java `
    app/src/main/java/com/example/launcherprobe/SearchParser.java `
    app/src/main/java/com/example/launcherprobe/ScreenNodePolicy.java `
    app/src/main/java/com/example/launcherprobe/WebAddressPolicy.java `
    tests/com/example/launcherprobe/AgentChecks.java `
    tests/com/example/launcherprobe/GestureChecks.java
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& "$env:JAVA_HOME\bin\java.exe" -ea -cp $classes com.example.launcherprobe.GestureChecks
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& "$env:JAVA_HOME\bin\java.exe" -ea -cp $classes com.example.launcherprobe.AgentChecks
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& $gradle --no-daemon :app:testDebugUnitTest :app:assembleDebug :app:lintDebug
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Existing style: spaces (not tabs), no trailing whitespace, final newline.
$files = @(Get-ChildItem app/src, tests, scripts -Recurse -File |
    Where-Object { $_.Extension -in '.java', '.xml', '.ps1' })
$files += Get-Item app/build.gradle, build.gradle, settings.gradle, README.md, THIRD_PARTY_NOTICES.md
foreach ($file in $files) {
    $text = [IO.File]::ReadAllText($file.FullName, [Text.Encoding]::UTF8)
    if ($text -match "`t|(?m)[ ]+`r?$" -or -not $text.EndsWith("`n")) {
        throw "Style check failed: $($file.FullName)"
    }
}
Write-Output "PASS: style check ($($files.Count) files); Java checks, assembleDebug and lintDebug"
