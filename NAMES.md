# Name candidates (npm + GitHub checked 2026-08-13)

**Chosen: `clickgraph`** — it names the mechanism and the data model in one
word, and the graph is the part no shipping product has. Kept here because the
sweep is worth not repeating, and because a rename stays cheap until this is
published to npm and picks up stars.

`404` on the npm registry = free. GitHub checked for repos with any real
traction. Theme that fits the pairing: **App Atlas draws the map; this walks
the territory and reports what actually happens.**

## Clean on both (npm free, no notable GitHub repo)

**Walk + proof**
proofwalk · walkproof · clickproof · pathproof · trailproof · wayproof ·
crawlproof · uiproof · proveout · proofpath · truewalk · walkline · veritour

**Graph / structure**
clickgraph · crawlgraph · walkgraph · graphwalk · nodewalk · edgewalk ·
statewalk · screenwalk · viewwalk · tapmap

**Probe / inspect**
uiprobe · clickprobe · screenprobe · probewalk · fieldcheck · uitrace · traceline

**Motion / traversal**
clickwalk · treadpath · trailwalk · gridwalk · sweepwalk · combwalk ·
smokewalk · walkforward · firstwalk · saunterer · pathpacer · beatwalk

**Survey / cartography**
trigpoint · waypost · footpath · groundtruth · surefoot · sitewalker · uiwalker

**Verification / trial**
provingground · shakeout · stresswalk · everypath · bearout

**Bot-ish**
walkbot · clickbot · atlaswalk

## Avoid — npm free but a real GitHub project already owns the name
uigraph (SwiftUIGraphs, 61★) · milepost (49★) · flowwalk (33★) · ambler (29★) ·
theodolite (two projects, 59★/72★)

## Taken on npm
surveyor, wayfinder, walkabout, territory, tracer, trailhead, waymark, recce,
pathwalker, appwalker, footfall, gumshoe, wayfarer, terrain, walktree, ramble,
saunter, patrol, sextant, plumbline, footing, groundwork, shakedown, cairn,
blaze, attest, traipse, prowl, dryrun, ricochet, kestrel, gauntlet, firstpass,
allpaths, seatrial, strider, trekker, rover, scout, recon, ranger, sentry,
pathfinder, vanguard, beagle, bloodhound, ferret, magpie, verity, vouch,
certify, warrant, prover, canary, tripwire, statemap, lodestar, meridian,
signpost, legwork

## When a name is chosen
1. Re-verify: `curl -s -o /dev/null -w "%{http_code}" https://registry.npmjs.org/<name>` (404 = free)
2. Rename this folder, update `package.json` name + `bin`, and the CLI banner in `src/cli.ts`
3. `gh repo create <name> --public --source . --push`
