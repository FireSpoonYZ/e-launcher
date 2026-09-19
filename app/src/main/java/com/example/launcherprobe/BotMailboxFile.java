package com.example.launcherprobe;

import java.io.BufferedInputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;

/** Versioned, bounded binary encoding, not Java object deserialization. Same implementation on host and Android. */
public final class BotMailboxFile implements BotMailbox.Storage {
    private static final int MAGIC = 0x45424f54, VERSION = 1;
    private final File file;
    public BotMailboxFile(File file) { this.file = file; }
    @Override public List<BotMailbox.Delivery> read() throws IOException {
        if (!file.exists()) return List.of();
        if (file.length() > 16 * 1024 * 1024) throw new IOException("Bot 投递文件超过上限");
        try (DataInputStream in = new DataInputStream(new BufferedInputStream(Files.newInputStream(file.toPath())))) {
            if (in.readInt() != MAGIC || in.readInt() != VERSION) throw new IOException("Bot 投递版本不受支持");
            int count = in.readInt();
            if (count < 0 || count > BotMailbox.MAX_RECORDS) throw new IOException("Bot 投递记录数量无效");
            List<BotMailbox.Delivery> result = new ArrayList<>();
            for (int i = 0; i < count; i++) result.add(new BotMailbox.Delivery(
                    in.readUTF(), in.readUTF(), in.readUTF(), in.readUTF(), in.readUTF(), in.readUTF(),
                    in.readUTF(), in.readUTF(), in.readInt(), in.readBoolean(), in.readLong(),
                    in.readUTF(), in.readUTF(), in.readUTF()));
            if (in.read() != -1) throw new IOException("Bot 投递文件含多余数据");
            return result;
        }
    }
    @Override public void write(List<BotMailbox.Delivery> values) throws IOException {
        File parent = file.getAbsoluteFile().getParentFile();
        if (!parent.isDirectory() && !parent.mkdirs()) throw new IOException("无法创建 Bot 投递目录");
        File temporary = new File(parent, file.getName() + ".new");
        try {
            try (FileOutputStream raw = new FileOutputStream(temporary);
                 DataOutputStream out = new DataOutputStream(raw)) {
                out.writeInt(MAGIC); out.writeInt(VERSION); out.writeInt(values.size());
                for (BotMailbox.Delivery d : values) {
                    out.writeUTF(d.id()); out.writeUTF(d.key()); out.writeUTF(d.from()); out.writeUTF(d.to());
                    out.writeUTF(d.body()); out.writeUTF(d.kind()); out.writeUTF(d.replyTo()); out.writeUTF(d.root());
                    out.writeInt(d.depth()); out.writeBoolean(d.expectsReply()); out.writeLong(d.createdAt());
                    out.writeUTF(d.status()); out.writeUTF(d.requestId()); out.writeUTF(d.error());
                }
                out.flush(); raw.getFD().sync();
            }
            // Same directory/filesystem. Failure leaves the previous committed ledger intact.
            Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING);
        } finally { Files.deleteIfExists(temporary.toPath()); }
    }
}
