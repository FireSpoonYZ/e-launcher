package com.example.launcherprobe;

import android.content.Context;

import org.xml.sax.Attributes;
import org.xml.sax.InputSource;
import org.xml.sax.SAXException;
import org.xml.sax.XMLReader;
import org.xml.sax.ext.LexicalHandler;
import org.xml.sax.helpers.DefaultHandler;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

import javax.xml.parsers.SAXParserFactory;

/**
 * Strict read-only access to the on-disk committed chat prefs XML
 * (shared_prefs/chat.xml or chat.xml.bak) using the public SAX API.
 * Never triggers the platform SharedPreferences loader/backup repair, never
 * writes, renames, deletes or creates anything. One open file descriptor is
 * reused for bounded batch scans; DTD/external entities are rejected via
 * LexicalHandler/EntityResolver.
 */
final class BotHostLegacyPreferences implements AutoCloseable {

    private static final long MAX_SCAN_BYTES = 256L * 1024 * 1024;
    private static final long MAX_VALUE_BYTES = 32L * 1024 * 1024;
    private static final long MAX_EXTRACTED_BYTES = 256L * 1024 * 1024;

    private static final int MISSING = 0;
    private static final int REGULAR = 1;
    private static final int NOT_REGULAR = 2;
    private static final int IO_ERROR = 3;

    private final FileChannel channel;
    private long extractedBytes;

    private BotHostLegacyPreferences(FileChannel channel) {
        this.channel = channel;
    }

