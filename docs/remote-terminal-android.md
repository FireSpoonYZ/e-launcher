# Android remote terminal bridge

`RemoteTerminalPlugin` implements wire v1 from the parent contract. It is registered
by `MainActivity`; no manifest, npm, or dependency changes are required. Existing
OkHttp 3.14.9 provides WSS. The Android minimum SDK is already 29.

## API and lifecycle

- `listHosts()` returns only `{hosts:[{id,name,address,port,fingerprint}]}`.
- `pair({descriptor,address?,deviceName?})` validates the descriptor and all address
  candidates, pins TLS before sending the one-time code, and returns `{host}`.
  Default address is the first candidate; the optional override must be a bare host
  (IPv4, IPv6, or DNS), not a URL. Default device name is Android.
- `removeHost({hostId})` cancels pairing/connection and removes local credentials.
  It does not revoke a server token; use the desktop device-revocation UI for that.
- `connect({hostId})` resolves `{hostId,clientId}` only after auth and protocol-version
  validation. Repeated connected calls return the same ID; concurrent callers join
  the same handshake and settle together. Host identity is the normalized certificate fingerprint; the
  client ID survives reconnects/re-pairing until the host is removed.
- `disconnect({hostId})` closes only transport, never the shell.
- `request({hostId,method,params})` returns `{result}`. Params must be an object.
  Only profiles.list and the contract terminal operations are accepted.
  Auth, pair, pairing.create, devices.*, and unknown methods cannot enter this path.
  Parameter keys, types, profile IDs, viewport bounds, and input length are checked
  natively; the host additionally validates filesystem paths and authorization.
  Subscribe/unsubscribe accept an optional nonempty subscriptionId (at most 128
  characters), letting the host ignore teardown from an older subscription.
- `terminalEvent` forwards terminal wire events with native-owned hostId and emits
  connection states connected/disconnected, with an optional sanitized code on
  disconnect. Listeners do not retain terminal output. Register before subscribing.
  UNAUTHORIZED requires pairing again; PIN_MISMATCH requires verifying the host
  identity before pairing again; CERTIFICATE_INVALID requires checking the host
  certificate/device clock, not blindly re-pairing. CONNECT_FAILED is recoverable
  transport/handshake interruption; PROTOCOL indicates an incompatible response.
  Neither credentials nor server auth error messages are forwarded.
- Activity stop/destroy cancels every socket, pairing, pending request, and timer
  synchronously on main, not via a queued close that could hit a replacement.
  Resume abandons unauthenticated attempts at least two seconds old; younger
  attempts remain joinable and authenticated sockets stay intact. Owner identity
  fences auth, event, and close callbacks from retired sockets.
  Foreground UI explicitly reconnects and subscribes for a snapshot. There is no
  background service, automatic retry, request replay, or terminal.close on teardown.

Dials time out after 20 seconds; auth, pairing, and ordinary requests after 30
seconds. IDs are monotonically unique within each connection. Late/duplicate replies
are ignored; disconnect and timeout settle each pending request once. DELIVERY_UNKNOWN
means the host may have already applied a write: do not blindly resend it.

Bounds: 128 pending RPCs per connection, 64 KiB terminal input strings, 8 MiB UTF-8
JSON messages/outbound socket queue, and 256 messages / 16 MiB awaiting dispatch on
the native main handler. Overflow cancels the socket; reconnect+subscribe restores
the host snapshot. OkHttp 3 buffers a complete inbound WebSocket message before
calling its listener, so the inbound limit is enforced immediately after framing,
not during frame allocation. Only pair with trusted hosts.

## TLS and secret storage

The contract fingerprint is SHA-256 of the complete leaf DER certificate.
OkHttp CertificatePinner hashes SPKI, so using that API with the descriptor would
pin the wrong value. A per-connection X509TrustManager checks the exact DER digest
with constant-time byte comparison and checks certificate validity. The hostname
verifier independently checks that same digest; there is no trust-all manager,
unconditional hostname acceptance, HTTP fallback, redirect, or system-CA fallback.
The out-of-band certificate is the identity, allowing LAN/Tailscale address changes
without requiring the self-signed certificate to name each address.

