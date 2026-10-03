# grindhouse-popup-trivia

Weekly generator of VH1 "Pop-up Video"-style trivia for the r/420Grindhouse CyTube channel.

A Docker job reads the weekend schedule from r/420Grindhouse, researches each movie (IMDb, Wikidata,
Wikipedia, Joe Bob Briggs' Drive-In Totals, and web research via the Claude Code CLI), and publishes
short, cited, timed facts as `data/<imdbId>.json`. The Spuds Grindhouse Experience userscript
(`trivia-popup` module, [cytube_tv_interface_script](https://github.com/spudzareneat/cytube_tv_interface_script))
plays them in sync for everyone in the channel; movies without a file fall back to IMDb trivia.

Design: see `docs/curated-popup-trivia-design.md` (copied from the userscript repo).
