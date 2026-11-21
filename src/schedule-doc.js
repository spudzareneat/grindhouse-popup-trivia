// The published weekend lineup (schedule/current.json), read by the userscript's Coming Attractions screen.
// `days` keeps the shape the userscript's own Reddit parser produced (string years included) and each item
// gains the resolved IMDb id and rating. See docs/superpowers/specs/2026-11-20-published-schedule-design.md.

import fs from 'node:fs';
import path from 'node:path';
import { resolveTitle } from './resolve.js';
import { loadOverrides, overrideKey } from './overrides.js';

export const SCHEDULE_FILE = 'schedule/current.json';

// resolveItem(item) -> tconst|null and rate(tconst) -> {rating, votes}|null are injected; a failure in either
// (or a title that cannot be resolved) gives nulls for that item and never aborts the build.
// previous (the file as last published) is only consulted for the SAME post: a failed or empty lookup keeps the id already
// published (an IMDb outage must not erase it; a dismiss already nulled it in the file, so nothing is resurrected), and a
// rating already published for an unchanged id is kept rather than refetched (so vote-count drift never causes a commit).
// fetchInfo(tconst) -> Info|null (optional; see src/lineup-info.js): when supplied every item gets an `info` key. Complete previous
// info (has cleanTitle) for the same post and id is kept; otherwise it is fetched, and a failed fetch keeps previous info only if
// that info belongs to the same id (never another film's), else null.
export async function buildScheduleDoc({ post, resolveItem, rate, now, previous = null, fetchInfo = null }) {
    const key = item => `${item.title}|${item.year ?? ''}`;
    const prevByKey = new Map();
    if (previous && previous.postId === post.postId) {
        for (const d of previous.days ?? []) for (const s of d.sections ?? []) for (const it of s.items ?? []) prevByKey.set(key(it), it);
    }
    const days = [];
    for (const day of post.days) {
        const sections = [];
        for (const section of day.sections) {
            const items = [];
            for (const item of section.items) {
                let imdbId = null, imdbRating = null, imdbVotes = null;
                const prev = prevByKey.get(key(item));
                try { imdbId = (await resolveItem(item)) ?? null; } catch { imdbId = null; }
                if (!imdbId && prev?.imdbId) imdbId = prev.imdbId;
                if (imdbId) {
                    if (prev && prev.imdbId === imdbId && prev.imdbRating != null) {
                        imdbRating = prev.imdbRating; imdbVotes = prev.imdbVotes ?? null;
                    } else {
                        try {
                            const r = await rate(imdbId);
                            if (r) { imdbRating = r.rating; imdbVotes = r.votes; }
                        } catch { /* rating stays null; the next schedule run retries */ }
                    }
                }
                let infoField = {};
                if (fetchInfo) {
                    let info = null;
                    if (imdbId) {
                        const prevInfo = prev && prev.imdbId === imdbId ? (prev.info ?? null) : null;
                        // Complete = has a title and no failed source (`partial`); partial info is retried on every run.
                        if (prevInfo?.cleanTitle && !prevInfo.partial) info = prevInfo;
                        else {
                            let got = null;
                            try { got = await fetchInfo(imdbId); } catch { got = null; }
                            info = got ?? prevInfo;
                        }
                    }
                    infoField = { info };
                }
                items.push({ ...item, imdbId, imdbRating, imdbVotes, ...infoField });
            }
            sections.push({ ...section, items });
        }
        days.push({ ...day, sections });
    }
    return {
        schema: 1, fetchedAt: now,
        postId: post.postId, title: post.title, publishedAt: post.publishedAt, weekend: post.weekend,
        days,
    };
}

// Same published content? fetchedAt alone never counts as a change (no commit for a timestamp).
export function sameSchedule(a, b) {
    if (!a || !b) return false;
    const strip = ({ fetchedAt, ...rest }) => JSON.stringify(rest);
    return strip(a) === strip(b);
}

export function readScheduleDoc(repoDir) {
    try { return JSON.parse(fs.readFileSync(path.join(repoDir, SCHEDULE_FILE), 'utf8')); } catch { return null; }
}