Issued tokens are AES-GCM encrypted with AndroidKeyStore's nonexportable AES key
`remote_terminal.tokens.v1`; each encryption has a fresh IV and binds the host ID
as authenticated data. Atomic records live only in
`Context.getNoBackupFilesDir()/remote_terminal_hosts_v1.json`, a distinct private,
backup-excluded namespace. No existing ui/chat preferences or signing files change.
Tokens are never returned by the plugin, placed in URLs, or logged. Keystore/storage
errors fail closed; remove/re-pair the host if credentials become unavailable.
The full record is never projected into a JS response.

## Orca reuse and adaptation

Read-only reference: `D:/project/.agent-work/e-terminal/orca-reference`,
commit `de8bffe24045b396212f4f63de8960ec8380ea07`.

Reconnect follows Orca's rpc-stale-dial/direct-rpc-client foreground-age rule and
host-client-open-registry identity fencing, implemented with the existing Java
Handler, host map, and OkHttp socket. No new logical-client framework is imported.

`RemoteTerminalRequests.java` ports the pending-map, timeout cancellation,
response settlement, and disconnect rejection code from:

- `mobile/src/transport/rpc-client-request-tracker.ts`
- `mobile/src/transport/relay-pending-requests.ts`

The Java/Handler adaptation preserves remove-before-callback behavior and explicit
unknown-delivery failures. It removes Orca's encrypted envelopes, token-per-message,
reconnect waits, and logging, because this contract uses pinned WSS and auth once
per socket. It adds a bounded pending map.

Also read `mobile/src/transport/direct-rpc-client.ts`,
`mobile/src/transport/pairing.ts`, and
`mobile/src/transport/pairing-keychain.ts`. Their RN/Expo, base64 pairing-offer,
relay/E2EE, and reconnect graph cannot be lifted into the Java Capacitor JSON/WSS
contract. Native AndroidKeyStore and OkHttp are the existing platform/dependency
equivalents, rather than importing that incompatible graph.

## Focused validation

Tests added under `app/src/test/java/com/example/launcherprobe/`:

- RemoteTerminalProtocolTest: descriptor/address/pin validation, RPC allowlist and
  params, subscription identity bounds/legacy compatibility, and secret-free host projection.
- RemoteTerminalTlsTest: exact DER pin accepts the self-signed test leaf; different
  pins, empty chains, and client trust fail; redirects disabled. Public certificate
  fixture only; no private key is committed.
- RemoteTerminalRequestsTest: correlated/duplicate/late responses, timeout,
  disconnect, bounded pending count, reentrant cleanup, and cancelled timers.
- RemoteTerminalPluginTest: eight concurrent callers share one auth; retired
  callbacks cannot poison replacements; synchronous stop and stale resume; dial/auth
  timeouts; auth rejection without replay; distinct pin/certificate/network errors;
  identical sanitized error codes on disconnect events and connect rejections,
  without publishing stale-owner events.

Parent normal build command, with existing assets/dependencies/signing provisioned:

```powershell
.\gradlew.bat :app:testDebugUnitTest --tests "com.example.launcherprobe.RemoteTerminal*Test" --no-daemon --console=plain
exit $LASTEXITCODE
```

In the reconnect Android lane, an isolated Java Gradle harness compiled all six
native classes and four test classes with JDK 21, SDK 36, the read-only original
Capacitor compiled jar, and cached AndroidX/Robolectric dependencies. Robolectric
SDK 35 ran **15 tests, all passed**. Harness and results are ignored under
`build/native-check/`. Initial harness runs lacked AndroidX runtime classes; after
supplying those cached dependencies, all tests passed. This is not a full Android
Gradle build or APK check. Tests use a fake OkHttp WebSocket and seed a host record;
they do not exercise real TLS transport, Keystore encryption, or WebView delivery.
No original files, device, browser, GUI, or live host were operated or modified.

Parent integration still needs a full app build and real-host/device checks for
pair/connect, Keystore persistence, certificate mismatch, revocation, background
disconnect/re-subscribe, and lifecycle/IME behavior. Existing prerequisites remain
JDK 21, SDK 36, NDK 28.2.13676358, CMake 3.22.1, Node >=22.19, installed Capacitor
dependencies, prepared runtime assets, and the existing shared debug keystore.
There are no new dependencies.

## Orca MIT notice

MIT License

Copyright (c) 2026 Lovecast Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
