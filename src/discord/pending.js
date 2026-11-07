import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// File-backed store shared by the cron run process and the bot process:
// every operation re-reads from disk and writes atomically (temp + rename).
export function makePendingStore(
    file,
    { newId = () => crypto.randomUUID().slice(0, 8), now = () => new Date() } = {},
) {
    function read() {
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            return Array.isArray(data) ? data : [];
        } catch {
            return [];
        }
    }

    function write(entries) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
        try {
            fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
            fs.renameSync(tmp, file);
        } catch (err) {
            try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
            throw err;
        }
    }

    return {
        add(entry) {
            const id = newId();
            const entries = read();
            entries.push({ ...entry, id, status: 'open', createdAt: now().toISOString() });
            write(entries);
            return id;
        },
        get(id) {
            return read().find((e) => e.id === id) ?? null;
        },
        update(id, patch) {
            const entries = read();
            const i = entries.findIndex((e) => e.id === id);
            if (i < 0) return null;
            entries[i] = { ...entries[i], ...patch, id };
            write(entries);
            return entries[i];
        },
        list() {
            return read();
        },
    };
}
