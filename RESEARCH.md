# Autonomous UI Graph Testing — Viability Report

*Research date: 2026-08-13. Three parallel research tracks: commercial landscape, academic/open-source lineage, and current agent-driven dev-loop tooling. Alignment decisions from the user: platform-agnostic concept (web-first implementation), discovery-first exploration whose graph becomes a diffable baseline, deliverable = this report.*

---

## 1. Verdict

**Viable, and the specific thing you described does not exist yet.**

Three findings drive that conclusion:

1. **The mechanics are solved.** No screen takeover is needed. Headless browser automation (Playwright / Chrome DevTools Protocol) lets an agent click real buttons, fill real forms, and read real screens programmatically — through the accessibility tree, not pixels. "Coding agent verifies its own frontend work" is already a mainstream workflow in Claude Code, Cursor, and GitHub Copilot via Playwright MCP.

2. **The idea has a 20-year lineage, and the graveyard is instructive.** What you described is called *model-based GUI testing*: a crawler explores the app and infers a **state-flow graph** (screens = nodes, actions = edges). Crawljax built exactly this for web apps starting in 2008. GUITAR did it for desktop. Facebook ran Sapienz in production. Three problems killed broad adoption: **state explosion** (real apps have more distinguishable states than any crawler can exhaust), **the oracle problem** (without a spec, what counts as "broken"?), and **model maintenance** (the graph shatters on every redesign). LLMs materially improve the economics of all three; they fully solve none.

3. **The specific combination is unclaimed territory.** Per the commercial survey, *no shipping product* combines: (a) an explicit persistent state graph as the core artifact, (b) diffing **that graph** run-over-run to catch structural regressions, (c) open-source licensing, and (d) running locally in the dev inner loop. Every adjacent piece exists somewhere; nothing combines them. The closest true analog as a product — Octomind's zero-config auto-discovery — was discontinued in May 2026.

---

## 2. What already exists (so we don't rebuild it)

### The actuation layer — commodity, reuse as-is
- **Playwright MCP** (microsoft/playwright-mcp): 50+ tools, accessibility-tree snapshots with numbered element refs. Deterministic, cheap, no vision model needed. This is how an agent "sees" and "clicks" a web app today.
- **Chrome DevTools MCP**: same idea plus performance tracing, console/network inspection, heap snapshots.
- **Mobile:** Maestro MCP (agent writes YAML flows, self-corrects until they pass, flow becomes a git-committable artifact that runs in CI) and mobile-mcp (accessibility-tree-first iOS/Android driving). The pattern ports.
- **Agentic browser SDKs:** Stagehand (Browserbase, MIT, 24k stars), browser-use (109k stars), Skyvern. All do LLM-driven "given a goal, act on the live page." None builds a persistent graph.

### The cost-control pattern — proven, adopt it
The field has converged on one recipe, implemented independently by Playwright Agents, Stagehand, Passmark (Bug0), and Maestro:

> **The LLM authors; deterministic code executes.** The expensive LLM exploration happens once. Its output is a plain replayable artifact (Playwright spec, YAML flow, cached action trace) that runs at native speed with zero tokens. The LLM re-enters only when a replay breaks ("healing").

This matters because raw agent-in-the-loop verification is expensive: a documented comparison found ~114K tokens per Playwright-MCP end-to-end verification vs ~27K for a CLI/file-artifact workflow. A tool that re-explores from scratch on every change is economically dead on arrival; one that replays cached walks and spends tokens only on deltas is cheap.

### Nearest neighbors to the full idea
| Thing | What it does | Why it isn't your tool |
|---|---|---|
| **Playwright Agents** (planner/generator/healer, v1.56, Oct 2025, MIT) | Explores the live app per-goal, writes a test plan, generates specs, heals failures | Goal-scoped and per-invocation. No persistent app-wide graph, no baseline diff |
| **AutoDroid** (research, arXiv 2308.15272) | Pre-explores an Android app once, builds a **UI Transition Graph**, injects it as agent memory — halves LLM cost, 71% task completion | Android-only, built as agent memory, not CI-grade regression diffing |
| **Explorbot** (testomat.io, ~65 stars, Elastic License) | Autonomous exploration, persists learned per-app state across runs, runs locally | Cached heuristics, not a formal graph; no graph diff; source-available not OSS |
| **Meticulous** | Records real sessions, replays deterministically against new commits with network mocked | Requires humans to generate sessions; no autonomous discovery |
| **Momentic / QA Wolf Mapping AI** | "Autonomous exploration" marketing; crawl → flat test suite | No persistent graph artifact, no graph diff; closed SaaS, cloud-only |
| **arXiv 2506.02529** (June 2025) | Crawls a site, builds a literal screen-transition graph, Dijkstra between states, LLM per edge | Research paper; no productization, no baseline diffing, no dev-loop integration |
| **Octomind** | True zero-config auto-discovery → Playwright tests | **Discontinued May 2026** |