    static BotHostLegacyPreferences open(Context context) throws IOException {
        File dir = new File(context.getApplicationInfo().dataDir, "shared_prefs");
        File prefs = new File(dir, "chat.xml");
        File backup = new File(dir, "chat.xml.bak");
        if (Files.isSymbolicLink(dir.toPath())
                || Files.isSymbolicLink(prefs.toPath()) || Files.isSymbolicLink(backup.toPath())) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "偏好数据路径无效");
        }
        boolean dirPresent;
        try {
            BasicFileAttributes dirAttrs = Files.readAttributes(dir.toPath(), BasicFileAttributes.class,
                    LinkOption.NOFOLLOW_LINKS);
            if (!dirAttrs.isDirectory()) {
                throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "偏好数据路径无效");
            }
            dirPresent = true;
        } catch (NoSuchFileException e) {
            dirPresent = false; // missing parent directory counts as empty.
        } catch (BotHostProcess.BridgeException e) {
            throw e;
        } catch (IOException e) {
            throw new BotHostProcess.BridgeException("IO_ERROR", "not-sent", "读取偏好数据失败");
        }
        if (!dirPresent) return new BotHostLegacyPreferences(null);
        File selected = pickRegular(prefs, backup);
        if (selected == null) return new BotHostLegacyPreferences(null);
        try {
            return new BotHostLegacyPreferences(new FileInputStream(selected).getChannel());
        } catch (IOException e) {
            throw new BotHostProcess.BridgeException("IO_ERROR", "not-sent", "读取偏好数据失败");
        }
    }

    /** Backup state is authoritative: IO/type errors never fall back to the main file. */
    private static File pickRegular(File prefs, File backup) throws IOException {
        int backupState = state(backup);
        if (backupState == IO_ERROR) {
            throw new BotHostProcess.BridgeException("IO_ERROR", "not-sent", "读取偏好数据失败");
        }
        if (backupState == NOT_REGULAR) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "偏好数据失效");
        }
        if (backupState == REGULAR) return backup;
        int prefState = state(prefs);
        if (prefState == IO_ERROR) {
            throw new BotHostProcess.BridgeException("IO_ERROR", "not-sent", "读取偏好数据失败");
        }
        if (prefState == NOT_REGULAR) {
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "偏好数据失效");
        }
        if (prefState == REGULAR) return prefs;
        return null; // both missing.
    }

    private static int state(File file) {
        try {
            BasicFileAttributes attrs = Files.readAttributes(file.toPath(), BasicFileAttributes.class,
                    LinkOption.NOFOLLOW_LINKS);
            if (attrs.isRegularFile()) return REGULAR;
            if (attrs.isDirectory()) return NOT_REGULAR;
            return NOT_REGULAR;
        } catch (NoSuchFileException e) {
            return MISSING;
        } catch (IOException e) {
            return IO_ERROR;
        }
    }

    /** One bounded SAX scan over the same open FD; extracts only whitelisted keys. */
    Map<String, Object> readAll(Collection<String> keys) throws IOException {
        if (channel == null || keys.isEmpty()) return new LinkedHashMap<>();
        LinkedHashSet<String> wanted = new LinkedHashSet<>(keys);
        channel.position(0);
        ReadingStream counting = new ReadingStream();
        CharsetDecoder decoder = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT);
        Handler handler = new Handler(wanted);
        try {
            XMLReader reader = newSaxReader(handler);
            reader.parse(new InputSource(new InputStreamReader(counting, decoder)));
            handler.finish();
            return handler.result;
        } catch (SAXException e) {
            Throwable cause = e.getException();
            if (cause instanceof BotHostProcess.BridgeException) throw (BotHostProcess.BridgeException) cause;
            throw new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "偏好数据无效");
        } catch (BotHostProcess.BridgeException e) {
            throw e;
        } catch (IOException e) {
            throw new BotHostProcess.BridgeException("IO_ERROR", "not-sent", "读取偏好数据失败");
        } finally {
            // Never close reader/counting here: it would close the shared channel.
            channel.position(0);
        }
    }

    @Override
    public void close() throws IOException {
        if (channel != null) channel.close();
    }

    private static XMLReader newSaxReader(Handler handler) throws IOException {
        try {
            SAXParserFactory factory = SAXParserFactory.newInstance();
            factory.setNamespaceAware(false);
            factory.setValidating(false);
            XMLReader reader = factory.newSAXParser().getXMLReader();
            reader.setContentHandler(handler);
            reader.setErrorHandler(handler);
            reader.setEntityResolver(handler);
            reader.setProperty("http://xml.org/sax/properties/lexical-handler", handler);
            return reader;
        } catch (Exception e) {
            throw new BotHostProcess.BridgeException("IO_ERROR", "not-sent", "读取偏好数据失败");
        }
    }

    private static int utf8Len(int codePoint) {
        if (codePoint <= 0x7F) return 1;
        if (codePoint <= 0x7FF) return 2;
        if (codePoint <= 0xFFFF) return 3;
        return 4;
    }

    /** SAX handler collecting only whitelisted values in a streaming budgeted way. */
    private final class Handler extends DefaultHandler implements LexicalHandler {
        private final Set<String> wanted;
        final Map<String, Object> result = new LinkedHashMap<>();

        private boolean sawRoot;
        private int depth;
        private boolean skipping;
        private int skipDepth;
        private String expecting;
        private String expectingTag;
        private String booleanValue;
        private final StringBuilder value = new StringBuilder();
        private long valueBytes;
        private int pendingHigh;
        private final LinkedHashSet<String> set = new LinkedHashSet<>();

        Handler(Set<String> wanted) {
            this.wanted = wanted;
        }

        void finish() throws SAXException {
            if (!sawRoot || depth != 0 || skipping) throwBridge(invalid());
        }

        private static String expectedType(String key) {
            if (key.startsWith("pi_nodes_")) return "set";
            if (key.startsWith("pi_pending_")) return "boolean";
            return "string";
        }

        private void resetTop() {
            value.setLength(0);
            valueBytes = 0;
            pendingHigh = -1;
        }

        private void resetMember() {
            value.setLength(0);
            pendingHigh = -1;
        }

        @Override
        public void startElement(String uri, String localName, String qName, Attributes attributes)
                throws SAXException {
            depth++;
            if (skipping) {
                skipDepth++;
                return;
            }
            if (depth == 1) {
                if (sawRoot || !"map".equals(qName)) throwBridge(invalid());
                sawRoot = true;
                return;
            }
            if (depth == 2) {
                String name = attributes.getValue("name");
                if (name == null || !wanted.contains(name)) {
                    skipping = true;
                    skipDepth = 1;
                    return;
                }
                String expected = expectedType(name);
                boolean allowed = expected.equals(qName) || "null".equals(qName);
                if (!allowed) throwBridge(invalid());
                expecting = name;
                expectingTag = qName;
                resetTop();
                if ("boolean".equals(qName)) booleanValue = attributes.getValue("value");
                return;
            }
            if (depth == 3 && "set".equals(expectingTag)) {
                if (!"string".equals(qName)) throwBridge(invalid());
                resetMember();
                return;
            }
            throwBridge(invalid());
        }

        @Override
        public void characters(char[] ch, int start, int length) throws SAXException {
            if (skipping) return;
            if (expecting != null) {
                if ("string".equals(expectingTag)
                        || ("set".equals(expectingTag) && depth >= 3)) {
                    appendValue(ch, start, length);
                    return;
                }
            }
            // map/set containers plus null/boolean entries allow whitespace only.
            for (int i = start; i < start + length; i++) {
                char c = ch[i];
                if (c != ' ' && c != '\t' && c != '\n' && c != '\r') throwBridge(invalid());
            }
        }

        private void appendValue(char[] ch, int start, int length) throws SAXException {
            int i = start;
            int end = start + length;
            while (i < end) {
                int codePoint;
                if (pendingHigh >= 0) {
                    if (Character.isLowSurrogate(ch[i])) {
                        codePoint = Character.toCodePoint((char) pendingHigh, ch[i]);
                        pendingHigh = -1;
                        i++;
                    } else {
                        throw new SAXException(invalid());
                    }
                } else if (Character.isHighSurrogate(ch[i])) {
                    if (i + 1 < end && Character.isLowSurrogate(ch[i + 1])) {
                        codePoint = Character.toCodePoint(ch[i], ch[i + 1]);
                        i += 2;
                    } else {
                        pendingHigh = ch[i];
                        i++;
                        continue;
                    }
                } else {
                    codePoint = ch[i];
                    i++;
                }
                int added = utf8Len(codePoint);
                if (valueBytes + added > MAX_VALUE_BYTES) throwBridge(tooLarge());
                extractedBytes += added;
                if (extractedBytes > MAX_EXTRACTED_BYTES) throwBridge(tooLarge());
                value.appendCodePoint(codePoint);
                valueBytes += added;
            }
        }

        @Override
        public void endElement(String uri, String localName, String qName) throws SAXException {
            if (skipping) {
                skipDepth--;
                if (skipDepth == 0) skipping = false;
                depth--;
                return;
            }
            if (depth == 1) {
                depth--;
                return;
            }
            if (depth == 2) {
                if (expecting != null) {
                    if (pendingHigh >= 0) throwBridge(invalid());
                    if ("string".equals(expectingTag)) {
                        result.put(expecting, value.toString());
                    } else if ("null".equals(expectingTag)) {
                        result.put(expecting, null);
                    } else if ("set".equals(expectingTag)) {
                        result.put(expecting, new LinkedHashSet<>(set));
                    } else {
                        if (!"true".equals(booleanValue) && !"false".equals(booleanValue)) {
                            throwBridge(invalid());
                        }
                        result.put(expecting, "true".equals(booleanValue));
                    }
                    expecting = null;
                    expectingTag = null;
                    value.setLength(0);
                    valueBytes = 0;
                    set.clear();
                }
                depth--;
                return;
            }
            if (depth == 3 && "set".equals(expectingTag)) {
                if (pendingHigh >= 0) throwBridge(invalid());
                set.add(value.toString());
                value.setLength(0);
                pendingHigh = -1;
                depth--;
                return;
            }
            depth--;
        }

        @Override
        public void startDTD(String name, String publicId, String systemId) throws SAXException {
            throwBridge(invalid());
        }

        @Override
        public void endDTD() throws SAXException { }

        @Override
        public void startEntity(String name) throws SAXException { }

        @Override
        public void endEntity(String name) throws SAXException { }

        @Override
        public void startCDATA() throws SAXException { }

        @Override
        public void endCDATA() throws SAXException { }

        @Override
        public void comment(char[] ch, int start, int length) throws SAXException { }

        @Override
        public InputSource resolveEntity(String publicId, String systemId) throws SAXException {
            throwBridge(invalid());
            return null;
        }
    }

    private static void throwBridge(BotHostProcess.BridgeException e) throws SAXException {
        throw new SAXException(e);
    }

    private static BotHostProcess.BridgeException invalid() {
        return new BotHostProcess.BridgeException("INVALID_ARGUMENT", "not-sent", "偏好数据无效");
    }

    private static BotHostProcess.BridgeException tooLarge() {
        return new BotHostProcess.BridgeException("TOO_LARGE", "not-sent", "偏好数据超限");
    }

    private final class ReadingStream extends InputStream {
        private long byteCount;

        @Override
        public int read() throws IOException {
            byte[] one = new byte[1];
            int n = read(one, 0, 1);
            return n == -1 ? -1 : one[0] & 0xFF;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (len == 0) return 0;
            int n = channel.read(ByteBuffer.wrap(b, off, len));
            if (n > 0) {
                byteCount += n;
                if (byteCount > MAX_SCAN_BYTES) throw tooLarge();
            }
            return n;
        }
    }
}
