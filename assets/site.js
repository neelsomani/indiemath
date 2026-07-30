import {
  assertPublicDocumentPair,
  destinationLabel,
  directionLabel,
  displayDestination,
  donorAcknowledgement,
  filterAndSortProblems,
  formatDate,
  formatDateTime,
  formatDomain,
  formatMoney,
  generatedOutputTokensByProblem,
  initialResearchDirection,
  loadWithRetry,
  netContributionCents,
  netPoolContributionCents,
  netProblemContributionCents,
  normalizeSearch,
  pollKeepingLastGood,
  priorResearchForCurrentCatalog,
  processedPoolBalanceCents,
  processingPresentation,
  publicObjectUrl,
  researchRunCount,
  searchableDonation,
  searchableReview,
  searchableRun,
  statusPresentation,
  visibleContributions,
} from "./site-data.js?v=1dd95c37";

const PAGE_SIZE = 10;
const OUTPUT_POLL_INTERVAL_MS = 5_000;
const PUBLIC_STATE_POLL_INTERVAL_MS = 30_000;
const researchPaginationState = new WeakMap();
const page = document.body.dataset.page;
const publicDataBaseUrl = document
  .querySelector('meta[name="indiemath-public-data"]')
  ?.content;

let publicState;
let publicLedger;
let priorResearchArchive;

initMobileNavigation();
initProblemFilterDisclosure();
initTermsDialog();
void loadAndRender();

function initMobileNavigation() {
  const button = document.querySelector(".nav-menu-button");
  const navigation = document.querySelector("#primary-navigation");
  if (!button || !navigation) return;
  const close = () => {
    navigation.dataset.mobileOpen = "false";
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", "Open navigation");
  };
  const open = () => {
    navigation.dataset.mobileOpen = "true";
    button.setAttribute("aria-expanded", "true");
    button.setAttribute("aria-label", "Close navigation");
  };
  button.addEventListener("click", () => {
    if (button.getAttribute("aria-expanded") === "true") close();
    else open();
  });
  navigation.addEventListener("click", (event) => {
    if (event.target.closest("a")) close();
  });
  document.addEventListener("click", (event) => {
    if (
      button.getAttribute("aria-expanded") === "true"
      && !event.target.closest(".site-header")
    ) {
      close();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      close();
      button.focus();
    }
  });
  const desktop = matchMedia("(min-width: 1001px)");
  desktop.addEventListener("change", (event) => {
    if (event.matches) close();
  });
}

function initProblemFilterDisclosure() {
  const disclosure = document.querySelector("#problem-filter-disclosure");
  if (!disclosure) return;
  if (matchMedia("(max-width: 680px)").matches) disclosure.open = false;
}

async function loadAndRender() {
  try {
    ({
      state: publicState,
      ledger: publicLedger,
      archive: priorResearchArchive,
    } = await loadWithRetry(loadPublicDocuments));
    if (page === "ledger") {
      renderLedgerPage(publicState, publicLedger, priorResearchArchive);
    } else {
      renderProblemsPage(publicState, publicLedger, priorResearchArchive);
    }
  } catch (error) {
    console.error("IndieMath public-data load failed.", error);
    renderLoadError(error);
  }
}

async function loadPublicDocuments() {
  if (!publicDataBaseUrl) throw new Error("Public data URL is not configured.");
  const [{ state, ledger }, archiveResponse] = await Promise.all([
    loadPublicStatePair(),
    fetch(
      publicObjectUrl(
        publicDataBaseUrl,
        "public/prior-research/manifest.json",
      ),
      { cache: "no-store" },
    ),
  ]);
  if (!archiveResponse.ok) {
    throw new Error(`Research manifest request failed with HTTP ${archiveResponse.status}.`);
  }
  const archive = priorResearchForCurrentCatalog(
    await archiveResponse.json(),
    state.problems,
  );
  return { state, ledger, archive };
}

async function loadPublicStatePair({ signal } = {}) {
  if (!publicDataBaseUrl) throw new Error("Public data URL is not configured.");
  const stateResponse = await fetch(
    publicObjectUrl(publicDataBaseUrl, "public/state.json"),
    { cache: "no-store", signal },
  );
  if (!stateResponse.ok) {
    throw new Error(`State request failed with HTTP ${stateResponse.status}.`);
  }
  const state = await stateResponse.json();
  const ledgerResponse = await fetch(
    publicObjectUrl(publicDataBaseUrl, state.ledgerKey),
    { cache: "no-store", signal },
  );
  if (!ledgerResponse.ok) {
    throw new Error(`Ledger request failed with HTTP ${ledgerResponse.status}.`);
  }
  const ledgerText = await ledgerResponse.text();
  const digest = await sha256(ledgerText);
  if (digest !== state.ledgerSha256) {
    throw new Error("The ledger digest does not match the committed state.");
  }
  const ledger = JSON.parse(ledgerText);
  assertPublicDocumentPair(state, ledger);
  return { state, ledger };
}

function renderProblemsPage(state, ledger, archive) {
  renderFreshness(state);
  renderHomepageMetrics(state, ledger, archive);
  renderTreasuryNotice(state);
  initProblemExplorer(state, ledger, archive);
}

