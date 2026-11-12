// CLI argument parsing (kept out of cli.js so it can be unit-tested without running main()).
export const USAGE = 'usage: cli.js run [--dry-run] [--force] [--schedule feed.xml] | cli.js movie <tt…|"Title"> [--year N] [--replaces tt…] [--dry-run] [--force] | cli.js backfill-totals [--dry-run] [--force]';

export function parseArgs(argv) {
    const args = { _: [], dryRun: false, force: false, year: null, replaces: null, schedule: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') args.dryRun = true;
        else if (a === '--force') args.force = true;
        else if (a === '--year') {
            const v = argv[++i];
            if (!/^\d{4}$/.test(v ?? '')) return { ...args, error: `--year must be followed by a 4-digit year (got ${v === undefined ? 'nothing' : v})` };
            args.year = Number(v);
        } else if (a === '--schedule') {
            const v = argv[++i];
            if (!v || v.startsWith('--')) return { ...args, error: '--schedule must be followed by a saved feed file path' };
            args.schedule = v;
        } else if (a === '--replaces') {
            const v = argv[++i];
            if (!/^tt\d+$/.test(v ?? '')) return { ...args, error: `--replaces must be followed by an IMDb id like tt0123456 (got ${v === undefined ? 'nothing' : v})` };
            args.replaces = v;
        } else if (a.startsWith('--')) return { ...args, error: `unknown option: ${a}` };
        else args._.push(a);
    }
    return args;
}
