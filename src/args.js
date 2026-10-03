// CLI argument parsing (kept out of cli.js so it can be unit-tested without running main()).
export const USAGE = 'usage: cli.js run [--dry-run] [--force] | cli.js movie <tt…|"Title"> [--year N] [--dry-run] [--force]';

export function parseArgs(argv) {
    const args = { _: [], dryRun: false, force: false, year: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') args.dryRun = true;
        else if (a === '--force') args.force = true;
        else if (a === '--year') {
            const v = argv[++i];
            if (!/^\d{4}$/.test(v ?? '')) return { ...args, error: `--year must be followed by a 4-digit year (got ${v === undefined ? 'nothing' : v})` };
            args.year = Number(v);
        } else if (a.startsWith('--')) return { ...args, error: `unknown option: ${a}` };
        else args._.push(a);
    }
    return args;
}