function renderHomepageMetrics(state, ledger, archive) {
  const openProblems = state.problems.filter((problem) => problem.status !== "Solved").length;
  const netContributions = netContributionCents(
    ledger.accounting,
    ledger.treasury,
  );
  const metrics = [
    {
      label: "Received",
      value: formatMoney(netContributions),
      emphasis: true,
    },
    {
      label: "Available run funds",
      value: formatMoney(state.treasury.spendableCapacityCents),
    },
    {
      label: "Open problems",
      value: String(openProblems),
    },
    {
      label: "Research runs",
      value: String(researchRunCount({
        runs: ledger.runs,
        archivedResponses: archive.responses,
      })),
    },
  ];
  const container = document.querySelector("#metric-grid");
  container.replaceChildren(...metrics.map(compactMetric));
  container.ariaBusy = "false";
}

function renderTreasuryNotice(state) {
  const notice = document.querySelector("#treasury-notice");
  if (state.runControl?.reason === "anthropic-monthly-plan-limit") {
    notice.hidden = false;
    notice.textContent = "Runs paused - Anthropic monthly plan limit reached.";
    return;
  }
  const treasury = state.treasury;
  if (!treasury.runsPausedPendingSettlement) {
    notice.hidden = true;
    return;
  }
  notice.hidden = false;
  if (state.unprocessedCents > 0) {
    notice.textContent = "No processed funds available - runs paused.";
    return;
  }
  if (treasury.settledButUnfundedCents > 0) {
    notice.textContent = `${formatMoney(treasury.settledButUnfundedCents)} settled · awaiting compute staging.`;
    return;
  }
  notice.textContent = "Runs paused";
}

function initProblemExplorer(state, ledger, archive) {
  const search = document.querySelector("#problem-search");
  const domain = document.querySelector("#domain-filter");
  const status = document.querySelector("#status-filter");
  const sort = document.querySelector("#sort-order");
  const clear = document.querySelector("#clear-filters");
  const loadMore = document.querySelector("#load-more");
  const loadMoreWrap = document.querySelector("#load-more-wrap");
  const deepLinkedOutput = location.hash.match(
    /^#problem-([a-z0-9-]+)-(prove|disprove)$/,
  );
  const deepLinkedProblem = deepLinkedOutput?.[1] ?? location.hash.match(
    /^#problem-([a-z0-9-]+)$/,
  )?.[1];
  const deepLinkedDirection = deepLinkedOutput?.[2];
  let visibleLimit = deepLinkedProblem ? state.problems.length : PAGE_SIZE;
  const generatedOutputTokens = generatedOutputTokensByProblem({
    runs: ledger.runs,
    archivedResponses: archive.responses,
  });
  const priorResearchResponses = new Map(
    archive.responses.map((response) => [response.problemId, response]),
  );

  const domains = [...new Set(state.problems.map((problem) => problem.domain))]
    .sort((left, right) => formatDomain(left).localeCompare(formatDomain(right)));
  domain.append(...domains.map((value) => option(value, formatDomain(value))));

  const render = () => {
    const filters = {
      query: search.value,
      domain: domain.value,
      status: status.value,
      sort: sort.value,
      generatedOutputTokens,
    };
    const filtered = filterAndSortProblems(state.problems, filters);
    const visible = filtered.slice(0, visibleLimit);
    const list = document.querySelector("#problem-list");
    closeOutputPanesWithin(list);
    list.replaceChildren(...visible.map((problem) => (
      problemRow(
        problem,
        ledger,
        priorResearchResponses.get(problem.problemId),
      )
    )));
    list.ariaBusy = "false";
    document.querySelector("#problem-count").textContent = `${filtered.length} ${filtered.length === 1 ? "problem" : "problems"} shown`;
    const hasFilters = Boolean(filters.query.trim())
      || filters.domain !== "all"
      || filters.status !== "all"
      || filters.sort !== "publisher";
    clear.hidden = !hasFilters;
    loadMoreWrap.hidden = visible.length >= filtered.length;
    if (filtered.length === 0) {
      list.replaceChildren(emptyMessage(
        "No problems match those filters.",
        "Try a broader term or clear the filters.",
      ));
    }
  };

  const resetLimitAndRender = () => {
    visibleLimit = PAGE_SIZE;
    render();
  };
  search.addEventListener("input", resetLimitAndRender);
  domain.addEventListener("change", resetLimitAndRender);
  status.addEventListener("change", resetLimitAndRender);
  sort.addEventListener("change", resetLimitAndRender);
  clear.addEventListener("click", () => {
    search.value = "";
    domain.value = "all";
    status.value = "all";
    sort.value = "publisher";
    resetLimitAndRender();
    search.focus();
  });
  loadMore.addEventListener("click", () => {
    visibleLimit += PAGE_SIZE;
    render();
  });
  render();

  if (deepLinkedProblem) {
    requestAnimationFrame(() => {
      const shell = document.querySelector(
        `#problem-${CSS.escape(deepLinkedProblem)}`,
      );
      shell?.querySelector(".problem-row")?.click();
      if (deepLinkedDirection) {
        shell?.querySelector(
          `[data-direction="${deepLinkedDirection}"]`,
        )?.click();
      }
      shell?.scrollIntoView({ block: "nearest" });
    });
  }
}

function closeOutputPanesWithin(container) {
  for (const control of container.querySelectorAll(".direction-control")) {
    control.dispatchEvent(new CustomEvent("indiemath:output-pane", {
      detail: { open: false },
    }));
  }
}

