$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location (Split-Path $PSScriptRoot -Parent)
if (-not $env:JAVA_HOME) { throw 'JAVA_HOME must point to JDK 21' }
$releaseFile = Join-Path $env:JAVA_HOME 'release'
$javaVersion = if (Test-Path $releaseFile) {
    (Get-Content $releaseFile | Where-Object { $_ -match '^JAVA_VERSION=' } | Select-Object -First 1)
} else { '' }
if ($javaVersion -notmatch '^JAVA_VERSION="21(?:[.]|\")') { throw "JDK 21 is required; found $javaVersion" }
$env:ANDROID_HOME = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "$env:LOCALAPPDATA\Android\Sdk" }
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
$gradle = Join-Path (Get-Location) 'gradlew.bat'
$androidJar = Join-Path $env:ANDROID_HOME 'platforms\android-36\android.jar'
if (-not (Test-Path $androidJar)) { throw "Android 36 platform is required; missing $androidJar" }

# Production logic checks use only the Android JSON API required by chat message metadata.
$classes = 'build\test-classes'
New-Item -ItemType Directory -Force $classes | Out-Null
& "$env:JAVA_HOME\bin\javac.exe" '-J-Duser.language=en' -encoding UTF-8 -cp $androidJar -d $classes `
    app/src/main/java/com/example/launcherprobe/ChatAttachment.java `
    app/src/main/java/com/example/launcherprobe/AgentLoop.java `
    app/src/main/java/com/example/launcherprobe/ActionFence.java `
    app/src/main/java/com/example/launcherprobe/AccessibilityServices.java `
    app/src/main/java/com/example/launcherprobe/AgentHistory.java `
    app/src/main/java/com/example/launcherprobe/ConversationTree.java `
    app/src/main/java/com/example/launcherprobe/AttemptAll.java `
    app/src/main/java/com/example/launcherprobe/AppSearch.java `
    app/src/main/java/com/example/launcherprobe/ExactText.java `
    app/src/main/java/com/example/launcherprobe/FluidGestureGeometry.java `
    app/src/main/java/com/example/launcherprobe/ObservationRegistry.java `
    app/src/main/java/com/example/launcherprobe/ProviderConfig.java `
    app/src/main/java/com/example/launcherprobe/ReasoningEffort.java `
    app/src/main/java/com/example/launcherprobe/RunEpoch.java `
    app/src/main/java/com/example/launcherprobe/SwipeDetector.java `
    app/src/main/java/com/example/launcherprobe/PagerState.java `
    app/src/main/java/com/example/launcherprobe/NavigationSession.java `
    app/src/main/java/com/example/launcherprobe/SearchConfig.java `
    app/src/main/java/com/example/launcherprobe/SearchParser.java `
    app/src/main/java/com/example/launcherprobe/ScreenNodePolicy.java `
    app/src/main/java/com/example/launcherprobe/WebAddressPolicy.java `
    tests/com/example/launcherprobe/AgentChecks.java `
    tests/com/example/launcherprobe/ConversationTreeChecks.java `
    tests/com/example/launcherprobe/GestureChecks.java `
    tests/com/example/launcherprobe/ShizukuRepairChecks.java
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& "$env:JAVA_HOME\bin\java.exe" -ea -cp $classes com.example.launcherprobe.GestureChecks
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& "$env:JAVA_HOME\bin\java.exe" -ea -cp $classes com.example.launcherprobe.ShizukuRepairChecks
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& "$env:JAVA_HOME\bin\java.exe" -ea -cp $classes com.example.launcherprobe.AgentChecks
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& "$env:JAVA_HOME\bin\java.exe" -ea -cp $classes com.example.launcherprobe.ConversationTreeChecks
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& $gradle --no-daemon --console=plain :app:testDebugUnitTest :app:assembleDebug :app:lintDebug :shower-server:lintDebug
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$showerAsset = 'app\build\generated\showerAssets\shower-server.jar'
if (-not (Test-Path $showerAsset)) { throw "Missing generated Operit Shower server asset: $showerAsset" }
$showerEntries = & "$env:JAVA_HOME\bin\jar.exe" tf $showerAsset
if ($LASTEXITCODE -ne 0 -or $showerEntries -notcontains 'classes.dex' -or $showerEntries -contains 'classes2.dex') {
    throw 'Generated Operit Shower server asset must contain exactly one dex payload'
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$apk = [IO.Compression.ZipFile]::OpenRead((Resolve-Path 'app/build/outputs/apk/debug/app-debug.apk'))
try {
    $npmVersion = (Get-Content 'pi-runtime/package.json' -Raw | ConvertFrom-Json).dependencies.npm
    foreach ($asset in 'assets/pi-runtime.cjs', 'assets/pi-sdk/package.json',
            "assets/npm/$npmVersion/bin/npm-cli.js", "assets/npm/$npmVersion/payload-complete.txt") {
        $entry = $apk.GetEntry($asset)
        if ($null -eq $entry -or $entry.Length -eq 0) { throw "APK is missing required pi runtime asset: $asset" }
    }
} finally { $apk.Dispose() }
$zip = [IO.Compression.ZipFile]::OpenRead((Resolve-Path $showerAsset))
try {
    $dexStream = $zip.GetEntry('classes.dex').Open()
    $memory = [IO.MemoryStream]::new()
    try { $dexStream.CopyTo($memory); $dexText = [Text.Encoding]::ASCII.GetString($memory.ToArray()) }
    finally { $dexStream.Dispose(); $memory.Dispose() }
} finally { $zip.Dispose() }
foreach ($className in 'Main', 'IShowerService', 'IShowerClient', 'ShowerBinderContainer') {
    if (-not $dexText.Contains("Lcom/ai/assistance/shower/$className;")) {
        throw "Generated Operit Shower server asset is missing $className"
    }
}
$legacyFiles = @(Get-ChildItem app/src/main/java, app/src/main/aidl, pi-runtime, scripts -Recurse -File |
    Where-Object { $_.FullName -notmatch '[\\/]node_modules[\\/]' -and $_.FullName -ne $PSCommandPath })
$legacyFiles += Get-Item app/build.gradle, pi-runtime/package.json
$legacyReferences = @($legacyFiles |
    Select-String -Pattern 'Lamda|lamda|bundledAndroidMcp|android-mcp|127[.]0[.]0[.]1:65000')
if ($legacyReferences.Count -ne 0) { throw "Legacy Lamda integration references remain: $legacyReferences" }

# Existing style: spaces (not tabs), no trailing whitespace, final newline.
$generatedXml = @(
    (Join-Path (Get-Location) 'app/src/main/res/xml/config.xml'),
    (Join-Path (Get-Location) 'capacitor-cordova-android-plugins/src/main/AndroidManifest.xml')
)
$files = @(Get-ChildItem app/src, shower-server/src, tests, scripts -Recurse -File |
    Where-Object { ($_.Extension -in '.java', '.aidl', '.xml', '.ps1') -and ($_.FullName -notin $generatedXml) })
$files += Get-Item app/build.gradle, shower-server/build.gradle, build.gradle, settings.gradle, README.md, THIRD_PARTY_NOTICES.md
foreach ($file in $files) {
    $text = [IO.File]::ReadAllText($file.FullName, [Text.Encoding]::UTF8)
    if ($text -match "`t|(?m)[ ]+`r?$" -or -not $text.EndsWith("`n")) {
        throw "Style check failed: $($file.FullName)"
    }
}
Write-Output "PASS: style/legacy checks ($($files.Count) files); Java checks, Pi runtime assets, Shower asset, assembleDebug and lintDebug"
