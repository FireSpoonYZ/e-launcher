package com.example.launcherprobe;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.BiPredicate;
import java.util.function.Consumer;

/** Bounded identities from one screen observation. */
public final class ObservationRegistry<T> {
    private static final class Entry<T> {
        final T identity;
        final boolean protectedText;
        Entry(T identity, boolean protectedText) {
            this.identity = identity;
            this.protectedText = protectedText;
        }
    }

    private final int limit;
    private final Map<String, Entry<T>> entries = new LinkedHashMap<>();

    public ObservationRegistry(int limit) { this.limit = limit; }

    public boolean add(String id, T identity, boolean protectedText) {
        if (entries.size() >= limit) return false;
        entries.put(id, new Entry<>(identity, protectedText));
        return true;
    }

    public void require(String id, T current, boolean textAction, BiPredicate<T, T> same) {
        Entry<T> observed = entries.get(id);
        if (observed == null) throw new IllegalArgumentException("节点未包含在屏幕观察中");
        if (!same.test(observed.identity, current)) throw new IllegalStateException("节点身份已变化，请重新读取屏幕");
        if (textAction && observed.protectedText) throw new IllegalArgumentException("拒绝向密码字段自动输入");
    }

    public void clear(Consumer<T> disposer) {
        for (Entry<T> entry : entries.values()) disposer.accept(entry.identity);
        entries.clear();
    }

    public int size() { return entries.size(); }
}
