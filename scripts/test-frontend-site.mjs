#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertFableArchive,
  assertPublicDocumentPair,
  destinationLabel,
  donorAcknowledgement,
  filterAndSortProblems,
  formatDomain,
  formatMoney,
  generatedOutputTokensByProblem,
  initialResearchDirection,
  pollKeepingLastGood,
  processingPresentation,
  publicObjectUrl,
  researchRunCount,
  searchableDonation,
  statusPresentation,
} from "../assets/site-data.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the public site is catalog-driven, accessible, and ledger-verifying", async () => {
  const [
    indexHtml,
    ledgerHtml,
    siteScript,
    siteStyles,
    headers,
    readme,
  ] = await Promise.all([
    readFile(path.join(rootDir, "index.html"), "utf8"),
    readFile(path.join(rootDir, "ledger.html"), "utf8"),
    readFile(path.join(rootDir, "assets", "site.js"), "utf8"),
    readFile(path.join(rootDir, "assets", "site.css"), "utf8"),
    readFile(path.join(rootDir, "_headers"), "utf8"),
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
    assert.match(html, /href="assets\/site\.css(?:\?v=[a-f0-9]+)?"/);
    assert.match(html, /<script type="module" src="assets\/site\.js(?:\?v=[a-f0-9]+)?"><\/script>/);
    assert.doesNotMatch(html, /Operated by Lipschitz Strategies LLC\./);
    assert.doesNotMatch(html, /<strong>Explore<\/strong>/);
    assert.match(
      html,
      /<img class="wordmark-mark" src="apple-touch-icon\.png" alt="" aria-hidden="true">/,
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
  assert.match(siteStyles, /\.ledger-summary\s*\{\s*padding: 64px 0 36px;/);
  assert.match(siteStyles, /\.ledger-explorer\s*\{\s*padding: 36px 0 96px;/);
  assert.match(
    siteStyles,
    /\.ledger-explorer \.section-heading\s*\{\s*margin-bottom: 18px;/,
  );
  assert.match(siteScript, /metrics\.map\(compactMetric\)/);
  assert.doesNotMatch(indexHtml, /class="problem-dialog"/);
  assert.match(indexHtml, /class="problem-row-shell problem-row-loading"/);
  assert.match(siteScript, /function problemRow\(problem, ledger, fableResponse\)/);
  assert.match(siteScript, /"aria-expanded": "false"/);
  assert.match(siteScript, /className: "problem-row-expanded"/);
  assert.doesNotMatch(siteScript, /problemDialog|showModal\(\).*problem/i);
  assert.match(siteScript, /function formattedMathText\(value\)/);
  assert.match(siteScript, /function directionPrompt\(problem, fableResponse\)/);
  assert.match(siteScript, /className: "direction-textbox"/);
  assert.match(siteScript, /className: "direction-instruction"/);
  assert.match(siteScript, /problem\.directions\[direction\]/);
  assert.match(siteScript, /renderPaginatedOutput\(/);
  assert.match(siteScript, /OUTPUT_POLL_INTERVAL_MS/);
  assert.match(siteScript, /PUBLIC_STATE_POLL_INTERVAL_MS/);
  assert.match(siteScript, /indiemath:output-pane/);
  assert.match(siteScript, /pollKeepingLastGood\(/);
  assert.match(siteScript, /currentResponseKey\(/);
  assert.match(siteScript, /paginateResearchText\(text, pageSize = 6_000\)/);
  assert.match(siteScript, /Page \$\{pageIndex \+ 1\} of \$\{pages\.length\}/);
  assert.match(
    siteScript,
    /pages\.length > 3\s*\? \[first, previous, position, next, last\]/,
  );
  assert.match(
    siteScript,
    /pool\.cumulativeDonationsCents \+ pool\.unprocessedCents/,
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
  assert.match(ledgerHtml, /assets\/site\.js\?v=[a-f0-9]+/);
  assert.doesNotMatch(ledgerHtml, /Public accounting|ledger-hero/);
  assert.doesNotMatch(
    ledgerHtml,
    /Every catalog entry links straight to its own proof and disproof contribution flow/,
  );
  assert.match(
    ledgerHtml,
    /<section class="ledger-summary"[\s\S]*View on Open Collective/,
  );
  assert.match(
    ledgerHtml,
    /<a class="ledger-source-link" href="https:\/\/opencollective\.com\/indiemath" target="_blank" rel="noopener noreferrer">View on Open Collective/,
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
  assert.match(siteScript, /seed\/fable-math\/manifest\.json/);
  assert.doesNotMatch(
    siteScript,
    /archivePanel|Initial Fable disproof response|Read archived disproof response|seed\/fable-math\/\$\{response\.solutionKey\}/,
  );
  assert.match(siteScript, /Research output/);
  assert.match(
    siteScript,
    /url: `seed\/fable-math\/\$\{fableResponse\.contextArtifact\}`/,
  );
  assert.match(
    siteScript,
    /href: `index\.html#problem-\$\{run\.problemId\}-\$\{run\.direction\}`/,
  );
  assert.doesNotMatch(siteScript, /"FableMath"|Catalog source:/);
  assert.match(siteScript, /renderLedgerPage\(publicState, publicLedger, fableArchive\)/);
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
  assert.match(siteScript, /ledger\.accounting\.donationNetCents/);
  assert.match(siteScript, /ledger\.accounting\.settledSpendCents/);
  assert.match(siteScript, /ledger\.accounting\.poolBalanceCents/);
  assert.match(siteScript, /After Open Collective\/Stripe processing fees/);
  assert.match(siteScript, /Takes 1–2 business days/);
  assert.doesNotMatch(siteScript, /sum\(ledger\.donations|sum\(ledger\.runs/);
  assert.doesNotMatch(siteScript, /\.innerHTML\s*=/);
  assert.match(siteStyles, /@media \(max-width: 680px\)/);
  assert.match(siteStyles, /prefers-reduced-motion: reduce/);
  assert.match(headers, /Content-Security-Policy:/);
  assert.match(headers, /connect-src 'self' https:\/\/pub-[a-f0-9]+\.r2\.dev/);
  assert.match(headers, /frame-ancestors 'self'/);
  assert.match(headers, /X-Frame-Options: SAMEORIGIN/);
  assert.doesNotMatch(headers, /frame-ancestors 'none'|X-Frame-Options: DENY/);
  assert.match(headers, /X-Content-Type-Options: nosniff/);
  assert.match(readme, /website is intentionally catalog-driven/i);
  assert.doesNotMatch(readme, /59 problems|NP versus P\/poly|cs-001/);
});

test("the Fable seed contains only real responses in production solution form", async () => {
  const archiveDir = path.join(rootDir, "seed", "fable-math");
  const [manifestText, catalogText] = await Promise.all([
    readFile(path.join(archiveDir, "manifest.json"), "utf8"),
    readFile(path.join(rootDir, "problems", "catalog.json"), "utf8"),
  ]);
  const archive = JSON.parse(manifestText);
  const catalog = JSON.parse(catalogText);
  const problems = catalog.problems.map((problem) => ({
    ...problem,
    problemId: problem.id,
  }));

  assert.equal(assertFableArchive(archive, problems), true);
  assert.ok(archive.responses.length > 0);
  assert.ok(archive.responses.length < 50);
  assert.ok(archive.responses.every((response) => response.responseAvailable === true));
  assert.equal(
    researchRunCount({ runs: [], archivedResponses: archive.responses }),
    archive.responses.length,
  );

  for (const response of archive.responses) {
    const body = await readFile(path.join(archiveDir, response.solutionKey), "utf8");
    const context = await readFile(
      path.join(archiveDir, response.contextArtifact),
      "utf8",
    );
    assert.ok(body.length > 0);
    assert.match(context, /^# Carry-forward research context/);
    assert.match(context, /## Research progress/);
    assert.match(context, /## Final response/);
    assert.equal(
      response.contextKey,
      `transcripts/${response.problemId}/disprove/compacted.md`,
    );
    assert.ok(Number.isSafeInteger(response.outputTokens));
    assert.ok(response.outputTokens > 0);
    assert.equal(
      createHash("sha256").update(body).digest("hex"),
      response.responseSha256,
    );
    assert.equal(
      createHash("sha256").update(context).digest("hex"),
      response.contextSha256,
    );
  }

  const solutionRoot = path.join(archiveDir, "solutions");
  const artifacts = (await readdir(solutionRoot, { recursive: true }))
    .filter((entry) => entry.endsWith(".md"));
  assert.equal(artifacts.length, archive.responses.length);
  const contextRoot = path.join(archiveDir, "contexts");
  const contexts = (await readdir(contextRoot, { recursive: true }))
    .filter((entry) => entry.endsWith("compacted.md"));
  assert.equal(contexts.length, archive.responses.length);
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

test("generated output totals include IndieMath runs and archived FableMath work", () => {
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

test("research run totals include ledger runs and archived FableMath runs", () => {
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

test("funding and review labels preserve the public money semantics", () => {
  assert.equal(formatMoney(5_000), "$50");
  assert.equal(formatMoney(5_025), "$50.25");
  assert.deepEqual(statusPresentation("PendingReview"), {
    label: "Claimed solved · under review",
    className: "status-review",
  });
  assert.deepEqual(processingPresentation("received"), {
    label: "Received · refundable",
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
