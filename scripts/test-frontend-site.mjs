#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  assertPriorResearchArchive,
  assertPublicDocumentPair,
  destinationLabel,
  donorAcknowledgement,
  filterAndSortProblems,
  formatDomain,
  formatMoney,
  generatedOutputTokensByProblem,
  initialResearchDirection,
  loadWithRetry,
  netContributionCents,
  netPoolContributionCents,
  netProblemContributionCents,
  pollKeepingLastGood,
  priorResearchForCurrentCatalog,
  processedPoolBalanceCents,
  processingPresentation,
  publicObjectUrl,
  researchRunCount,
  searchableDonation,
  statusPresentation,
  visibleContributions,
} from "../assets/site-data.js";
import { fingerprintSiteAssets } from "./fingerprint-site-assets.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFile = promisify(execFileCallback);

test("the public site is catalog-driven, accessible, and ledger-verifying", async () => {
  const [
    indexHtml,
    ledgerHtml,
    siteScript,
    siteStyles,
    siteWorker,
    headers,
    redirects,
    readme,
  ] = await Promise.all([
    readFile(path.join(rootDir, "index.html"), "utf8"),
    readFile(path.join(rootDir, "ledger.html"), "utf8"),
    readFile(path.join(rootDir, "assets", "site.js"), "utf8"),
    readFile(path.join(rootDir, "assets", "site.css"), "utf8"),
    readFile(path.join(rootDir, "site-worker.mjs"), "utf8"),
    readFile(path.join(rootDir, "_headers"), "utf8"),
    readFile(path.join(rootDir, "_redirects"), "utf8"),
    readFile(path.join(rootDir, "README.md"), "utf8"),
  ]);

  for (const html of [indexHtml, ledgerHtml]) {
    assert.match(html, /<a class="skip-link" href="#main-content">/);
    assert.match(html, /<main id="main-content"/);
    assert.doesNotMatch(html, /class="nav-contribute"/);
    assert.match(html, /href="https:\/\/github\.com\/neelsomani\/indiemath"/);
    assert.match(html, /href="terms\.html" data-terms-link/);
    assert.match(html, /src="terms\.html\?embedded=1"/);
    assert.match(
      html,
      /name="indiemath-public-data" content="https:\/\/pub-[a-f0-9]+\.r2\.dev"/,
    );
    assert.match(html, /href="assets\/site\.[a-f0-9]{8}\.css\?r=\d+"/);
    assert.match(html, /<script type="module" src="assets\/site\.[a-f0-9]{8}\.js\?r=\d+"><\/script>/);
    assert.doesNotMatch(html, /Operated by Lipschitz Strategies LLC\./);
    assert.doesNotMatch(html, /<strong>Explore<\/strong>/);
    assert.match(
      html,
      /<img class="wordmark-mark" src="apple-touch-icon\.png" alt="" aria-hidden="true">/,
    );
    assert.match(
      html,
      /<nav class="site-nav" id="primary-navigation" aria-label="Primary navigation">/,
    );
    assert.match(
      html,
      /<button class="nav-menu-button"[^>]+aria-controls="primary-navigation"[^>]+aria-expanded="false">/,
    );
    assert.doesNotMatch(html, /∴/);
    assert.doesNotMatch(
      html,
      /class="footer-main"|wordmark-footer|class="footer-project"|class="footer-icon-link"/,
    );
    assert.match(html, /<footer class="site-footer">\s*<div class="footer-legal">/);
    assert.doesNotMatch(html, />GitHub<\/a>|>contact@indiemath\.ai<\/a>/);
    assert.match(
      html,
      /No rights reserved\. <a href="terms\.html" data-terms-link>Terms &amp; Conditions<\/a>/,
    );
  }
  assert.match(indexHtml, /<aside class="live-strip" aria-label="Contribution Tracker">/);
  assert.match(
    indexHtml,
    /<title>IndieMath - Community-Funded Mathematical Problem Solving<\/title>/,
  );
  assert.match(indexHtml, /<a href="#problems" aria-current="page">Problems<\/a>/);
  assert.match(
    ledgerHtml,
    /<a href="ledger\.html" aria-current="page">Contribution Tracker<\/a>/,
  );
  assert.match(
    ledgerHtml,
    /<th>Contributed<\/th><th title="Amount after Open Collective\/Stripe processing fees">Net received<\/th>/,
  );
  assert.match(siteScript, /formatMoney\(donation\.netCents\)/);
  assert.match(ledgerHtml, /id="contribution-rows"[^>]*><tr><td colspan="7"/);
  assert.match(indexHtml, /<div class="metric-strip" id="metric-grid"/);
  assert.ok(
    indexHtml.indexOf('class="live-strip"') < indexHtml.indexOf('class="problems-section'),
    "the compact Contribution Tracker should precede the problem catalog",
  );
  assert.doesNotMatch(indexHtml, /live-overview-title|Where the system stands/);
  assert.match(siteStyles, /\.metric-strip/);
  assert.doesNotMatch(
    siteStyles,
    /\.footer-main|\.wordmark-footer|\.footer-project|\.footer-icon-link/,
  );
  assert.match(
    siteStyles,
    /\.site-footer\s*\{\s*padding: 24px max\(24px, calc\(\(100vw - var\(--max\)\) \/ 2\)\);/,
  );
  assert.match(siteStyles, /\.ledger-summary\s*\{\s*padding: 24px 0 20px;/);
  assert.match(siteStyles, /\.ledger-explorer\s*\{\s*padding: 28px 0 48px;/);
  assert.match(siteStyles, /\.ledger-bottom-source\s*\{/);
  assert.match(
    siteStyles,
    /\.ledger-explorer \.section-heading\s*\{\s*margin-bottom: 18px;/,
  );
  assert.match(siteScript, /metrics\.map\(compactMetric\)/);
  assert.match(
    siteScript,
    /function renderHomepageMetrics[\s\S]*const netContributions = netContributionCents\([\s\S]*value: formatMoney\(netContributions\)/,
  );
  assert.doesNotMatch(
    siteScript,
    /label: "Received",\s*value: formatMoney\(state\.unprocessedCents\)/,
  );
  assert.doesNotMatch(indexHtml, /class="problem-dialog"/);
  assert.match(indexHtml, /class="problem-row-shell problem-row-loading"/);
  assert.match(
    siteScript,
    /function problemRow\(problem, ledger, priorResearchResponse\)/,
  );
  assert.match(siteScript, /"aria-expanded": "false"/);
  assert.match(siteScript, /className: "problem-row-expanded"/);
  assert.match(
    siteScript,
    /querySelectorAll\(\s*"\.problem-row-shell-expanded"/,
  );
  assert.doesNotMatch(siteScript, /problemDialog|showModal\(\).*problem/i);
  assert.match(siteScript, /function formattedMathText\(value\)/);
  assert.match(
    siteScript,
    /function directionPrompt\(problem, ledger, priorResearchResponse\)/,
  );
  assert.match(siteScript, /className: "direction-textbox"/);
  assert.match(siteScript, /className: "direction-instruction"/);
  assert.match(siteScript, /problem\.directions\[direction\]/);
  assert.match(siteScript, /renderPaginatedOutput\(/);
  assert.match(siteScript, /OUTPUT_POLL_INTERVAL_MS/);
  assert.match(siteScript, /PUBLIC_STATE_POLL_INTERVAL_MS/);
  assert.match(siteScript, /indiemath:output-pane/);
  assert.match(siteScript, /pollKeepingLastGood\(/);
  assert.match(siteScript, /\bvisibleContributions,\n/);
  assert.doesNotMatch(siteScript, /currentResponseKey\(/);
  assert.match(siteScript, /transcripts\/\$\{problem\.problemId\}\/\$\{direction\}\/session\.md/);
  assert.match(siteScript, /paginateResearchText\(text, pageSize = 6_000\)/);
  assert.match(siteScript, /Page \$\{pageIndex \+ 1\} of \$\{pages\.length\}/);
  assert.match(
    siteScript,
    /pages\.length > 3\s*\? \[first, previous, position, next, last\]/,
  );
  assert.match(
    siteScript,
    /const contributedCents = netPoolContributionCents\(ledger\.donations,/,
  );
  assert.match(
    siteScript,
    /const receivedCents = netProblemContributionCents\(\s*ledger\.donations,/,
  );
  assert.match(siteScript, /text: `\$\{directionLabel\(claim\.direction\)\} running`/);
  assert.match(siteStyles, /\.status-running\s*\{/);
  assert.doesNotMatch(
    siteScript,
    /pool\.cumulativeDonationsCents\s*\+\s*pool\.unprocessedCents/,
  );
  assert.match(siteScript, /ledger\.runs[\s\S]*run\.spentCents/);
  assert.doesNotMatch(siteScript, /Research directions and catalog source/);
  assert.doesNotMatch(siteScript, /Catalog source:/);
  assert.doesNotMatch(siteScript, /toward its next hour|next research hour/);
  assert.doesNotMatch(siteStyles, /\.progress-track|\.direction-progress-copy/);
  assert.match(siteScript, /element\("sup", \{/);
  assert.doesNotMatch(
    siteScript,
    /Minimum contribution|Published pool amounts|Received contributions are ordinarily processed/,
  );
  assert.match(siteStyles, /\.math-sup\s*\{/);
  assert.match(
    siteStyles,
    /\.inline-research-output pre\s*\{[\s\S]*max-height: 330px;[\s\S]*overflow: auto;/,
  );
  assert.match(siteStyles, /\.problem-row\s*\{/);
  assert.doesNotMatch(siteStyles, /\.problem-card/);
  assert.doesNotMatch(
    indexHtml,
    /<p class="eyebrow">Community-funded AI research<\/p>|class="hero"|hero-title|How IndieMath stays accountable/,
  );
  assert.doesNotMatch(siteStyles, /\.hero(?:\s|\{|-)|\.proof-/);
  assert.doesNotMatch(siteStyles, /\.nav-contribute/);
  assert.doesNotMatch(siteScript, /catalog-revision/);
  assert.match(siteScript, /notice\.textContent = "Runs paused";/);
  assert.doesNotMatch(siteScript, /no compute is staged/);
  assert.doesNotMatch(siteScript, /generation verified/);
  assert.doesNotMatch(siteScript, /Verified generation|catalog revision/);
  assert.doesNotMatch(indexHtml, /Open ledger/);
  assert.doesNotMatch(indexHtml, /Public ledger/i);
  assert.doesNotMatch(ledgerHtml, /Public ledger/i);
  assert.match(indexHtml, /Contribution Tracker/);
  assert.match(ledgerHtml, /Contribution Tracker/);
  assert.doesNotMatch(indexHtml, /Donation Tracker/i);
  assert.doesNotMatch(ledgerHtml, /Donation Tracker/i);
  assert.doesNotMatch(indexHtml, /The catalog|Support an attempt to prove/);
  assert.doesNotMatch(ledgerHtml, /System totals/);
  assert.doesNotMatch(ledgerHtml, /Find a public record/);
  assert.doesNotMatch(
    ledgerHtml,
    /Payment credentials, Stripe account data, API keys, raw settlement evidence, and model request bodies are never included/,
  );
  assert.match(
    ledgerHtml,
    /<script type="module" src="assets\/site\.[a-f0-9]{8}\.js\?r=\d+"><\/script>/,
  );
  assert.doesNotMatch(ledgerHtml, /Public accounting|ledger-hero/);
  assert.doesNotMatch(
    ledgerHtml,
    /Every catalog entry links straight to its own proof and disproof contribution flow/,
  );
  assert.match(
    ledgerHtml,
    /<a class="ledger-source-link" href="https:\/\/opencollective\.com\/indiemath" target="_blank" rel="noopener noreferrer">View on Open Collective/,
  );
  assert.ok(
    ledgerHtml.indexOf('aria-label="Line-item explorer"')
      < ledgerHtml.indexOf('class="ledger-bottom-source"')
      && ledgerHtml.indexOf('class="ledger-bottom-source"')
        < ledgerHtml.indexOf('<footer class="site-footer">'),
    "the Open Collective source link should sit below the explorer and above the footer",
  );
  assert.doesNotMatch(indexHtml, /One public chain of evidence|how-it-works/);
  assert.doesNotMatch(indexHtml, /Each problem has two independent pools/);
  assert.doesNotMatch(indexHtml, /Choose a claim to pursue/);
  assert.doesNotMatch(indexHtml, /Nothing up our sleeve|audit-callout|The ledger is the product/);
  assert.match(indexHtml, /class="problems-section ledger-summary"/);
  assert.match(siteStyles, /\.problems-section\s*\{\s*padding: 64px 0 82px;/);
  assert.match(
    siteStyles,
    /\.problems-section\.ledger-summary\s*\{\s*padding-top: 24px;/,
  );
  assert.doesNotMatch(ledgerHtml, /Want to fund the next line|audit-callout/);
  assert.doesNotMatch(ledgerHtml, /how-it-works/);
  assert.doesNotMatch(siteStyles, /\.audit-callout/);
  assert.doesNotMatch(siteStyles, /\.how-section|\.how-grid|\.step-number/);
  assert.match(
    indexHtml,
    /processed within 1–2 business days after receipt \(Monday through Friday\)/,
  );
  assert.doesNotMatch(indexHtml, /and become runnable once processed/i);
  assert.match(siteScript, /Claimed solved · under review · unverified/);
  assert.match(ledgerHtml, /role="tablist"/);
  assert.match(ledgerHtml, /Contributor<\/th><th>Destination/);
  assert.doesNotMatch(indexHtml, /NP versus P\/poly|cs-001|math-001/);
  assert.match(siteScript, /publicObjectUrl\(publicDataBaseUrl, state\.ledgerKey\)/);
  assert.match(
    siteScript,
    /"public\/prior-research\/manifest\.json"/,
  );
  assert.doesNotMatch(
    siteScript,
    /archivePanel|Read archived response/,
  );
  assert.match(siteScript, /Research output/);
  assert.match(
    siteScript,
    /publicObjectUrl\(\s*publicDataBaseUrl,\s*priorResearchResponse\.contextKey,\s*\)/,
  );
  assert.match(
    siteScript,
    /href: `index\.html#problem-\$\{run\.problemId\}-\$\{run\.direction\}`/,
  );
  assert.doesNotMatch(siteScript, /Catalog source:/);
  assert.match(
    siteScript,
    /renderLedgerPage\(publicState, publicLedger, priorResearchArchive\)/,
  );
  assert.doesNotMatch(siteScript, /archival/i);
  assert.doesNotMatch(siteStyles, /\.archive-panel|\.archive-link/);
  assert.match(siteScript, /digest !== state\.ledgerSha256/);
  assert.match(siteScript, /pool\.checkoutUrl/);
  assert.match(siteScript, /checkoutUrlWithDefaults\(/);
  assert.match(siteScript, /url\.searchParams\.set\("interval", "oneTime"\)/);
  assert.match(siteScript, /url\.searchParams\.set\("contributeAs", "me"\)/);
  assert.match(siteScript, /View IndieMath on Open Collective/);
  assert.match(siteScript, /Resolved under assumption:/);
  assert.match(siteScript, /mutually contradictory/);
  assert.match(siteScript, /donorAcknowledgement\(problem, ledger\)/);
  assert.match(
    siteScript,
    /netContributionCents\(\s*ledger\.accounting,\s*ledger\.treasury,\s*\)/,
  );
  assert.match(siteScript, /ledger\.accounting\.approximateRunSpendCents/);
  assert.match(siteScript, /processedPoolBalanceCents\(state\.problems\)/);
  assert.match(siteScript, /ledger\.rampSpend\.actualSpendCents/);
  assert.match(
    siteScript,
    /note: "Reconciled periodically against approximate run spend",/,
  );
  assert.doesNotMatch(
    `${ledgerHtml}\n${siteScript}`,
    /Actual outflows to Anthropic|Reconciled periodically against approximate run spend\./,
  );
  assert.match(
    siteScript,
    /No processed funds available - runs paused\./,
  );
  assert.match(
    siteScript,
    /Runs paused - Anthropic monthly plan limit reached\./,
  );
  assert.doesNotMatch(siteScript, /refundable until staged/);
  assert.match(siteScript, /After Open Collective\/Stripe processing fees/);
  assert.match(siteScript, /Takes 1–2 business days/);
  assert.match(indexHtml, /Available run funds/);
  assert.doesNotMatch(indexHtml, /Compute capacity/);
  assert.match(siteScript, /label: "Available run funds"/);
  assert.match(indexHtml, /<details class="problem-filter-disclosure"[^>]+open>/);
  assert.match(siteScript, /disclosure\.open = false/);
  assert.match(siteScript, /function initMobileNavigation\(\)/);
  assert.match(siteStyles, /@media \(max-width: 1000px\)[\s\S]*\.nav-menu-button\s*\{\s*display: block;/);
  assert.match(
    siteStyles,
    /@media \(max-width: 680px\)[\s\S]*\.problem-filter-disclosure > summary\s*\{\s*display: list-item;/,
  );
  const metricLabels = [
    "Net contributions",
    "Received · unprocessed",
    "Current pool balances",
    "Approximate run spend",
    "Actual Ramp spend",
  ];
  let metricLabelOffset = -1;
  for (const label of metricLabels) {
    const nextOffset = ledgerHtml.indexOf(label);
    assert.ok(
      nextOffset > metricLabelOffset,
      `ledger metric ${label} should appear in pipeline order`,
    );
    metricLabelOffset = nextOffset;
  }
  assert.doesNotMatch(siteScript, /sum\(ledger\.donations|sum\(ledger\.runs/);
  assert.doesNotMatch(siteScript, /\.innerHTML\s*=/);
  assert.match(siteStyles, /@media \(max-width: 680px\)/);
  assert.match(siteStyles, /prefers-reduced-motion: reduce/);
  assert.match(
    siteStyles,
    /\.metric-grid \.metric-card:last-child:nth-child\(odd\)\s*\{\s*grid-column: 1 \/ -1;/,
  );
  assert.match(headers, /Content-Security-Policy:/);
  assert.match(
    siteWorker,
    /pathname === "\/seed" \|\| pathname\.startsWith\("\/seed\/"\)/,
  );
  assert.match(siteWorker, /status: 410/);
  assert.match(redirects, /^\/seed\/\* \/ 301$/m);
  assert.match(headers, /connect-src 'self' https:\/\/pub-[a-f0-9]+\.r2\.dev/);
  assert.match(headers, /frame-ancestors 'self'/);
  assert.match(headers, /X-Frame-Options: SAMEORIGIN/);
  assert.doesNotMatch(headers, /frame-ancestors 'none'|X-Frame-Options: DENY/);
  assert.match(headers, /X-Content-Type-Options: nosniff/);
  assert.match(readme, /website is intentionally catalog-driven/i);
  assert.doesNotMatch(readme, /59 problems|NP versus P\/poly|cs-001/);
});

test("root Pages entry points carry current frontend fingerprints", async () => {
  await fingerprintSiteAssets(rootDir, { check: true });
});

test("the production build fingerprints every mutable frontend dependency",
  async () => {
    await execFile(process.execPath, [
      path.join(rootDir, "scripts", "build-site.mjs"),
    ]);
    const clientDir = path.join(rootDir, "dist", "client");
    const [indexHtml, ledgerHtml, siteStyles, sourceSiteScript, siteData] = (
      await Promise.all([
        readFile(path.join(clientDir, "index.html"), "utf8"),
        readFile(path.join(clientDir, "ledger.html"), "utf8"),
        readFile(path.join(clientDir, "assets", "site.css")),
        readFile(path.join(clientDir, "assets", "site.js")),
        readFile(path.join(clientDir, "assets", "site-data.js")),
      ])
    );
    const siteStylesVersion = createHash("sha256")
      .update(siteStyles)
      .digest("hex")
      .slice(0, 8);
    const siteDataVersion = createHash("sha256")
      .update(siteData)
      .digest("hex")
      .slice(0, 8);
    const versionedSiteScript = sourceSiteScript
      .toString("utf8")
      .replace(
        /from "\.\/site-data\.js(?:\?v=[a-f0-9]{8})?";/,
        `from "./site-data.${siteDataVersion}.js";`,
      );
    const siteScriptVersion = createHash("sha256")
      .update(versionedSiteScript)
      .digest("hex")
      .slice(0, 8);
    for (const html of [indexHtml, ledgerHtml]) {
      assert.ok(
        html.includes(`href="assets/site.${siteStylesVersion}.css?r=1"`),
      );
      assert.ok(
        html.includes(`src="assets/site.${siteScriptVersion}.js?r=1"`),
      );
    }
    const [siteScript, versionedSiteData] = await Promise.all([
      readFile(
        path.join(clientDir, "assets", `site.${siteScriptVersion}.js`),
        "utf8",
      ),
      readFile(
        path.join(clientDir, "assets", `site-data.${siteDataVersion}.js`),
      ),
    ]);
    assert.ok(
      siteScript.includes(
        `from "./site-data.${siteDataVersion}.js";`,
      ),
    );
    assert.deepEqual(versionedSiteData, siteData);
  });

test("prior research metadata validates without repository output files", () => {
  const archive = {
    schemaVersion: 1,
    kind: "prior-research-archive",
    responses: [{
      problemId: "math-001",
      direction: "disprove",
      claimTs: 1_700_000_000_000,
      outputTokens: 12_345,
      contextKey: "transcripts/math-001/disprove/compacted.md",
      contextSha256: "a".repeat(64),
    }],
  };
  const problems = [{ problemId: "math-001" }];
  assert.equal(assertPriorResearchArchive(archive, problems), true);
  assert.equal(
    researchRunCount({ runs: [], archivedResponses: archive.responses }),
    1,
  );
});

test("retired prior research cannot take down the current catalog", () => {
  const current = priorResearchForCurrentCatalog({
    schemaVersion: 1,
    kind: "prior-research-archive",
    responses: [
      {
        problemId: "math-001",
        direction: "disprove",
        claimTs: 1_700_000_000_000,
        outputTokens: 100,
        contextKey: "transcripts/math-001/disprove/compacted.md",
        contextSha256: "a".repeat(64),
      },
      {
        problemId: "math-retired",
        direction: "disprove",
        claimTs: 1_700_000_000_001,
        outputTokens: 200,
        contextKey: "transcripts/math-retired/disprove/compacted.md",
        contextSha256: "b".repeat(64),
      },
    ],
  }, [{ problemId: "math-001" }]);
  assert.deepEqual(
    current.responses.map((response) => response.problemId),
    ["math-001"],
  );
  assert.equal(assertPriorResearchArchive(current, [{ problemId: "math-001" }]), true);
});

test("problem discovery filters and orders without a fixed catalog", () => {
  const problems = [
    problem({
      problemId: "math-z",
      title: "Zeta conjecture",
      domain: "number-theory",
      statement: "Every zeta has property Z.",
      status: "Open",
      totalPoolBalanceCents: 10_000,
    }),
    problem({
      problemId: "cs-a",
      title: "Alpha lower bound",
      domain: "theoretical-computer-science",
      statement: "The alpha lower bound is superpolynomial.",
      status: "PendingReview",
      totalPoolBalanceCents: 60_000,
    }),
    problem({
      problemId: "math-b",
      title: "Beta conjecture",
      domain: "number-theory",
      statement: "Every beta is bounded.",
      status: "Solved",
      totalPoolBalanceCents: 5_000,
    }),
    problem({
      problemId: "math-live",
      title: "Live conjecture",
      domain: "number-theory",
      statement: "Every live object is bounded.",
      status: "Open",
      totalPoolBalanceCents: 0,
      liveClaims: [{ direction: "prove" }],
    }),
    problem({
      problemId: "math-c",
      title: "Content-rich conjecture",
      domain: "number-theory",
      statement: "Every content-rich object is bounded.",
      status: "Open",
      totalPoolBalanceCents: 5_000,
    }),
  ];
  const generatedOutputTokens = new Map([
    ["math-live", 50],
    ["math-b", 100],
    ["math-c", 200],
  ]);

  assert.deepEqual(
    filterAndSortProblems(problems, { query: "lower bound" })
      .map((entry) => entry.problemId),
    ["cs-a"],
  );
  assert.deepEqual(
    filterAndSortProblems(problems, { domain: "number-theory", sort: "title" })
      .map((entry) => entry.problemId),
    ["math-b", "math-c", "math-live", "math-z"],
  );
  assert.deepEqual(
    filterAndSortProblems(problems, { status: "Solved" })
      .map((entry) => entry.problemId),
    ["math-b"],
  );
  assert.deepEqual(
    filterAndSortProblems(problems, { sort: "funding", generatedOutputTokens })
      .map((entry) => entry.problemId),
    ["cs-a", "math-z", "math-c", "math-b", "math-live"],
  );
  assert.deepEqual(
    filterAndSortProblems(problems, { generatedOutputTokens })
      .map((entry) => entry.problemId),
    ["math-live", "cs-a", "math-z", "math-c", "math-b"],
  );
  assert.equal(formatDomain("theoretical-computer-science"), "Theoretical Computer Science");
});

test("generated output totals include live runs and preserved prior work", () => {
  const totals = generatedOutputTokensByProblem({
    runs: [
      {
        problemId: "math-a",
        transcriptSegments: [
          { usage: { output_tokens: 125 } },
          { usage: { output_tokens: 75 } },
        ],
      },
      {
        problemId: "math-b",
        transcriptSegments: [{ usage: { output_tokens: 50 } }],
      },
    ],
    archivedResponses: [
      { problemId: "math-a", outputTokens: 300 },
      { problemId: "math-c", outputTokens: 400 },
    ],
  });
  assert.deepEqual(
    [...totals.entries()],
    [["math-a", 500], ["math-b", 50], ["math-c", 400]],
  );
});

test("research run totals include ledger runs and preserved prior runs", () => {
  assert.equal(researchRunCount({
    runs: [{ claimTs: 1 }, { claimTs: 2 }],
    archivedResponses: [{ claimTs: 3 }, { claimTs: 4 }, { claimTs: 5 }],
  }), 5);
});

test("a problem defaults to the only direction with research output", () => {
  assert.equal(initialResearchDirection([]), "prove");
  assert.equal(
    initialResearchDirection([{ direction: "disprove" }]),
    "disprove",
  );
  assert.equal(
    initialResearchDirection([{ direction: "prove" }]),
    "prove",
  );
  assert.equal(
    initialResearchDirection([
      { direction: "prove" },
      { direction: "disprove" },
    ]),
    "prove",
  );
});

test("a failed poll leaves the previous render intact", async () => {
  const previous = Object.freeze({ publicationId: "last-good" });
  let rendered = previous;
  let renderCount = 0;
  const failed = await pollKeepingLastGood(
    previous,
    async () => {
      throw new Error("temporary publisher failure");
    },
    (next) => {
      renderCount += 1;
      rendered = next;
    },
  );
  assert.equal(failed.updated, false);
  assert.equal(failed.value, previous);
  assert.equal(rendered, previous);
  assert.equal(renderCount, 0);

  const next = Object.freeze({ publicationId: "next-good" });
  const succeeded = await pollKeepingLastGood(
    failed.value,
    async () => next,
    (value) => {
      renderCount += 1;
      rendered = value;
    },
  );
  assert.equal(succeeded.updated, true);
  assert.equal(succeeded.value, next);
  assert.equal(rendered, next);
  assert.equal(renderCount, 1);
});

test("initial public-data loading retries transient failures", async () => {
  let attempts = 0;
  const waits = [];
  const result = await loadWithRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("temporary public-data failure");
      return "loaded";
    },
    {
      attempts: 3,
      wait: async (attempt) => waits.push(attempt),
    },
  );
  assert.equal(result, "loaded");
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [1, 2]);
});

test("funding and review labels preserve the public money semantics", () => {
  assert.equal(formatMoney(5_000), "$50");
  assert.equal(formatMoney(5_020), "$50.20");
  assert.equal(formatMoney(5_025), "$50.25");
  assert.equal(processedPoolBalanceCents([{
    pools: [
      {
        balanceCents: 19_390,
        unprocessedCents: 19_390,
      },
      {
        balanceCents: 5_000,
        unprocessedCents: 0,
      },
    ],
  }]), 5_000);
  assert.deepEqual(statusPresentation("PendingReview"), {
    label: "Claimed solved · under review",
    className: "status-review",
  });
  assert.deepEqual(processingPresentation("received"), {
    label: "Unprocessed",
    className: "badge-received",
  });
  assert.deepEqual(processingPresentation("processed"), {
    label: "Processed · final",
    className: "badge-processed",
  });
});

test("verified acknowledgments use the last eligible winning-pool contributor", () => {
  const claimTs = Date.parse("2026-08-10T00:00:00.000Z");
  const solved = problem({
    problemId: "math-win",
    title: "Winning claim",
    reviewedResults: [{
      problemId: "math-win",
      direction: "prove",
      claimTs,
      outcome: "unconditional",
    }],
  });
  const ledger = {
    donations: [
      winningDonation("early", "Ada", "2026-08-01T00:00:00.000Z", "prove"),
      winningDonation("wrong-direction", "Grace", "2026-08-09T23:58:00.000Z", "disprove"),
      winningDonation("winner", "Emmy", "2026-08-09T23:59:00.000Z", "prove"),
      winningDonation("after", "Sofia", "2026-08-11T00:00:00.000Z", "prove"),
      {
        ...winningDonation("refunded", "Noether", "2026-08-09T23:59:30.000Z", "prove"),
        processingStatus: "refunded",
      },
    ],
  };
  assert.deepEqual(donorAcknowledgement(solved, ledger), {
    donorTag: "Emmy",
    donationId: "winner",
  });
});

test("fully refunded contributions stay out of public contribution lists", () => {
  const received = donation(
    "txn-received",
    "Ada",
    "2026-08-01T00:00:00.000Z",
    "prove",
  );
  const refunded = {
    ...donation(
      "txn-refunded",
      "Grace",
      "2026-08-02T00:00:00.000Z",
      "disprove",
    ),
    processingStatus: "refunded",
  };
  assert.deepEqual(visibleContributions([received, refunded]), [received]);
});

test("net contributions subtract completed refunds", () => {
  assert.equal(
    netContributionCents(
      { donationNetCents: 19_390 },
      { completedRefundCents: 19_390 },
    ),
    0,
  );
  assert.equal(
    netContributionCents(
      { donationNetCents: 20_000 },
      { completedRefundCents: 5_000 },
    ),
    15_000,
  );
});

test("per-pool contributions subtract completed refunds", () => {
  const poolDonation = {
    destination: {
      kind: "pool",
      problemId: "cs-009",
      direction: "disprove",
    },
    netCents: 19_390,
    refundedCents: 19_390,
  };
  assert.equal(
    netPoolContributionCents([poolDonation], {
      problemId: "cs-009",
      direction: "disprove",
    }),
    0,
  );
  assert.equal(
    netPoolContributionCents([
      { ...poolDonation, netCents: 20_000, refundedCents: 5_000 },
    ], {
      problemId: "cs-009",
      direction: "disprove",
    }),
    15_000,
  );
});

test("processed contributions remain in the problem's received total", () => {
  const donations = [
    {
      destination: {
        kind: "pool",
        problemId: "cs-007",
        direction: "disprove",
      },
      netCents: 323_701,
      refundedCents: 0,
      processingStatus: "processed",
    },
    {
      destination: {
        kind: "pool",
        problemId: "cs-008",
        direction: "disprove",
      },
      netCents: 323_604,
      refundedCents: 0,
      processingStatus: "received",
    },
    {
      destination: {
        kind: "pool",
        problemId: "cs-007",
        direction: "prove",
      },
      netCents: 10_000,
      refundedCents: 0,
      waterlineExcludedCents: 10_000,
      processingStatus: "reversed",
    },
  ];
  assert.equal(netProblemContributionCents(donations, "cs-007"), 323_701);
});

test("ledger search and object links expose public references without unsafe paths", () => {
  const titles = new Map([["math-001", "A sample conjecture"]]);
  const entry = donation(
    "txn-public-123",
    "Ada Lovelace",
    "2026-08-01T00:00:00.000Z",
    "prove",
  );
  entry.orderId = "order-recurring-7";
  assert.match(searchableDonation(entry, titles), /ada lovelace/);
  assert.match(searchableDonation(entry, titles), /txn-public-123/);
  assert.match(searchableDonation(entry, titles), /order-recurring-7/);
  assert.equal(destinationLabel(entry, titles), "A sample conjecture · Proof");
  assert.equal(
    publicObjectUrl(
      "https://public.example/",
      "public/publications/abc/ledger.json",
    ),
    "https://public.example/public/publications/abc/ledger.json",
  );
  assert.throws(
    () => publicObjectUrl("https://public.example/", "../secret"),
    /Invalid public object key/,
  );
  assert.throws(
    () => publicObjectUrl("http://public.example/", "public/state.json"),
    /must use HTTPS/,
  );
});

test("state and ledger generations must agree before rendering", () => {
  const state = {
    schemaVersion: 1,
    publicationId: "a".repeat(64),
    catalogRevision: 4,
    problems: [],
  };
  const ledger = {
    schemaVersion: 1,
    publicationId: "a".repeat(64),
    catalogRevision: 4,
    donations: [],
  };
  assert.equal(assertPublicDocumentPair(state, ledger), true);
  assert.throws(
    () => assertPublicDocumentPair(state, {
      ...ledger,
      publicationId: "b".repeat(64),
    }),
    /different generations/,
  );
  assert.throws(
    () => assertPublicDocumentPair(state, {
      ...ledger,
      catalogRevision: 5,
    }),
    /catalog revisions disagree/,
  );
});

function problem(overrides) {
  return {
    problemId: "math-001",
    slug: "sample",
    title: "Sample",
    domain: "mathematics",
    statement: "Every sample has the stated property.",
    status: "Open",
    totalPoolBalanceCents: 0,
    directions: {
      prove: "Prove the statement.",
      disprove: "Disprove the statement.",
    },
    pools: [],
    reviewedResults: [],
    ...overrides,
  };
}

function donation(id, donorTag, creditedAt, direction) {
  return {
    dedupId: id,
    donorTag,
    creditedAt,
    grossCents: 5_000,
    netCents: 4_800,
    processingStatus: "processed",
    destination: {
      kind: "pool",
      problemId: "math-001",
      direction,
    },
  };
}

function winningDonation(id, donorTag, creditedAt, direction) {
  return {
    ...donation(id, donorTag, creditedAt, direction),
    destination: {
      kind: "pool",
      problemId: "math-win",
      direction,
    },
  };
}