function problemRow(problem, ledger, priorResearchResponse) {
  const status = statusPresentation(problem.status);
  const receivedCents = netProblemContributionCents(
    ledger.donations,
    problem.problemId,
  );
  const runningPills = (problem.liveClaims ?? []).map((claim) => (
    element("span", {
      className: "status-pill status-running",
      text: `${directionLabel(claim.direction)} running`,
    })
  ));
  const row = element("article", {
    className: "problem-row-shell",
    attrs: {
      id: `problem-${problem.problemId}`,
      "data-status": problem.status,
    },
  });
  const button = element("button", {
    className: "problem-row",
    attrs: {
      type: "button",
      "aria-expanded": "false",
      "aria-controls": `problem-details-${problem.problemId}`,
      "aria-label": `Show ${problem.title}`,
    },
  }, [
    element("span", { className: "problem-row-main" }, [
      element("span", { className: "problem-row-meta" }, [
        element("span", { className: `status-pill ${status.className}`, text: status.label }),
        ...runningPills,
        element("span", { className: "domain-pill", text: formatDomain(problem.domain) }),
        element("span", { className: "problem-id", text: problem.problemId }),
      ]),
      element("strong", { className: "problem-row-title", text: problem.title }),
    ]),
    element("span", { className: "problem-row-funding" }, [
      element("strong", { text: formatMoney(receivedCents) }),
      element("small", { text: "received" }),
    ]),
    element("span", {
      className: "problem-row-arrow",
      text: "⌄",
      attrs: { "aria-hidden": "true" },
    }),
  ]);
  const expanded = element("div", {
    className: "problem-row-expanded",
    attrs: {
      id: `problem-details-${problem.problemId}`,
      hidden: "",
    },
  }, [
    problemDetails(problem, ledger, priorResearchResponse),
  ]);
  button.addEventListener("click", () => {
    const opening = expanded.hidden;
    if (opening) {
      for (const other of row.parentElement.querySelectorAll(
        ".problem-row-shell-expanded",
      )) {
        if (other !== row) other.querySelector(":scope > .problem-row")?.click();
      }
    }
    expanded.hidden = !opening;
    button.setAttribute("aria-expanded", String(opening));
    button.setAttribute(
      "aria-label",
      `${opening ? "Hide" : "Show"} ${problem.title}`,
    );
    row.classList.toggle("problem-row-shell-expanded", opening);
    for (const control of expanded.querySelectorAll(".direction-control")) {
      control.dispatchEvent(new CustomEvent("indiemath:output-pane", {
        detail: { open: opening },
      }));
    }
    if (opening) {
      history.replaceState(null, "", `#problem-${problem.problemId}`);
    } else if (location.hash === `#problem-${problem.problemId}`) {
      history.replaceState(null, "", `${location.pathname}${location.search}`);
    }
  });
  row.append(button, expanded);
  return row;
}

function problemDetails(problem, ledger, priorResearchResponse) {
  const details = element("div", { className: "problem-detail" });
  details.append(
    element("p", { className: "problem-statement" }, [
      formattedMathText(problem.statement),
    ]),
  );
  details.append(
    directionPrompt(problem, ledger, priorResearchResponse),
    contributionActions(problem, ledger),
  );

  const review = reviewPanel(problem, ledger);
  if (review) details.append(review);
  const contributions = recentContributionsPanel(problem);
  if (contributions) details.append(contributions);
  return details;
}

