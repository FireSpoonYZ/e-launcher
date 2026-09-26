param([switch]$StaticOnly, [switch]$JavaOnly)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location (Split-Path $PSScriptRoot -Parent)
if ($StaticOnly -and $JavaOnly) { throw 'Choose at most one of -StaticOnly and -JavaOnly' }
if (-not $JavaOnly) {
    # Match retired components, not the legitimate voice component names, app catalog or Shower desktop.
    $production = @(Get-ChildItem app/src/main/java, app/src/main/aidl, web/src -Recurse -File |
        Where-Object { $_.Extension -in '.java', '.aidl', '.ts', '.tsx' })
    $retired = '\b(HomeDesktop|HomeLayout|HomeInputOverlay|HomeTaskCards|DesktopBackup|DesktopBackupPreview|DesktopIconPack|DesktopMenu|DesktopPreferences|DesktopSettingsActivity|DesktopWidgets|LauncherSearchIndex|LauncherShortcuts|NativeSearchPage|SearchName|PagerRoot|PagerState|PagerGesture|AppSwitcherActivity|AppSwitcherView|AppSnapshots|AppLaunchHistory|GestureService|NavigationSession|SwipeDetector|FluidGestureGeometry|AgentTools|AccessibilityServices|AppWidgetHost|AppWidgetHostView)\b|\b(showDesktop|showHomeFromWeb|showAppLibrary|showGlobalSearch|beginDesktopDrag|sendSearchToAssistant|setOwnDefaultHome)\s*\(|\b(CATEGORY_HOME|ROLE_HOME|ACTION_CONFIRM_PIN_SHORTCUT|PinItemRequest)\b|android[.]intent[.]category[.]HOME|android[.]content[.]pm[.]action[.]CONFIRM_PIN_SHORTCUT'
    $references = @($production | Select-String -Pattern $retired)
    if ($references.Count -ne 0) { throw "Retired launcher implementation remains: $references" }
    [xml]$manifest = Get-Content app/src/main/AndroidManifest.xml -Raw -Encoding UTF8
    $ns = [Xml.XmlNamespaceManager]::new($manifest.NameTable)
    $ns.AddNamespace('android', 'http://schemas.android.com/apk/res/android')
    $forbidden = $manifest.SelectNodes('//category[@android:name="android.intent.category.HOME"] | //action[@android:name="android.content.pm.action.CONFIRM_PIN_SHORTCUT"] | //service[@android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE"] | //activity[contains(@android:name,"AppSwitcher") or contains(@android:name,"DesktopSettings")] | //uses-permission[@android:name="android.permission.KILL_BACKGROUND_PROCESSES"]', $ns)
    if ($forbidden.Count -ne 0) { throw 'Manifest still registers a retired HOME, shortcut host, accessibility service or desktop component' }
    $receiver = $manifest.SelectSingleNode('//receiver[@android:name=".TaskWidgetProvider" or @android:name="com.example.launcherprobe.TaskWidgetProvider"]', $ns)
    if ($null -eq $receiver -or $receiver.GetAttribute('exported', $ns.LookupNamespace('android')) -ne 'false' -or
            $null -eq $receiver.SelectSingleNode('intent-filter/action[@android:name="android.appwidget.action.APPWIDGET_UPDATE"]', $ns) -or
            $null -eq $receiver.SelectSingleNode('meta-data[@android:name="android.appwidget.provider" and @android:resource="@xml/task_widget_info"]', $ns)) {
        throw 'TaskWidgetProvider must be non-exported with APPWIDGET_UPDATE and task_widget_info metadata'
    }
    [xml]$widget = Get-Content app/src/main/res/xml/task_widget_info.xml -Raw -Encoding UTF8
    $info = $widget.DocumentElement
    $android = $ns.LookupNamespace('android')
    $resize = @($info.GetAttribute('resizeMode', $android).Split('|'))
    if ($info.Name -ne 'appwidget-provider' -or $info.GetAttribute('updatePeriodMillis', $android) -ne '0' -or
            $info.GetAttribute('widgetCategory', $android) -ne 'home_screen' -or
            $resize -notcontains 'horizontal' -or $resize -notcontains 'vertical' -or
            $info.GetAttribute('initialLayout', $android) -ne '@layout/task_widget') {
        throw 'Widget must use event updates, home_screen, two-axis resizing and task_widget layout'
    }
    [xml]$layout = Get-Content app/src/main/res/layout/task_widget.xml -Raw -Encoding UTF8
    if ($layout.SelectNodes('//*[contains(local-name(),"EditText") or contains(local-name(),"WebView") or contains(local-name(),"TextureView") or contains(local-name(),"SurfaceView")]').Count -ne 0) {
        throw 'RemoteViews cannot embed chat input or Shower preview; open an Activity instead'
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
    $files += Get-Item app/build.gradle, shower-server/build.gradle, build.gradle, settings.gradle, AGENTS.md, README.md, THIRD_PARTY_NOTICES.md
    foreach ($file in $files) {
        $text = [IO.File]::ReadAllText($file.FullName, [Text.Encoding]::UTF8)
        if ($text -match "`t|(?m)[ ]+`r?$" -or -not $text.EndsWith("`n")) {
            throw "Style check failed: $($file.FullName)"
        }
    }
    Write-Output "PASS: assistant/Widget registration, retired references and style ($($files.Count) files)"
    if ($StaticOnly) { return }
}
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
    app/src/main/java/com/example/launcherprobe/AgentHistory.java `
    app/src/main/java/com/example/launcherprobe/ConversationTree.java `
    app/src/main/java/com/example/launcherprobe/AppSearch.java `
    app/src/main/java/com/example/launcherprobe/ExactText.java `
    app/src/main/java/com/example/launcherprobe/ProviderConfig.java `
    app/src/main/java/com/example/launcherprobe/ReasoningEffort.java `
    app/src/main/java/com/example/launcherprobe/RunEpoch.java `
    app/src/main/java/com/example/launcherprobe/SearchConfig.java `
    app/src/main/java/com/example/launcherprobe/SearchParser.java `
    app/src/main/java/com/example/launcherprobe/WebAddressPolicy.java `
    tests/com/example/launcherprobe/AgentChecks.java `
    tests/com/example/launcherprobe/ConversationTreeChecks.java
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& "$env:JAVA_HOME\bin\java.exe" -ea -cp $classes com.example.launcherprobe.AgentChecks
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& "$env:JAVA_HOME\bin\java.exe" -ea -cp $classes com.example.launcherprobe.ConversationTreeChecks
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($JavaOnly) { Write-Output "PASS: AgentChecks and ConversationTreeChecks"; return }

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
Write-Output "PASS: assistant/Widget/style checks; Java checks, Pi runtime assets, Shower asset, assembleDebug and lintDebug"