A caution from the survey: marketing language in this category ("maps your app," "explores autonomously") is heavily oversold relative to documented capability. Most claims resolve to goal-scoped single-flow crawls or rebranded session recording.

---

## 3. The three hard problems, honestly

These are why the graph is the hard part and the clicking is the easy part.

### a) State equivalence — "are these two screens the same state?"
The core unsolved problem. Four known approaches (DOM hashing, visual similarity, URL, neural embeddings) each have named failure modes; a 2025/26 empirical study confirms no consensus winner, and benchmarks (EvoGUI, 2026) exist *because* "does a state graph survive a UI change" is recognized as open. Get this wrong in one direction and the graph explodes with near-duplicates; wrong in the other direction and genuinely distinct states collapse together. Any design must treat state identity as a **lossy judgment call with confidence levels**, not a fact.

### b) The oracle problem — "what counts as broken?"
Crash/error detection is the cheap, solved floor. Everything above it (functional correctness, "is this the intended behavior") is open; LLM-as-judge is the current best hope and explicitly unproven at scale. **Your discovery-first-then-baseline decision largely sidesteps this**: run 1 doesn't claim correctness, it records *what is*. The human blesses the graph. From then on the oracle is the diff — "this transition worked yesterday and errors today" needs no spec. That's the same move App Atlas makes: report what IS, don't guess at intent.

### c) State explosion — "exhaustive" is unreachable
Coverage plateaus persist even for LLM agents (a 2026 paper names a historical ~30% code-coverage ceiling for autonomous GUI testing; frontier agents still score far below humans on VisualWebArena). Real apps' state spaces grow faster than any abstraction compresses them. The tool must be *heuristic with honest, measured gaps* — report "walked 34 of 41 known transitions, 7 unreached" rather than implying totality. A confident false "all good" is worse than a blank.

---

## 4. Why App Atlas changes the math — the actual differentiator

This is the part nobody else has, and it directly attacks all three hard problems.

Every crawler surveyed starts **blind**: it discovers the app's structure by clicking around, which is exactly why state explosion and state identity are brutal. But App Atlas already extracts, statically, the things a crawler struggles to infer dynamically:

- **Routes** → a prior over the node set. The crawler isn't discovering states from nothing; it's *confirming and enriching* a map that came from the code.
- **Components per route** → state-identity hints ("these two URLs render the same component" ≈ same state family).
- **API calls per screen** → expected network behavior per node, giving a free semi-oracle ("this screen normally fires GET /api/orders; today it fired nothing").
- **The static/dynamic diff is itself a findings report**, in both directions:
  - *In code but unreachable in UI*: route exists, no walked path arrives at it → dead screen or missing nav.
  - *Reachable in UI but not in the static graph*: analyzer gap or dynamically-constructed route — exactly the drift-detection App Atlas already cares about.

So the pitch isn't "another AI testing tool" (a crowded, commoditizing space — multiple $9–15M raises in 2025 chasing overlapping NL-authoring/self-healing territory, and Octomind dead). The pitch is: **App Atlas maps what the code says; this walks what the app does; the diff between those two graphs is where bugs live.** Static analysis gives the dynamic crawler a map; the dynamic walk gives the static map a truth-check.

### The tracer bullet, concretely
You build a feature (say, an "Export" button on the orders screen). Then:
1. Static side: App Atlas-style analysis sees a new component and a new API call on the `/orders` route → the *expected* graph gains an edge.
2. Dynamic side: the walker re-walks only the affected neighborhood (the `/orders` node and its edges — not the whole app), clicks the new button headlessly, records what happens: navigation? network call? error? nothing?
3. Result: either the new edge is confirmed and frozen into the baseline (with a replayable script attached), or you get "the button renders but the click produces no state change and no network call" — the dead-button case, caught minutes after writing it, without you or anyone driving the UI.

That's vertical verification of one feature, not horizontal whole-app regression — precisely the tracer bullet.

---

## 5. Proposed architecture

Five layers, four of which are assembly of existing parts:

1. **Driver** (commodity): Playwright headless via accessibility-tree snapshots. Design as an adapter interface so Maestro/mobile-mcp can slot in later for mobile — the graph model must be platform-neutral even if v1 is web-only.
2. **Graph store** (the novel artifact): a versionable, human-readable file in the repo (like ATLAS.md). Nodes = UI states with a layered fingerprint (route + component identity + normalized accessibility-tree hash + optional screenshot), each carrying a confidence level. Edges = actions with preconditions, expected postconditions (destination state, expected network calls), and a pointer to a replayable script. Explicit `unexplored` markers on known-but-unwalked edges.
3. **Explorer** (LLM, expensive, runs rarely): agent walks the app seeded by the static route map, proposes state-identity judgments, emits deterministic replay scripts per edge. Runs on first setup and when the walker finds structure the graph doesn't know.
4. **Walker/differ** (deterministic, cheap, runs constantly): replays cached edge scripts — no LLM, no tokens — and diffs outcomes against the baseline: missing states, broken transitions, changed network behavior, new error states. Scoped re-walk: only the neighborhood touched by the code change (which the static layer identifies from the diff).
5. **Healer/judge** (LLM, on demand): when a replay breaks, decide *same state redesigned* (update node), *new state* (extend graph), or *regression* (flag). This is the state-equivalence judgment call — surface low-confidence verdicts to the human instead of asserting.