function directionPrompt(problem, ledger, priorResearchResponse) {
  const prompt = element("div", {
    className: "direction-textbox",
    attrs: {
      role: "textbox",
      "aria-readonly": "true",
      "aria-live": "polite",
    },
  });
  const toggles = element("div", {
    className: "direction-toggle",
    attrs: { role: "group", "aria-label": "Research direction" },
  });
  const control = element("section", { className: "direction-control" }, [
    toggles,
    prompt,
  ]);
  const importedSources = researchOutputSources(
    { ...problem, liveClaims: [] },
    { ...ledger, runs: [] },
    priorResearchResponse,
  );
  let outputSources = researchOutputSources(problem, ledger, priorResearchResponse);
  const initialDirection = initialResearchDirection(outputSources);
  const outputCache = new Map();
  const outputContainers = new Map();
  const activeRequests = new Set();
  let selectedDirection = initialDirection;
  let paneOpen = false;
  let pollingSession = 0;
  let outputTimer;
  let stateTimer;
  let lastGoodStatePair = { state: publicState, ledger: publicLedger };

  const abortActiveRequests = () => {
    for (const controller of activeRequests) controller.abort();
    activeRequests.clear();
  };
  const withAbortSignal = async (load) => {
    const controller = new AbortController();
    activeRequests.add(controller);
    try {
      return await load(controller.signal);
    } finally {
      activeRequests.delete(controller);
    }
  };
  const sourceIsCurrent = (source) => outputSources.some((candidate) => (
    candidate.id === source.id && candidate.url === source.url
  ));
  const requestOutput = async (source, signal) => {
    const requestText = async (url) => {
      const response = await fetch(url, { cache: "no-store", signal });
      if (!response.ok) {
        throw new Error(
          `Research output request failed with HTTP ${response.status}.`,
        );
      }
      return response.text();
    };
    try {
      return await requestText(source.url);
    } catch (error) {
      if (
        signal.aborted
        || !source.fallbackUrl
        || outputCache.has(source.id)
      ) {
        throw error;
      }
      return requestText(source.fallbackUrl);
    }
  };
  const outputSection = (source) => {
    const output = element("section", {
      className: "inline-research-output",
      attrs: { "data-output-source": source.id },
    }, [
      element("strong", { text: "Research output" }),
      element("pre", { text: "Loading output…" }),
    ]);
    outputContainers.set(source.id, output);
    const cached = outputCache.get(source.id);
    if (cached !== undefined) renderPaginatedOutput(output, cached);
    return output;
  };
  const renderDirection = () => {
    const direction = selectedDirection;
    outputContainers.clear();
    prompt.replaceChildren(element("div", {
      className: "direction-instruction",
    }, [
      formattedMathText(problem.directions[direction]),
    ]));
    prompt.dataset.direction = selectedDirection;
    for (const source of outputSources.filter((item) => (
      item.direction === selectedDirection
    ))) {
      prompt.append(outputSection(source));
    }
    for (const toggle of toggles.querySelectorAll("button")) {
      const selected = toggle.dataset.direction === selectedDirection;
      toggle.setAttribute("aria-pressed", String(selected));
    }
  };
  const refreshOutput = async (source, session) => {
    const previous = outputCache.get(source.id);
    const result = await pollKeepingLastGood(
      previous,
      () => withAbortSignal((signal) => requestOutput(source, signal))
        .then((text) => source.imported ? importedResearchText(text) : text),
      (text) => {
        if (
          paneOpen
          && pollingSession === session
          && selectedDirection === source.direction
          && sourceIsCurrent(source)
        ) {
          outputCache.set(source.id, text);
          const output = outputContainers.get(source.id);
          if (output?.isConnected) renderPaginatedOutput(output, text);
        }
      },
    );
    if (
      !result.updated
      && previous === undefined
      && paneOpen
      && pollingSession === session
      && selectedDirection === source.direction
      && sourceIsCurrent(source)
    ) {
      const output = outputContainers.get(source.id);
      if (output?.isConnected) {
        output.querySelector("pre").textContent =
          "Research output is temporarily unavailable.";
      }
    }
  };
  const refreshOutputs = async (session) => {
    if (!paneOpen || pollingSession !== session || !control.isConnected) return;
    const sources = outputSources.filter((source) => (
      source.direction === selectedDirection
      && (!source.imported || !outputCache.has(source.id))
    ));
    await Promise.all(sources.map((source) => refreshOutput(source, session)));
    if (paneOpen && pollingSession === session && control.isConnected) {
      outputTimer = setTimeout(
        () => void refreshOutputs(session),
        OUTPUT_POLL_INTERVAL_MS,
      );
    }
  };
  const refreshSources = async (session) => {
    if (!paneOpen || pollingSession !== session || !control.isConnected) return;
    const result = await pollKeepingLastGood(
      lastGoodStatePair,
      () => withAbortSignal((signal) => loadPublicStatePair({ signal })),
      ({ state, ledger: freshLedger }) => {
        if (!paneOpen || pollingSession !== session) return;
        const freshProblem = state.problems.find((candidate) => (
          candidate.problemId === problem.problemId
        ));
        if (!freshProblem) return;
        const freshLiveSources = researchOutputSources(freshProblem, freshLedger);
        const freshDirections = new Set(
          freshLiveSources.map((source) => source.direction),
        );
        const lastVisibleLiveSources = outputSources.filter((source) => (
          !source.imported && !freshDirections.has(source.direction)
        ));
        const nextSources = [
          ...freshLiveSources,
          ...lastVisibleLiveSources,
          ...importedSources,
        ];
        if (outputSourceSignature(nextSources) !== outputSourceSignature(outputSources)) {
          outputSources = nextSources;
          renderDirection();
        }
      },
    );
    lastGoodStatePair = result.value;
    if (paneOpen && pollingSession === session && control.isConnected) {
      stateTimer = setTimeout(
        () => void refreshSources(session),
        PUBLIC_STATE_POLL_INTERVAL_MS,
      );
    }
  };
  const restartPolling = () => {
    pollingSession += 1;
    clearTimeout(outputTimer);
    clearTimeout(stateTimer);
    abortActiveRequests();
    if (!paneOpen || !control.isConnected) return;
    const session = pollingSession;
    void refreshOutputs(session);
    void refreshSources(session);
  };
  const selectDirection = (direction) => {
    if (selectedDirection === direction) return;
    selectedDirection = direction;
    renderDirection();
    if (paneOpen) restartPolling();
  };
  for (const direction of ["prove", "disprove"]) {
    const toggle = element("button", {
      text: directionLabel(direction),
      attrs: {
        type: "button",
        "data-direction": direction,
        "aria-pressed": String(direction === initialDirection),
      },
    });
    toggle.addEventListener("click", () => selectDirection(direction));
    toggles.append(toggle);
  }
  renderDirection();
  control.addEventListener("indiemath:output-pane", (event) => {
    paneOpen = event.detail?.open === true;
    restartPolling();
  });
  return control;
}

