// The published weekend lineup (schedule/current.json), read by the userscript's Coming Attractions screen.
// `days` keeps the shape the userscript's own Reddit parser produced (string years included) and each item
// gains the resolved IMDb id and rating. See docs/superpowers/specs/2026-11-20-published-schedule-design.md.

import fs from 'node:fs';
import path from 'node:path';
import { resolveTitle } from './resolve.js';
import { loadOverrides } from './overrides.js';

export const SCHEDULE_FILE = 'schedule/current.json';

// resolveItem(item) -> tconst|null and rate(tconst) -> {rating, votes}|null are injected; a failure in either
// (or a title that cannot be resolved) gives nulls for that item and never aborts the build.
export async function buildScheduleDoc({ post, resolveItem, rate, now }) {
    const days = [];
    for (const day of post.days) {
        const sections = [];
        for (const section of day.sections) {
            const items = [];
            for (const item of section.items) {
                let imdbId = null, imdbRating = null, imdbVotes = null;
                try { imdbId = (await resolveItem(item)) ?? null; } catch { imdbId = null; }
                if (imdbId) {
                    try {
                        const r = await rate(imdbId);
                        if (r) { imdbRating = r.rating; imdbVotes = r.votes; }
                    } catch { /* rating stays null; the next schedule run retries */ }
                }
                items.push({ ...item, imdbId, imdbRating, imdbVotes });
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

// pull -> fetch -> build -> compare -> write -> commit. A fetchPost failure propagates before anything is written, so the
// previous file stays published. Returns 'unchanged' (nothing written or committed) or 'published'.
export async function publishSchedule({ repoDir, git, fetchPost, resolveItem, rate, now, log = () => {} }) {
    git.pull();
    const post = await fetchPost();
    const doc = await buildScheduleDoc({ post, resolveItem, rate, now });
    if (sameSchedule(readScheduleDoc(repoDir), doc)) { log('schedule: unchanged, nothing to publish'); return 'unchanged'; }
    const file = path.join(repoDir, SCHEDULE_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
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
        const r = await resolveTitle({ title: item.title, year, akas: item.akas }, { imdb, tmdb, overrides: loadOverrides(overridesFile), log });
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