**Key design rules** (imported from App Atlas hard lessons):
- Blank over confident falsehood — unwalked edges are labeled unwalked, never assumed working.
- The graph is a repo artifact, diffable in PRs, so "the app's structure changed" shows up in review like any other change.
- Tokens only at the edges of the loop (first exploration, healing); the inner loop is deterministic replay.

---

## 6. Risks

- **State equivalence is the product risk**, not the model risk. Misjudged "same/different/broken" verdicts erode trust fast. Mitigation: layered fingerprints, confidence levels, human confirmation on low-confidence diffs, and the static map as an anchor.
- **Auth, fixtures, and side effects**: real apps need login and non-destructive data. Meticulous solves this with record-and-mock networking; MSW-style interception is the standard tool. This is engineering, not research, but it's a lot of engineering.
- **Market signal cuts both ways**: the gap is real, but Octomind died occupying nearby territory, and the flat-test-generation submarket is commoditizing. The defensible position is the graph-diff data model + static/dynamic cross-check, not "more autonomous" framing.
- **Nondeterministic apps** (feeds, ads, timestamps, animations) are the classic crawler-killer — Stoat measurably degraded on them. Network mocking and tree normalization are the mitigations; some apps will still be hostile.

---

## 7. Recommended path (if/when you build)

1. **MVP (weekend-scale):** no new framework. A Claude Code skill + Playwright that (a) reads the app's route map, (b) walks each route headlessly, (c) writes `ui-graph.json` + one replay script per edge, (d) on next run, replays and prints a graph diff. One real app (your own UI) as the test bed.
2. **Prove the tracer bullet:** make one feature-scoped walk work end-to-end — change a component, have the tool re-walk only that neighborhood and confirm/flag the new edge.
3. **Then the hard part:** state-identity layering and the healer's same/new/broken judgment, with confidence surfaced.
4. **Mobile later**, through the adapter interface (Maestro's YAML-flow artifact model is the template).

---

## Appendix: primary sources

**Dev-loop tooling:** [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) · [Playwright Test Agents](https://playwright.dev/docs/test-agents) · [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) · [Maestro MCP](https://maestro.dev/mcp) · [mobile-next/mobile-mcp](https://github.com/mobile-next/mobile-mcp) · [vercel-labs/ralph-loop-agent](https://github.com/vercel-labs/ralph-loop-agent) · token-cost analysis: [scrolltest (Medium)](https://scrolltest.medium.com/playwright-mcp-burns-114k-tokens-per-test-the-new-cli-uses-27k-heres-when-to-use-each-65dabeaac7a0)

**Lineage & research:** Crawljax ([repo](https://github.com/crawljax/crawljax), dormant since 2023) · [Sapienz at Meta](https://engineering.fb.com/2018/05/02/developer-tools/sapienz-intelligent-automated-software-testing-at-scale/) · [Fastbot2, ASE 2022](https://tingsu.github.io/files/ASE22-industry-Fastbot.pdf) · AutoDroid ([arXiv 2308.15272](https://arxiv.org/abs/2308.15272)) · GPTDroid ([arXiv 2310.15780](https://arxiv.org/abs/2310.15780)) · DroidAgent ([arXiv 2311.08649](https://arxiv.org/abs/2311.08649)) · AXNav, Apple CHI 2024 ([arXiv 2310.02424](https://arxiv.org/abs/2310.02424)) · WebEmbed state equivalence ([arXiv 2306.07400](https://arxiv.org/abs/2306.07400)) · screen-transition-graph generation ([arXiv 2506.02529](https://arxiv.org/abs/2506.02529)) · exploration-strategies empirical study ([arXiv 2606.16650](https://arxiv.org/abs/2606.16650)) · EvoGUI benchmark ([arXiv 2607.17050](https://arxiv.org/abs/2607.17050)) · challenges review: Nass/Alégroth/Feldt, IST 2021

**Commercial:** [Meticulous](https://www.meticulous.ai/how-it-works) · [QA Wolf Mapping AI](https://www.qawolf.com/mapping-ai) · [Momentic](https://momentic.ai/) · [Applitools Autonomous](https://applitools.com/platform/autonomous/) · [Checksum](https://checksum.ai/) · [Shiplight](https://www.shiplight.ai/) · [Explorbot](https://github.com/testomatio/explorbot) · [Passmark (Bug0)](https://bug0.com/blog/why-we-open-sourced-passmark-ai-regression-testing-framework) · [Stagehand](https://github.com/browserbase/stagehand) · Octomind (discontinued May 2026)