function researchOutputSources(problem, ledger, priorResearchResponse) {
  const sources = [];
  for (const direction of ["prove", "disprove"]) {
    const runs = (ledger?.runs ?? []).filter((run) => (
      run.problemId === problem.problemId && run.direction === direction
    ));
    const live = (problem.liveClaims ?? []).filter((claim) => (
      claim.direction === direction
    ));
    if (runs.length || live.length) {
      const latestRun = [...runs, ...live].sort((left, right) => (
        right.claimTs - left.claimTs
      ))[0];
      const latest = latestRun?.transcriptSegments?.at(-1);
      sources.push({
        id: `session:${problem.problemId}:${direction}`,
        direction,
        url: publicObjectUrl(
          publicDataBaseUrl,
          `transcripts/${problem.problemId}/${direction}/session.md`,
        ),
        fallbackUrl: latest?.humanTranscriptKey
          ? publicObjectUrl(publicDataBaseUrl, latest.humanTranscriptKey)
          : undefined,
      });
    }
  }
  if (priorResearchResponse) {
    sources.push({
      id:
        `imported:${problem.problemId}:${priorResearchResponse.direction}`,
      direction: priorResearchResponse.direction,
      url: publicObjectUrl(
        publicDataBaseUrl,
        priorResearchResponse.contextKey,
      ),
      imported: true,
    });
  }
  return sources;
}

function outputSourceSignature(sources) {
  return sources
    .map((source) => [
      source.id,
      source.url,
      source.fallbackUrl ?? "",
    ].join("|"))
    .sort()
    .join("\n");
}

function importedResearchText(text) {
  const marker = "## Research progress";
  const start = text.indexOf(marker);
  return (start >= 0 ? text.slice(start + marker.length) : text)
    .trim()
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1");
}

function renderPaginatedOutput(container, text) {
  const pages = paginateResearchText(text);
  const output = container.querySelector("pre");
  const previousState = researchPaginationState.get(container);
  if (previousState?.text === text) return;
  const wasOnLastPage = previousState
    && previousState.pageIndex === previousState.pageCount - 1;
  let pageIndex = previousState
    ? wasOnLastPage
      ? pages.length - 1
      : Math.min(previousState.pageIndex, pages.length - 1)
    : 0;
  const previousScrollTop = output.scrollTop;
  const wasScrolledToBottom = (
    output.scrollHeight - output.scrollTop - output.clientHeight < 4
  );
  container.querySelector(".research-output-pagination")?.remove();
  const first = element("button", {
    text: "<<",
    attrs: { type: "button", "aria-label": "First page" },
  });
  const previous = element("button", {
    text: "Previous",
    attrs: { type: "button" },
  });
  const next = element("button", {
    text: "Next",
    attrs: { type: "button" },
  });
  const last = element("button", {
    text: ">>",
    attrs: { type: "button", "aria-label": "Last page" },
  });
  const position = element("span");
  const controls = element("div", {
    className: "research-output-pagination",
  }, pages.length > 3
    ? [first, previous, position, next, last]
    : [previous, position, next]);
  const renderPage = () => {
    output.textContent = pages[pageIndex];
    position.textContent = `Page ${pageIndex + 1} of ${pages.length}`;
    first.disabled = pageIndex === 0;
    previous.disabled = pageIndex === 0;
    next.disabled = pageIndex === pages.length - 1;
    last.disabled = pageIndex === pages.length - 1;
    researchPaginationState.set(container, {
      text,
      pageIndex,
      pageCount: pages.length,
    });
  };
  first.addEventListener("click", () => {
    pageIndex = 0;
    renderPage();
  });
  previous.addEventListener("click", () => {
    pageIndex -= 1;
    renderPage();
  });
  next.addEventListener("click", () => {
    pageIndex += 1;
    renderPage();
  });
  last.addEventListener("click", () => {
    pageIndex = pages.length - 1;
    renderPage();
  });
  if (pages.length > 1) container.append(controls);
  renderPage();
  if (previousState && wasScrolledToBottom && pageIndex === pages.length - 1) {
    output.scrollTop = output.scrollHeight;
  } else if (previousState) {
    output.scrollTop = previousScrollTop;
  }
}

function paginateResearchText(text, pageSize = 6_000) {
  const remainingParagraphs = String(text).trim().split(/\n{2,}/);
  const pages = [];
  let page = "";
  for (const paragraph of remainingParagraphs) {
    if (paragraph.length > pageSize) {
      if (page) {
        pages.push(page);
        page = "";
      }
      for (let offset = 0; offset < paragraph.length; offset += pageSize) {
        pages.push(paragraph.slice(offset, offset + pageSize));
      }
      continue;
    }
    const candidate = page ? `${page}\n\n${paragraph}` : paragraph;
    if (candidate.length > pageSize) {
      pages.push(page);
      page = paragraph;
    } else {
      page = candidate;
    }
  }
  if (page) pages.push(page);
  return pages.length > 0 ? pages : [""];
}

function contributionActions(problem, ledger) {
  const actions = element("div", { className: "compact-contribution-actions" });
  for (const direction of ["prove", "disprove"]) {
    const pool = problem.pools.find((candidate) => (
      candidate.direction === direction
    ));
    if (!pool) continue;
    const contributedCents = netPoolContributionCents(ledger.donations, {
      problemId: problem.problemId,
      direction,
    });
    const spentCents = ledger.runs
      .filter((run) => (
        run.problemId === problem.problemId
        && run.direction === direction
      ))
      .reduce((total, run) => total + run.spentCents, 0);
    const label = `${directionLabel(direction)} · ${formatMoney(contributedCents)} contributed · ${formatMoney(spentCents)} spent`;
    if (problem.status !== "Solved" && isCheckoutUrl(pool.checkoutUrl)) {
      actions.append(element("a", {
        className: "button button-primary",
        text: label,
        attrs: {
          href: checkoutUrlWithDefaults(
            pool.checkoutUrl,
            pool.minimumContributionCents,
          ),
          target: "_blank",
          rel: "noopener noreferrer",
          "aria-label": `${label} — contribute on Open Collective`,
        },
      }));
    } else {
      actions.append(element("span", {
        className: "button button-secondary",
        text: label,
      }));
    }
  }
  return actions;
}