export function writeScheduleDoc(repoDir, doc) {
    const file = path.join(repoDir, SCHEDULE_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
    return file;
}

// A Discord pick (tconst) or dismiss (tconst null) for a schedule title: update every matching item's id and rating.
// Items match the way overrides do (normalised title + year; the file's string year is converted). Pure: returns a copy,
// and changed is false when no item matches or nothing would differ.
// info (optional): the picked film's published info object. null clears it (dismiss), except that a null for a pick of the
// SAME id keeps what is published (a failed refetch must not erase good info). undefined leaves info untouched, except that
// changing the id always clears an existing info (it belongs to the old film; never keep another film's poster).
export function applyPick(doc, { title, year, tconst, rating, info }) {
    const key = overrideKey(title, year ?? null);
    const next = structuredClone(doc);
    let changed = false;
    for (const day of next.days) for (const section of day.sections) for (const item of section.items) {
        if (overrideKey(item.title, item.year ? Number(item.year) : null) !== key) continue;
        const imdbId = tconst ?? null, imdbRating = rating?.rating ?? null, imdbVotes = rating?.votes ?? null;
        const idChanged = item.imdbId !== imdbId;
        if (idChanged || item.imdbRating !== imdbRating || item.imdbVotes !== imdbVotes) changed = true;
        Object.assign(item, { imdbId, imdbRating, imdbVotes });
        let nextInfo;
        if (info === undefined) nextInfo = idChanged && 'info' in item ? null : undefined;
        else if (info === null && tconst && !idChanged) nextInfo = item.info ?? null;
        else nextInfo = info;
        if (nextInfo !== undefined) {
            if (JSON.stringify(item.info ?? null) !== JSON.stringify(nextInfo)) changed = true;
            item.info = nextInfo;
        }
    }
    return { doc: next, changed };
}

// pull -> fetch -> build -> compare -> write -> commit. A fetchPost failure propagates before anything is written, so the
// previous file stays published. Returns 'unchanged' (nothing written or committed) or 'published'.
export async function publishSchedule({ repoDir, git, fetchPost, resolveItem, rate, now, fetchInfo = null, log = () => {} }) {
    git.pull();
    git.push();   // deliver a commit stranded by an earlier failed push (as runWeekend does), so a stale raw file is not left behind
    const post = await fetchPost();
    const previous = readScheduleDoc(repoDir);
    const doc = await buildScheduleDoc({ post, resolveItem, rate, now, previous, fetchInfo });
    if (sameSchedule(previous, doc)) { log('schedule: unchanged, nothing to publish'); return 'unchanged'; }
    const file = writeScheduleDoc(repoDir, doc);
    git.commitAndPush(file, `schedule: ${doc.title}`);
    log(`schedule: published ${doc.title}`);
    return 'published';
}

// resolveItem for buildScheduleDoc: the same resolver (and overrides file) the generator uses. The published item
// keeps the parser's string year; the resolver and the override keys want a number, so convert here.
// Overrides are re-read per call so a Discord pick committed after the pull is honoured.
export function makeResolveItem({ imdb, tmdb, overridesFile, log }) {
    return async item => {
        const year = item.year ? Number(item.year) : null;
        const overrides = loadOverrides(overridesFile);
        // resolveTitle only honours picks; a dismissed title must stay unresolved here too, or the next run would re-resolve it.
        if (overrides.dismissed[overrideKey(item.title, year)]) return null;
        const r = await resolveTitle({ title: item.title, year, akas: item.akas }, { imdb, tmdb, overrides, log });
        return r.tconst ?? null;
    };
}

// What `run` does with the schedule it has just scraped: publish it, but never let a publish problem stop the run.
// publish(fetchPost) is typically publishSchedule bound to repo/git/resolver. Returns 'skipped' | 'failed' | publish's result.
export async function publishBestEffort({ skip, post, publish, log }) {
    if (skip || !post) return 'skipped';
    try { return await publish(async () => post); } catch (e) {
        log(`schedule publish failed (run continues): ${e.message}`);
        return 'failed';
    }
}