function reviewPanel(problem, ledger) {
  const pending = problem.pendingSolutions ?? [];
  const reviews = problem.reviewedResults ?? [];
  if (pending.length === 0 && reviews.length === 0) return undefined;
  const hasPending = pending.length > 0;
  const panel = element("section", {
    className: `review-panel${hasPending ? " review-panel-warning" : ""}`,
  });
  const title = hasPending
    ? pending.length > 1
      ? "Competing claimed solutions · both unverified"
      : "Claimed solved · under review · unverified"
    : "Published reviews";
  panel.append(element("h4", { text: title }));

  if (pending.length > 1) {
    panel.append(element("p", {
      className: "contribution-disclosure",
      text: "These proof and disproof claims are mutually contradictory. Neither is accepted until review resolves the conflict.",
    }));
  }
  for (const solution of pending) {
    const links = element("span", { className: "artifact-links" });
    if (solution.solutionKey) {
      links.append(artifactLink(solution.solutionKey, "Read claimed solution"));
    }
    panel.append(element("div", { className: "review-row" }, [
      element("p", {
        text: `${directionLabel(solution.direction)} claim · submitted ${formatDate(solution.claimTs)}`,
      }),
      links,
    ]));
  }

  const acknowledgement = donorAcknowledgement(problem, ledger);
  for (const review of [...reviews].reverse()) {
    let copy;
    if (review.outcome === "unconditional") {
      copy = `${directionLabel(review.direction)} verified.`;
      if (acknowledgement) {
        copy += ` Acknowledgment: ${acknowledgement.donorTag} made the last contribution to the winning pool before this claim.`;
      }
    } else if (review.outcome === "conditional") {
      copy = `Resolved under assumption: ${review.assumptionLabel}; unconditional problem remains open.`;
    } else {
      copy = "Rejected after review; the canonical problem remains open.";
    }
    const links = element("span", { className: "artifact-links" });
    if (review.solutionKey) links.append(artifactLink(review.solutionKey, "Solution"));
    if (review.noteKey) links.append(artifactLink(review.noteKey, "Review note"));
    panel.append(element("div", { className: "review-row" }, [
      element("p", { text: copy }),
      links,
    ]));
  }
  return panel;
}

function recentContributionsPanel(problem) {
  const donations = visibleContributions(problem.recentDonations).slice(0, 8);
  if (donations.length === 0) return undefined;
  const panel = element("section", { className: "contributions-panel" });
  panel.append(element("h4", { text: "Recent contributions" }));
  const list = element("ul", { className: "contribution-mini-list" });
  for (const donation of donations) {
    const status = processingPresentation(donation.processingStatus);
    const destination = displayDestination(donation);
    list.append(element("li", {}, [
      element("strong", { text: donation.donorTag }),
      element("span", { text: formatMoney(donation.grossCents) }),
      element("span", { text: directionLabel(destination?.direction) }),
      element("span", {
        className: `badge ${status.className}`,
        text: status.label,
      }),
    ]));
  }
  panel.append(
    list,
    element("a", {
      className: "collective-link",
      text: "View IndieMath on Open Collective",
      attrs: {
        href: "https://opencollective.com/indiemath",
        target: "_blank",
        rel: "noopener noreferrer",
      },
    }),
  );
  return panel;
}

function renderLedgerPage(state, ledger, archive) {
  renderFreshness(state);
  renderLedgerMetrics(state, ledger);
  initLedgerExplorer(state, ledger, archive);
}

function renderLedgerMetrics(state, ledger) {
  const netContributions = netContributionCents(
    ledger.accounting,
    ledger.treasury,
  );
  const approximateRunSpend = ledger.accounting.approximateRunSpendCents;
  const poolBalances = processedPoolBalanceCents(state.problems);
  const metrics = [
    { label: "Net contributions", value: formatMoney(netContributions), note: "After Open Collective/Stripe processing fees", emphasis: true },
    { label: "Received · unprocessed", value: formatMoney(state.unprocessedCents), note: "Takes 1–2 business days" },
    { label: "Current pool balances", value: formatMoney(poolBalances), note: "Processed and unspent" },
    { label: "Approximate run spend", value: formatMoney(approximateRunSpend), note: "Priced model usage" },
    {
      label: "Actual Ramp spend",
      value: ledger.rampSpend
        ? formatMoney(ledger.rampSpend.actualSpendCents)
        : "—",
      note: "Reconciled periodically against approximate run spend",
    },
  ];
  const container = document.querySelector("#ledger-metrics");
  container.replaceChildren(...metrics.map(metricCard));
  container.ariaBusy = "false";
}

function initLedgerExplorer(state, ledger, archive) {
  const problemTitles = new Map(
    state.problems.map((problem) => [problem.problemId, problem.title]),
  );
  const search = document.querySelector("#ledger-search");
  const tabs = [...document.querySelectorAll("[data-ledger-tab]")];
  let activeTab = "contributions";

  const records = {
    contributions: visibleContributions(ledger.donations).sort((left, right) => (
      right.creditedAt.localeCompare(left.creditedAt)
    )),
    runs: [
      ...ledger.runs,
      ...archive.responses.map((response) => ({
        problemId: response.problemId,
        direction: response.direction,
        claimTs: response.claimTs,
        status: "settled",
        contextArtifact: response.contextArtifact,
      })),
    ].sort((left, right) => right.claimTs - left.claimTs),
    reviews: [...ledger.reviews].sort((left, right) => (
      right.reviewedAt.localeCompare(left.reviewedAt)
    )),
  };
  document.querySelector("#contribution-count").textContent = String(records.contributions.length);
  document.querySelector("#run-count").textContent = String(records.runs.length);
  document.querySelector("#review-count").textContent = String(records.reviews.length);

  const render = () => {
    const query = normalizeSearch(search.value);
    const filtered = {
      contributions: records.contributions.filter(
        (record) => !query || searchableDonation(record, problemTitles).includes(query),
      ),
      runs: records.runs.filter(
        (record) => !query || searchableRun(record, problemTitles).includes(query),
      ),
      reviews: records.reviews.filter(
        (record) => !query || searchableReview(record, problemTitles).includes(query),
      ),
    };
    renderContributionRows(filtered.contributions, problemTitles, Boolean(query));
    renderRunRows(filtered.runs, problemTitles, Boolean(query));
    renderReviewRows(filtered.reviews, problemTitles, Boolean(query));
    document.querySelector("#ledger-panels").ariaBusy = "false";
  };

  const selectTab = (name, { focus = false } = {}) => {
    activeTab = name;
    for (const tab of tabs) {
      const selected = tab.dataset.ledgerTab === name;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document.querySelector(`#panel-${tab.dataset.ledgerTab}`).hidden = !selected;
      if (selected && focus) tab.focus();
    }
  };
  for (const tab of tabs) {
    tab.addEventListener("click", () => selectTab(tab.dataset.ledgerTab));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const index = tabs.indexOf(tab);
      const change = event.key === "ArrowRight" ? 1 : -1;
      const next = tabs[(index + change + tabs.length) % tabs.length];
      selectTab(next.dataset.ledgerTab, { focus: true });
    });
  }
  search.addEventListener("input", render);
  selectTab(activeTab);
  render();
}

function renderContributionRows(contributions, problemTitles, filtering) {
  const body = document.querySelector("#contribution-rows");
  if (contributions.length === 0) {
    body.replaceChildren(emptyTableRow(
      7,
      filtering ? "No contributions match that search." : "No contributions have been published yet.",
    ));
    return;
  }
  body.replaceChildren(...contributions.map((donation) => {
    const status = processingPresentation(donation.processingStatus);
    return element("tr", {}, [
      element("td", { text: donation.donorTag }),
      element("td", { text: destinationLabel(donation, problemTitles) }),
      element("td", { text: formatMoney(donation.grossCents) }),
      element("td", { text: formatMoney(donation.netCents) }),
      element("td", {}, [
        element("span", {
          className: `badge ${status.className}`,
          text: status.label,
        }),
      ]),
      element("td", { text: formatDate(donation.creditedAt) }),
      element("td", {}, [
        element("code", { text: donation.dedupId }),
        donation.orderId
          ? element("div", {}, [element("code", { text: `order ${donation.orderId}` })])
          : undefined,
      ]),
    ]);
  }));
}

function renderRunRows(runs, problemTitles, filtering) {
  const body = document.querySelector("#run-rows");
  if (runs.length === 0) {
    body.replaceChildren(emptyTableRow(
      6,
      filtering ? "No research runs match that search." : "No research runs have been published yet.",
    ));
    return;
  }
  body.replaceChildren(...runs.map((run) => {
    const links = element("span", { className: "artifact-links" });
    const latest = run.transcriptSegments?.at(-1);
    if (latest?.humanTranscriptKey) {
      links.append(artifactLink(
        latest.humanTranscriptKey,
        `Transcript${run.transcriptSegments.length > 1 ? ` (${run.transcriptSegments.length})` : ""}`,
      ));
    }
    if (run.solutionKey) links.append(artifactLink(run.solutionKey, "Solution"));
    if (run.contextArtifact) {
      links.append(element("a", {
        text: "View output",
        attrs: {
          href: `index.html#problem-${run.problemId}-${run.direction}`,
        },
      }));
    }
    return element("tr", {}, [
      element("td", {}, [
        element("a", {
          text: problemTitles.get(run.problemId) ?? run.problemId,
          attrs: { href: `index.html#problem-${run.problemId}` },
        }),
        element("div", {}, [element("code", { text: String(run.claimTs) })]),
      ]),
      element("td", { text: directionLabel(run.direction) }),
      element("td", {
        text: run.contextArtifact ? "—" : formatMoney(run.budgetCents),
      }),
      element("td", {
        text: run.contextArtifact ? "—" : formatMoney(run.spentCents),
      }),
      element("td", {}, [
        element("span", {
          className: `badge ${run.status === "running" ? "badge-received" : "badge-processed"}`,
          text: run.status === "running" ? "Running" : "Settled",
        }),
      ]),
      element("td", {}, [links]),
    ]);
  }));
}

function renderReviewRows(reviews, problemTitles, filtering) {
  const body = document.querySelector("#review-rows");
  if (reviews.length === 0) {
    body.replaceChildren(emptyTableRow(
      6,
      filtering ? "No reviews match that search." : "No human reviews have been published yet.",
    ));
    return;
  }
  body.replaceChildren(...reviews.map((review) => {
    const links = element("span", { className: "artifact-links" });
    if (review.solutionKey) links.append(artifactLink(review.solutionKey, "Solution"));
    if (review.noteKey) links.append(artifactLink(review.noteKey, "Review note"));
    const verdict = review.outcome === "unconditional"
      ? "Verified"
      : review.outcome === "conditional"
        ? "Conditional"
        : "Rejected";
    return element("tr", {}, [
      element("td", {}, [
        element("a", {
          text: problemTitles.get(review.problemId) ?? review.problemId,
          attrs: { href: `index.html#problem-${review.problemId}` },
        }),
      ]),
      element("td", { text: directionLabel(review.direction) }),
      element("td", { text: verdict }),
      element("td", { text: review.assumptionLabel ?? "—" }),
      element("td", { text: formatDate(review.reviewedAt) }),
      element("td", {}, [links]),
    ]);
  }));
}

function renderFreshness(state) {
  const freshness = document.querySelector("#data-freshness");
  if (!freshness) return;
  freshness.textContent = `Published ${formatDateTime(state.generatedAt)}`;
}

function renderLoadError(error) {
  const template = document.querySelector("#error-template");
  const errorNode = template.content.cloneNode(true);
  errorNode.querySelector("[data-retry]").addEventListener("click", () => {
    location.reload();
  });
  if (page === "ledger") {
    document.querySelector("#ledger-panels").replaceChildren(errorNode);
    document.querySelector("#ledger-panels").ariaBusy = "false";
  } else {
    document.querySelector("#problem-list").replaceChildren(errorNode);
    document.querySelector("#problem-list").ariaBusy = "false";
    document.querySelector("#problem-count").textContent = "Live catalog unavailable";
  }
  const freshness = document.querySelector("#data-freshness");
  if (freshness) freshness.textContent = "Public data unavailable";
}

function initTermsDialog() {
  const dialog = document.querySelector("#terms-dialog");
  if (!dialog || typeof dialog.showModal !== "function") return;
  const close = dialog.querySelector(".dialog-close");
  for (const link of document.querySelectorAll("[data-terms-link]")) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      dialog.showModal();
    });
  }
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
}

function metricCard(metric) {
  return element("article", {
    className: `metric-card${metric.emphasis ? " metric-card-emphasis" : ""}`,
  }, [
    element("span", { className: "metric-label", text: metric.label }),
    element("strong", { className: "metric-value", text: metric.value }),
    element("small", { text: metric.note }),
  ]);
}

function compactMetric(metric) {
  return element("article", {
    className: `metric-chip${metric.emphasis ? " metric-chip-emphasis" : ""}`,
  }, [
    element("strong", { className: "metric-value", text: metric.value }),
    element("span", { className: "metric-label", text: metric.label }),
  ]);
}

function formattedMathText(value) {
  const fragment = document.createDocumentFragment();
  const text = String(value);
  const exponentPattern = /\^\{([^{}]+)\}/g;
  let cursor = 0;
  for (const match of text.matchAll(exponentPattern)) {
    fragment.append(text.slice(cursor, match.index));
    fragment.append(element("sup", {
      className: "math-sup",
      text: match[1],
    }));
    cursor = match.index + match[0].length;
  }
  fragment.append(text.slice(cursor));
  return fragment;
}

function artifactLink(key, label) {
  return element("a", {
    text: label,
    attrs: {
      href: publicObjectUrl(publicDataBaseUrl, key),
      target: "_blank",
      rel: "noopener noreferrer",
    },
  });
}

function option(value, label) {
  return element("option", {
    text: label,
    attrs: { value },
  });
}

function emptyMessage(title, copy) {
  return element("div", { className: "data-error" }, [
    element("strong", { text: title }),
    element("p", { text: copy }),
  ]);
}

function emptyTableRow(columns, copy) {
  return element("tr", { className: "empty-row" }, [
    element("td", { text: copy, attrs: { colspan: String(columns) } }),
  ]);
}

function isCheckoutUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:"
      && url.hostname === "opencollective.com"
      && url.pathname.startsWith("/indiemath/contribute/")
      && url.pathname.endsWith("/checkout")
    );
  } catch {
    return false;
  }
}

function checkoutUrlWithDefaults(value, minimumContributionCents) {
  const url = new URL(value);
  const amountCents = Number.isSafeInteger(minimumContributionCents)
    && minimumContributionCents > 0
    ? minimumContributionCents
    : 5_000;
  url.searchParams.set("interval", "oneTime");
  url.searchParams.set("amount", String(amountCents / 100));
  url.searchParams.set("contributeAs", "me");
  return url.toString();
}

async function sha256(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function element(tag, {
  className,
  text,
  attrs = {},
} = {}, children = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  for (const [name, value] of Object.entries(attrs)) {
    if (value !== undefined) node.setAttribute(name, String(value));
  }
  for (const child of children.flat()) {
    if (child) node.append(child);
  }
  return node;
}
