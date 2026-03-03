const symbolForm = document.querySelector("#symbol-form");
const symbolInput = document.querySelector("#symbol-input");
const symbolSuggestionsEl = document.querySelector("#symbol-suggestions");
const resetLayoutBtn = document.querySelector("#reset-layout-btn");
const currentStockEl = document.querySelector("#current-stock");
const connectionStatusEl = document.querySelector("#connection-status");
const panelContainer = document.querySelector("#panels");
const panelTemplate = document.querySelector("#panel-template");

const STORAGE_KEYS = {
  panelOrder: "sdashboard.layout.panelOrder.v2",
  panelOpenMap: "sdashboard.layout.panelOpenMap.v1"
};

const appState = {
  symbolInput: "005930",
  resolvedSymbol: "005930.KS",
  stockName: "삼성전자"
};

const sourceStates = new Map();
const sourceTimers = new Map();
const panelRefs = new Map();
const sourceFetchLock = new Map();
const sourceFetchPending = new Map();
const sourceRequestSequence = new Map();

const autocompleteState = {
  items: [],
  activeIndex: -1,
  selectedSuggestion: null,
  requestToken: 0,
  debounceTimer: null,
  abortController: null
};

const realtimePriceSeries = {
  symbol: null,
  points: [],
  maxPoints: 240
};

const dataSources = {
  stockSnapshot: {
    intervalMs: 5000,
    buildUrl: (state) => `/api/quote?symbol=${encodeURIComponent(state.symbolInput)}`
  },
  stockMonthHistory: {
    intervalMs: 60000,
    buildUrl: (state) => `/api/stock/history?symbol=${encodeURIComponent(state.symbolInput)}`
  },
  marketOverview: {
    intervalMs: 10000,
    buildUrl: () => "/api/market-overview"
  },
  krxInfo: {
    intervalMs: 60000,
    buildUrl: () => "/api/krx/info"
  },
  koreaNews: {
    intervalMs: 120000,
    buildUrl: () => "/api/news/korea"
  },
  stockNews: {
    intervalMs: 120000,
    buildUrl: (state) =>
      `/api/news/stock?symbol=${encodeURIComponent(state.symbolInput)}&keyword=${encodeURIComponent(state.stockName)}`
  },
  globalNews: {
    intervalMs: 180000,
    buildUrl: () => "/api/news/global"
  },
  liveTv: {
    intervalMs: 300000,
    buildUrl: () => "/api/tv/live"
  }
};

const panels = [
  {
    id: "month-chart-panel",
    title: "최근 한달 시세 그래프",
    caption: "최근 약 1개월 일별 종가 흐름과 구간 변동을 보여줍니다.",
    sourceKey: "stockMonthHistory",
    render: renderMonthChartPanel
  },
  {
    id: "orderbook-panel",
    title: "5단계 호가/잔량",
    caption: "매도·매수 5호가와 잔량 균형을 실시간으로 확인합니다.",
    sourceKey: "stockSnapshot",
    render: renderOrderBookPanel
  },
  {
    id: "investor-trend-panel",
    title: "수급 동향(외국인·기관·개인)",
    caption: "최근 영업일 기준 주체별 순매수·순매도 흐름입니다.",
    sourceKey: "stockSnapshot",
    render: renderInvestorTrendPanel
  },
  {
    id: "quote-panel",
    title: "실시간 호가 및 당일 고가·저가",
    caption: "실시간 체결가, 매수/매도 호가, 당일 고저가를 제공합니다.",
    sourceKey: "stockSnapshot",
    render: renderQuotePanel
  },
  {
    id: "realtime-chart-panel",
    title: "실시간 가격 차트",
    caption: "5초 주기 시세를 누적해 인트라데이 라인 차트를 표시합니다.",
    sourceKey: "stockSnapshot",
    render: renderRealtimeChartPanel
  },
  {
    id: "financial-panel",
    title: "종목 기본 금융 정보",
    caption: "밸류에이션, 재무비율, 목표주가, 거래지표를 확인합니다.",
    sourceKey: "stockSnapshot",
    render: renderFinancialPanel
  },
  {
    id: "krx-panel",
    title: "한국 주식 시장 기본 정보",
    caption: "KRX 거래 세션과 현재 장 상태를 KST 기준으로 표시합니다.",
    sourceKey: "krxInfo",
    render: renderKrxInfoPanel
  },
  {
    id: "market-panel",
    title: "한국 마켓 전체 상황",
    caption: "코스피·코스닥·환율과 주요 글로벌 변수의 동향을 보여줍니다.",
    sourceKey: "marketOverview",
    render: renderMarketOverviewPanel
  },
  {
    id: "korea-news-panel",
    title: "한국 주요 뉴스",
    caption: "한국 증시 전반의 주요 이슈를 실시간 RSS 기반으로 집계합니다.",
    sourceKey: "koreaNews",
    render: renderNewsPanel
  },
  {
    id: "stock-news-panel",
    title: "해당 종목 주요 뉴스",
    caption: "선택한 종목 키워드 중심의 관련 속보를 표시합니다.",
    sourceKey: "stockNews",
    render: renderNewsPanel
  },
  {
    id: "global-news-panel",
    title: "한국 시장 영향 해외 뉴스",
    caption: "미국 금리/유가/글로벌 거시 변수 관련 뉴스를 모니터링합니다.",
    sourceKey: "globalNews",
    render: renderNewsPanel
  },
  {
    id: "tv-panel",
    title: "실시간 TV 방송",
    caption: "국내 경제·증권 방송 라이브 채널을 즉시 시청할 수 있습니다.",
    sourceKey: "liveTv",
    render: renderTvPanel
  }
];

const panelConfigMap = new Map(panels.map((panel) => [panel.id, panel]));
const defaultPanelOrder = panels.map((panel) => panel.id);
let panelOrder = loadPanelOrder();
let panelOpenMap = loadPanelOpenMap();
let draggingPanelId = null;
const timeFormatter = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false
});
const numberFormatterCache = new Map();

function safeLoadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return fallback;
    }

    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function safeSaveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota / privacy mode failures.
  }
}

function loadPanelOrder() {
  const saved = safeLoadJSON(STORAGE_KEYS.panelOrder, []);
  if (!Array.isArray(saved)) {
    return [...defaultPanelOrder];
  }

  const known = new Set(defaultPanelOrder);
  const filtered = saved.filter((id) => known.has(id));

  for (const id of defaultPanelOrder) {
    if (!filtered.includes(id)) {
      filtered.push(id);
    }
  }

  return filtered;
}

function loadPanelOpenMap() {
  const saved = safeLoadJSON(STORAGE_KEYS.panelOpenMap, {});
  if (!saved || typeof saved !== "object") {
    return {};
  }

  return saved;
}

function savePanelOrder() {
  safeSaveJSON(STORAGE_KEYS.panelOrder, panelOrder);
}

function savePanelOpenMap() {
  safeSaveJSON(STORAGE_KEYS.panelOpenMap, panelOpenMap);
}

function formatTime(isoString) {
  if (!isoString) {
    return "-";
  }

  return timeFormatter.format(new Date(isoString));
}

function getNumberFormatter(digits) {
  const key = Number(digits);
  if (!numberFormatterCache.has(key)) {
    numberFormatterCache.set(
      key,
      new Intl.NumberFormat("ko-KR", {
        maximumFractionDigits: key,
        minimumFractionDigits: key
      })
    );
  }
  return numberFormatterCache.get(key);
}

function formatNumber(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }

  return getNumberFormatter(digits).format(value);
}

function formatSigned(value, digits = 2, suffix = "") {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }

  const abs = Math.abs(value);
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${formatNumber(abs, digits)}${suffix}`;
}

function formatLarge(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }

  if (typeof value === "string") {
    return escapeHtml(value);
  }

  const abs = Math.abs(value);
  if (abs >= 1e12) {
    return `${formatNumber(value / 1e12, 2)}T`;
  }

  if (abs >= 1e9) {
    return `${formatNumber(value / 1e9, 2)}B`;
  }

  if (abs >= 1e6) {
    return `${formatNumber(value / 1e6, 2)}M`;
  }

  return formatNumber(value, 0);
}

function valueClass(value) {
  if (value > 0) {
    return "up";
  }
  if (value < 0) {
    return "down";
  }
  return "neutral";
}

function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sanitizeUrl(value, { fallback = "#" } = {}) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return fallback;
  }

  try {
    const parsed = new URL(raw);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") {
      return fallback;
    }

    return parsed.href;
  } catch {
    return fallback;
  }
}

function intervalLabel(intervalMs) {
  if (intervalMs < 60000) {
    return `${Math.round(intervalMs / 1000)}초`;
  }
  return `${Math.round(intervalMs / 60000)}분`;
}

function ensureSourceState(sourceKey) {
  if (!sourceStates.has(sourceKey)) {
    sourceStates.set(sourceKey, {
      loading: false,
      error: null,
      updatedAt: null,
      data: null
    });
  }
  return sourceStates.get(sourceKey);
}

function renderPanelsForSource(sourceKey) {
  for (const panel of panels) {
    if (panel.sourceKey !== sourceKey) {
      continue;
    }

    const sourceState = ensureSourceState(sourceKey);
    const panelRef = panelRefs.get(panel.id);

    if (!panelRef) {
      continue;
    }

    const sourceConfig = dataSources[sourceKey];
    const statusText = sourceState.error
      ? `오류: ${sourceState.error}`
      : sourceState.loading
        ? "갱신 중..."
        : `최근 갱신: ${formatTime(sourceState.updatedAt)}`;

    panelRef.metaEl.innerHTML = `
      <span class="label-chip">주기 ${intervalLabel(sourceConfig.intervalMs)}</span>
      <span>${escapeHtml(statusText)}</span>
    `;
    const nextContent = panel.render(sourceState.data, sourceState.error);
    if (panelRef.lastContent !== nextContent) {
      panelRef.contentEl.innerHTML = nextContent;
      panelRef.lastContent = nextContent;
    }
  }
}

function renderAllPanels() {
  for (const sourceKey of Object.keys(dataSources)) {
    renderPanelsForSource(sourceKey);
  }
}

function renderMetric(name, value, extraClass = "") {
  return `
    <article class="metric-box">
      <p class="metric-name">${escapeHtml(name)}</p>
      <p class="metric-value ${extraClass}">${value}</p>
    </article>
  `;
}

function metricValue(value, formatter = (num) => formatNumber(num, 2)) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return formatter(value);
  }

  return escapeHtml(String(value));
}

function formatBizdate(value) {
  const text = String(value ?? "");
  if (!/^\d{8}$/.test(text)) {
    return text || "-";
  }

  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

function appendRealtimePoint(symbol, price, fetchedAt) {
  if (typeof price !== "number" || Number.isNaN(price)) {
    return;
  }

  if (realtimePriceSeries.symbol !== symbol) {
    realtimePriceSeries.symbol = symbol;
    realtimePriceSeries.points = [];
  }

  realtimePriceSeries.points.push({
    time: fetchedAt || new Date().toISOString(),
    price
  });

  if (realtimePriceSeries.points.length > realtimePriceSeries.maxPoints) {
    realtimePriceSeries.points = realtimePriceSeries.points.slice(-realtimePriceSeries.maxPoints);
  }
}

function buildChartPath(points, width, height, padding) {
  if (!points.length) {
    return "";
  }

  const prices = points.map((point) => point.price);
  let min = Math.min(...prices);
  let max = Math.max(...prices);

  if (min === max) {
    min -= 1;
    max += 1;
  }

  const plotWidth = width - padding * 2;
  const plotHeight = height - padding * 2;

  return points
    .map((point, index) => {
      const x = padding + (plotWidth * index) / Math.max(points.length - 1, 1);
      const y = padding + ((max - point.price) / (max - min)) * plotHeight;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function renderRealtimeChartPanel(data, error) {
  if (error) {
    return `<p class="empty-state">실시간 차트 데이터를 불러오지 못했습니다. (${escapeHtml(error)})</p>`;
  }

  const quote = data?.quote;
  if (!quote) {
    return '<p class="empty-state">실시간 차트 데이터가 아직 없습니다.</p>';
  }

  const points = realtimePriceSeries.points.slice(-180);
  if (points.length < 2) {
    return '<p class="empty-state">차트 포인트를 수집 중입니다. 잠시 후 자동으로 표시됩니다.</p>';
  }

  const width = 300;
  const height = 160;
  const padding = 12;
  const path = buildChartPath(points, width, height, padding);
  const prices = points.map((point) => point.price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const firstPrice = prices[0];
  const lastPrice = prices.at(-1);
  const windowChange = lastPrice - firstPrice;
  const windowChangePercent = firstPrice !== 0 ? (windowChange / firstPrice) * 100 : 0;
  const windowClass = valueClass(windowChange);

  return `
    <div class="rt-chart-head">
      <p class="rt-chart-title">${escapeHtml(quote.longName ?? quote.shortName ?? "-")} · ${escapeHtml(quote.symbol ?? "-")}</p>
      <p class="rt-chart-value ${windowClass}">${formatNumber(lastPrice, 2)} (${formatSigned(windowChange, 2)}, ${formatSigned(windowChangePercent, 2, "%")})</p>
    </div>
    <svg class="rt-chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="실시간 가격 차트">
      <path class="rt-chart-grid" d="M 0 40 L ${width} 40 M 0 80 L ${width} 80 M 0 120 L ${width} 120"></path>
      <path class="rt-chart-line" d="${path}"></path>
    </svg>
    <div class="rt-chart-meta">
      <span>윈도우 저가 ${formatNumber(minPrice, 2)}</span>
      <span>윈도우 고가 ${formatNumber(maxPrice, 2)}</span>
      <span>포인트 ${points.length}</span>
    </div>
  `;
}

function renderMonthChartPanel(data, error) {
  if (error) {
    return `<p class="empty-state">1개월 시세 데이터를 불러오지 못했습니다. (${escapeHtml(error)})</p>`;
  }

  const points = Array.isArray(data?.points) ? data.points : [];
  if (points.length < 2) {
    return '<p class="empty-state">최근 1개월 차트 데이터가 아직 없습니다.</p>';
  }

  const summary = data?.summary ?? null;
  const chartPoints = points
    .map((point) => ({
      price: typeof point?.close === "number" ? point.close : null
    }))
    .filter((point) => typeof point.price === "number" && !Number.isNaN(point.price));

  if (chartPoints.length < 2) {
    return '<p class="empty-state">차트를 그릴 수 있는 종가 데이터가 부족합니다.</p>';
  }

  const width = 300;
  const height = 160;
  const padding = 12;
  const path = buildChartPath(chartPoints, width, height, padding);

  const firstClose = summary?.firstClose ?? chartPoints[0].price;
  const lastClose = summary?.lastClose ?? chartPoints.at(-1).price;
  const change =
    typeof summary?.change === "number"
      ? summary.change
      : typeof firstClose === "number" && typeof lastClose === "number"
        ? lastClose - firstClose
        : null;
  const changePercent =
    typeof summary?.changePercent === "number"
      ? summary.changePercent
      : typeof change === "number" && typeof firstClose === "number" && firstClose !== 0
        ? (change / firstClose) * 100
        : null;
  const changeClass = valueClass(change);

  const dateFrom = summary?.from ?? points[0]?.date ?? "-";
  const dateTo = summary?.to ?? points.at(-1)?.date ?? "-";

  return `
    <div class="rt-chart-head">
      <p class="rt-chart-title">${escapeHtml(appState.stockName ?? "-")} · ${escapeHtml(data?.symbol ?? appState.resolvedSymbol ?? "-")}</p>
      <p class="rt-chart-value ${changeClass}">${formatNumber(lastClose, 2)} (${formatSigned(change, 2)}, ${formatSigned(changePercent, 2, "%")})</p>
    </div>
    <svg class="rt-chart-svg month-chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="최근 1개월 시세 그래프">
      <path class="rt-chart-grid" d="M 0 40 L ${width} 40 M 0 80 L ${width} 80 M 0 120 L ${width} 120"></path>
      <path class="rt-chart-line month-chart-line" d="${path}"></path>
    </svg>
    <div class="rt-chart-meta">
      <span>${escapeHtml(dateFrom)} ~ ${escapeHtml(dateTo)}</span>
      <span>고가 ${formatNumber(summary?.high, 2)} / 저가 ${formatNumber(summary?.low, 2)}</span>
      <span>누적거래량 ${formatLarge(summary?.totalVolume)}</span>
    </div>
  `;
}

function renderOrderBookPanel(data, error) {
  if (error) {
    return `<p class="empty-state">호가 데이터를 불러오지 못했습니다. (${escapeHtml(error)})</p>`;
  }

  const orderBook = data?.insights?.orderBook;
  if (!orderBook) {
    return '<p class="empty-state">호가 데이터가 아직 없습니다.</p>';
  }

  const sellLevels = Array.isArray(orderBook.sellLevels) ? orderBook.sellLevels : [];
  const buyLevels = Array.isArray(orderBook.buyLevels) ? orderBook.buyLevels : [];

  const renderRow = (side, level, index) => `
    <div class="orderbook-row ${side}">
      <span class="side">${side === "sell" ? `매도${index + 1}` : `매수${index + 1}`}</span>
      <span>${formatNumber(level.price, 2)}</span>
      <span>${formatLarge(level.count)}</span>
      <span>${level.rate === null || level.rate === undefined ? "-" : `${formatNumber(level.rate, 0)}%`}</span>
    </div>
  `;

  const imbalance =
    typeof orderBook.totalBuy === "number" && typeof orderBook.totalSell === "number"
      ? orderBook.totalBuy - orderBook.totalSell
      : null;

  return `
    <div class="orderbook-summary">
      <span>총 매도잔량 ${formatLarge(orderBook.totalSell)}</span>
      <span>총 매수잔량 ${formatLarge(orderBook.totalBuy)}</span>
      <span class="${valueClass(imbalance)}">잔량차 ${formatSigned(imbalance, 0)}</span>
    </div>
    <div class="orderbook-table">
      <div class="orderbook-row header">
        <span>구분</span>
        <span>가격</span>
        <span>잔량</span>
        <span>비중</span>
      </div>
      ${sellLevels.map((level, index) => renderRow("sell", level, index)).join("")}
      <div class="orderbook-mid">중간가 ${formatNumber(orderBook.middlePrice, 2)}</div>
      ${buyLevels.map((level, index) => renderRow("buy", level, index)).join("")}
    </div>
  `;
}

function renderInvestorTrendPanel(data, error) {
  if (error) {
    return `<p class="empty-state">수급 데이터를 불러오지 못했습니다. (${escapeHtml(error)})</p>`;
  }

  const trend = Array.isArray(data?.insights?.investorTrend) ? data.insights.investorTrend.slice(0, 8) : [];
  if (!trend.length) {
    return '<p class="empty-state">수급 데이터가 아직 없습니다.</p>';
  }

  return `
    <div class="investor-table">
      <div class="investor-row header">
        <span>일자</span>
        <span>외국인</span>
        <span>기관</span>
        <span>개인</span>
      </div>
      ${trend
        .map(
          (row) => `
            <div class="investor-row">
              <span>${escapeHtml(formatBizdate(row.bizdate))}</span>
              <span class="${valueClass(row.foreignerNet)}">${formatSigned(row.foreignerNet, 0)}</span>
              <span class="${valueClass(row.organNet)}">${formatSigned(row.organNet, 0)}</span>
              <span class="${valueClass(row.individualNet)}">${formatSigned(row.individualNet, 0)}</span>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderQuotePanel(data, error) {
  if (error) {
    return `<p class="empty-state">시세 데이터를 불러오지 못했습니다. (${escapeHtml(error)})</p>`;
  }

  const quote = data?.quote;
  if (!quote) {
    return '<p class="empty-state">시세 데이터가 아직 없습니다.</p>';
  }

  const changeCls = valueClass(quote.change);
  const displayName = `${quote.longName ?? quote.shortName ?? "-"} (${quote.symbol ?? "-"})`;

  return `
    <p><strong>${escapeHtml(displayName)}</strong> · ${escapeHtml(quote.exchangeName ?? "-")} · ${escapeHtml(quote.marketState ?? "-")} · 소스 ${escapeHtml(data?.source ?? "-")}</p>
    <div class="number-grid">
      ${renderMetric("현재가", formatNumber(quote.price, 2), changeCls)}
      ${renderMetric("등락", `${formatSigned(quote.change, 2)} (${formatSigned(quote.changePercent, 2, "%")})`, changeCls)}
      ${renderMetric("매수호가(Bid)", quote.bid === null ? "-" : `${formatNumber(quote.bid, 2)} (${formatNumber(quote.bidSize)})`)}
      ${renderMetric("매도호가(Ask)", quote.ask === null ? "-" : `${formatNumber(quote.ask, 2)} (${formatNumber(quote.askSize)})`)}
      ${renderMetric("당일 고가", formatNumber(quote.dayHigh, 2))}
      ${renderMetric("당일 저가", formatNumber(quote.dayLow, 2))}
      ${renderMetric("시가", formatNumber(quote.open, 2))}
      ${renderMetric("거래량", formatLarge(quote.volume))}
    </div>
  `;
}

function renderFinancialPanel(data, error) {
  if (error) {
    return `<p class="empty-state">금융 지표 데이터를 불러오지 못했습니다. (${escapeHtml(error)})</p>`;
  }

  const quote = data?.quote;
  const f = data?.fundamentals;

  if (!quote) {
    return '<p class="empty-state">금융 지표 데이터가 아직 없습니다.</p>';
  }

  return `
    <div class="number-grid">
      ${renderMetric("시가총액", metricValue(f?.marketCap ?? quote.marketCap, (v) => formatLarge(v)))}
      ${renderMetric("PER", metricValue(f?.per ?? quote.trailingPE))}
      ${renderMetric("EPS", metricValue(f?.eps ?? quote.epsTtm))}
      ${renderMetric("추정PER", metricValue(f?.cnsPer))}
      ${renderMetric("추정EPS", metricValue(f?.cnsEps))}
      ${renderMetric("PBR", metricValue(f?.pbr))}
      ${renderMetric("BPS", metricValue(f?.bps))}
      ${renderMetric("외인소진율", metricValue(f?.foreignRate))}
      ${renderMetric("배당수익률", metricValue(f?.dividendYield))}
      ${renderMetric("주당배당금", metricValue(f?.dividend))}
      ${renderMetric("52주 고가", metricValue(quote.fiftyTwoWeekHigh))}
      ${renderMetric("52주 저가", metricValue(quote.fiftyTwoWeekLow))}
    </div>
  `;
}

function renderKrxInfoPanel(data, error) {
  if (error) {
    return `<p class="empty-state">KRX 장 정보 조회 중 오류가 발생했습니다. (${escapeHtml(error)})</p>`;
  }

  if (!data?.market) {
    return '<p class="empty-state">KRX 장 정보가 아직 없습니다.</p>';
  }

  return `
    <div class="number-grid">
      ${renderMetric("현재 KST", escapeHtml(data.nowKst ?? "-"))}
      ${renderMetric("현재 세션", escapeHtml(data.currentSession?.sessionLabel ?? "-"))}
      ${renderMetric("다음 이벤트", escapeHtml(data.currentSession?.nextEvent ?? "-"))}
      ${renderMetric("정규장", escapeHtml(data.market.regularSession))}
      ${renderMetric("시가 동시호가", escapeHtml(data.market.preOpenCallAuction))}
      ${renderMetric("종가 동시호가", escapeHtml(data.market.closeCallAuction))}
      ${renderMetric("시간외 종가", escapeHtml(data.market.afterHoursClosePrice))}
      ${renderMetric("시간외 단일가", escapeHtml(data.market.afterHoursSinglePrice))}
    </div>
  `;
}

function renderMarketOverviewPanel(data, error) {
  if (error) {
    return `<p class="empty-state">시장 개요 데이터를 불러오지 못했습니다. (${escapeHtml(error)})</p>`;
  }

  const overview = Array.isArray(data?.overview) ? data.overview : [];
  if (!overview.length) {
    return '<p class="empty-state">시장 개요 데이터가 아직 없습니다.</p>';
  }

  const noteHtml = data?.notes
    ? `<p class="empty-state">국내: ${escapeHtml(data.notes.domestic ?? "-")} / 해외: ${escapeHtml(data.notes.global ?? "-")}</p>`
    : "";

  const rows = overview
    .map((item) => {
      const cls = valueClass(item.change);
      const rowName = `${item.shortName ?? item.longName ?? item.symbol}`;
      const changePart = item.change === null || item.change === undefined ? "-" : formatSigned(item.change, 2);
      const pctPart =
        item.changePercent === null || item.changePercent === undefined
          ? "-"
          : formatSigned(item.changePercent, 2, "%");
      const valuePart = `${formatNumber(item.price, 2)} (${changePart}, ${pctPart})`;

      return `
        <div class="market-row">
          <div>
            <p class="market-row-name">${escapeHtml(rowName)}</p>
            <p class="market-row-meta">${escapeHtml(item.symbol ?? "-")} · ${escapeHtml(item.currency ?? "-")} · ${escapeHtml(item.source ?? "-")}</p>
          </div>
          <p class="market-row-value ${cls}">${valuePart}</p>
        </div>
      `;
    })
    .join("");

  return `${noteHtml}${rows}`;
}

function renderNewsItems(items) {
  if (!Array.isArray(items) || !items.length) {
    return '<p class="empty-state">표시할 뉴스가 없습니다.</p>';
  }

  const topItems = items.slice(0, 12);
  return `
    <ul class="news-list">
      ${topItems
        .map((item) => {
          const safeLink = sanitizeUrl(item.link);
          return `
            <li class="news-item">
              <a href="${escapeHtml(safeLink)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>
              <div class="news-meta">${escapeHtml(item.source || "Unknown")} · ${escapeHtml(item.publishedAt || "-")}</div>
            </li>
          `
        })
        .join("")}
    </ul>
  `;
}

function renderNewsPanel(data, error) {
  if (error) {
    return `<p class="empty-state">뉴스 데이터를 불러오지 못했습니다. (${escapeHtml(error)})</p>`;
  }

  return renderNewsItems(data?.items);
}

function renderTvPanel(data, error) {
  if (error) {
    return `<p class="empty-state">라이브 방송 정보를 불러오지 못했습니다. (${escapeHtml(error)})</p>`;
  }

  const streams = Array.isArray(data?.streams) ? data.streams : [];

  if (!streams.length) {
    return '<p class="empty-state">라이브 채널 데이터가 없습니다.</p>';
  }

  return `
    <div class="tv-grid">
      ${streams
        .map((stream) => {
          const embedUrl = sanitizeUrl(stream.embedUrl, { fallback: "about:blank" });
          const livePage = sanitizeUrl(stream.livePage);
          return `
            <article class="tv-card">
              <p class="tv-title">${escapeHtml(stream.name)}</p>
              <div class="tv-frame-wrap">
                <iframe src="${escapeHtml(embedUrl)}" title="${escapeHtml(stream.name)} 라이브 방송" loading="lazy" allowfullscreen></iframe>
              </div>
              <div class="tv-links">
                <a href="${escapeHtml(livePage)}" target="_blank" rel="noopener noreferrer">라이브 페이지 열기</a>
              </div>
            </article>
          `
        })
        .join("")}
    </div>
  `;
}

function closeAutocomplete() {
  if (autocompleteState.debounceTimer) {
    clearTimeout(autocompleteState.debounceTimer);
    autocompleteState.debounceTimer = null;
  }
  if (autocompleteState.abortController) {
    autocompleteState.abortController.abort();
    autocompleteState.abortController = null;
  }
  autocompleteState.requestToken += 1;
  autocompleteState.selectedSuggestion = null;
  autocompleteState.items = [];
  autocompleteState.activeIndex = -1;
  symbolSuggestionsEl.hidden = true;
  symbolSuggestionsEl.innerHTML = "";
}

function renderAutocompleteList() {
  const items = autocompleteState.items;

  if (!items.length) {
    closeAutocomplete();
    return;
  }

  symbolSuggestionsEl.hidden = false;
  symbolSuggestionsEl.innerHTML = items
    .map((item, index) => {
      const activeClass = index === autocompleteState.activeIndex ? "is-active" : "";
      return `
        <li role="option" aria-selected="${index === autocompleteState.activeIndex}" data-index="${index}">
          <button type="button" class="symbol-suggestion-btn ${activeClass}" data-index="${index}">
            <span class="symbol-suggestion-name">${escapeHtml(item.name ?? "-")}</span>
            <span class="symbol-suggestion-meta">${escapeHtml(item.code ?? "-")} · ${escapeHtml(item.market ?? "-")}</span>
          </button>
        </li>
      `;
    })
    .join("");
}

async function fetchAutocompleteItems(query, signal) {
  const response = await fetch(`/api/search/stocks?q=${encodeURIComponent(query)}&limit=8`, {
    cache: "no-store",
    signal
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data?.items) ? data.items : [];
}

function scheduleAutocompleteFetch() {
  const query = symbolInput.value.trim();

  if (autocompleteState.debounceTimer) {
    clearTimeout(autocompleteState.debounceTimer);
    autocompleteState.debounceTimer = null;
  }

  if (!query) {
    closeAutocomplete();
    return;
  }

  const currentToken = ++autocompleteState.requestToken;

  autocompleteState.debounceTimer = setTimeout(async () => {
    if (autocompleteState.abortController) {
      autocompleteState.abortController.abort();
    }

    const controller = new AbortController();
    autocompleteState.abortController = controller;

    try {
      const items = await fetchAutocompleteItems(query, controller.signal);

      if (currentToken !== autocompleteState.requestToken) {
        return;
      }

      autocompleteState.items = items;
      autocompleteState.activeIndex = items.length ? 0 : -1;
      renderAutocompleteList();
    } catch (error) {
      if (currentToken !== autocompleteState.requestToken) {
        return;
      }

      if (error instanceof Error && error.name === "AbortError") {
        return;
      }

      closeAutocomplete();
    } finally {
      if (autocompleteState.abortController === controller) {
        autocompleteState.abortController = null;
      }
    }
  }, 180);
}

function moveAutocompleteActive(delta) {
  const size = autocompleteState.items.length;
  if (!size) {
    return;
  }

  const base = autocompleteState.activeIndex < 0 ? 0 : autocompleteState.activeIndex;
  autocompleteState.activeIndex = (base + delta + size) % size;
  renderAutocompleteList();
}

function applySymbolSelection(rawInput, suggestion = null) {
  const input = String(rawInput ?? "").trim();

  if (!input) {
    return;
  }

  if (suggestion) {
    autocompleteState.selectedSuggestion = {
      code: suggestion.code,
      symbol: suggestion.symbol,
      name: suggestion.name
    };
    appState.symbolInput = suggestion.code;
    appState.resolvedSymbol = suggestion.symbol;
    appState.stockName = suggestion.name;
    symbolInput.value = suggestion.name;
  } else {
    autocompleteState.selectedSuggestion = null;
    appState.symbolInput = input;
    appState.resolvedSymbol = input;
    appState.stockName = input;
  }

  realtimePriceSeries.symbol = appState.resolvedSymbol;
  realtimePriceSeries.points = [];
  currentStockEl.textContent = `${appState.stockName} (${appState.resolvedSymbol})`;
  refreshSymbolDependentSources();
}

function applyAutocompleteIndex(index) {
  const item = autocompleteState.items[index];
  if (!item) {
    return;
  }

  closeAutocomplete();
  applySymbolSelection(item.name ?? item.code, item);
}

function persistPanelOrderFromDOM() {
  const order = Array.from(panelContainer.querySelectorAll(".panel"))
    .map((node) => node.dataset.panelId)
    .filter(Boolean);

  if (!order.length) {
    return;
  }

  panelOrder = order;
  savePanelOrder();
}

function onPanelDragStart(event) {
  const node = event.currentTarget;
  draggingPanelId = node.dataset.panelId || null;
  node.classList.add("is-dragging");

  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggingPanelId || "");
  }
}

function onPanelDragOver(event) {
  event.preventDefault();

  const target = event.currentTarget;
  const targetId = target.dataset.panelId;

  if (!draggingPanelId || !targetId || draggingPanelId === targetId) {
    return;
  }

  const draggingNode = panelContainer.querySelector(`.panel[data-panel-id="${draggingPanelId}"]`);
  if (!draggingNode) {
    return;
  }

  const rect = target.getBoundingClientRect();
  const placeBefore = event.clientY < rect.top + rect.height / 2;

  if (placeBefore) {
    panelContainer.insertBefore(draggingNode, target);
  } else {
    panelContainer.insertBefore(draggingNode, target.nextElementSibling);
  }
}

function onPanelDrop(event) {
  event.preventDefault();
  persistPanelOrderFromDOM();
}

function onPanelDragEnd(event) {
  event.currentTarget.classList.remove("is-dragging");
  draggingPanelId = null;
  persistPanelOrderFromDOM();
}

function attachPanelDnD(node) {
  node.draggable = true;
  node.addEventListener("dragstart", onPanelDragStart);
  node.addEventListener("dragover", onPanelDragOver);
  node.addEventListener("drop", onPanelDrop);
  node.addEventListener("dragend", onPanelDragEnd);
}

function buildPanels() {
  panelContainer.innerHTML = "";
  panelRefs.clear();

  for (const panelId of panelOrder) {
    const panel = panelConfigMap.get(panelId);
    if (!panel) {
      continue;
    }

    const node = panelTemplate.content.firstElementChild.cloneNode(true);
    const titleEl = node.querySelector("h2");
    const captionEl = node.querySelector(".panel-caption");
    const metaEl = node.querySelector(".panel-meta");
    const contentEl = node.querySelector(".panel-content");

    titleEl.textContent = panel.title;
    captionEl.textContent = panel.caption;
    metaEl.textContent = "데이터 대기 중";
    contentEl.innerHTML = '<p class="empty-state">초기 데이터를 불러오는 중입니다...</p>';

    node.dataset.panelId = panel.id;

    if (panelOpenMap[panel.id] === false) {
      node.open = false;
    }

    node.addEventListener("toggle", () => {
      panelOpenMap[panel.id] = node.open;
      savePanelOpenMap();
    });

    attachPanelDnD(node);

    panelRefs.set(panel.id, {
      node,
      metaEl,
      contentEl,
      lastContent: contentEl.innerHTML
    });

    panelContainer.append(node);
  }
}

async function fetchSource(sourceKey, { force = false } = {}) {
  const sourceConfig = dataSources[sourceKey];
  const state = ensureSourceState(sourceKey);

  if (sourceFetchLock.get(sourceKey)) {
    if (force) {
      sourceFetchPending.set(sourceKey, true);
      const nextSequence = (sourceRequestSequence.get(sourceKey) ?? 0) + 1;
      sourceRequestSequence.set(sourceKey, nextSequence);
    }
    return;
  }

  const sequence = (sourceRequestSequence.get(sourceKey) ?? 0) + 1;
  sourceRequestSequence.set(sourceKey, sequence);
  sourceFetchLock.set(sourceKey, true);
  sourceFetchPending.set(sourceKey, false);
  state.loading = true;
  state.error = null;
  renderPanelsForSource(sourceKey);

  try {
    const url = sourceConfig.buildUrl(appState);
    const response = await fetch(url, { cache: "no-store" });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    if (isStaleSequence(sourceKey, sequence)) {
      return;
    }

    applySourceData(sourceKey, state, data);
  } catch (error) {
    if (isStaleSequence(sourceKey, sequence)) {
      return;
    }
    state.error = error instanceof Error ? error.message : "Unknown error";
  } finally {
    finalizeSourceFetch(sourceKey, state);
  }
}

function isStaleSequence(sourceKey, sequence) {
  return sequence !== sourceRequestSequence.get(sourceKey);
}

function applySourceData(sourceKey, state, data) {
  state.data = data;
  state.updatedAt = data?.fetchedAt || new Date().toISOString();
  state.error = null;

  if (sourceKey === "stockSnapshot") {
    updateStockSnapshotState(data, state.updatedAt);
  }
}

function updateStockSnapshotState(data, updatedAt) {
  const previousSymbol = appState.resolvedSymbol;
  const previousName = appState.stockName;
  const latestSymbol = data?.symbol;
  const latestName = data?.quote?.longName ?? data?.quote?.shortName ?? appState.stockName;
  const latestPrice = data?.quote?.price;

  if (latestSymbol) {
    appState.resolvedSymbol = latestSymbol;
  }

  if (latestName) {
    appState.stockName = latestName;
  }

  appendRealtimePoint(appState.resolvedSymbol, latestPrice, updatedAt);
  currentStockEl.textContent = `${appState.stockName} (${appState.resolvedSymbol})`;

  const stockIdentityChanged =
    previousSymbol !== appState.resolvedSymbol || previousName !== appState.stockName;
  if (stockIdentityChanged) {
    fetchSource("stockNews", { force: true });
  }
}

function finalizeSourceFetch(sourceKey, state) {
  state.loading = false;
  sourceFetchLock.set(sourceKey, false);
  renderPanelsForSource(sourceKey);
  refreshConnectionStatus();

  if (sourceFetchPending.get(sourceKey)) {
    sourceFetchPending.set(sourceKey, false);
    fetchSource(sourceKey, { force: true });
  }
}

function startPolling() {
  for (const [sourceKey, sourceConfig] of Object.entries(dataSources)) {
    fetchSource(sourceKey, { force: true });
    const timer = setInterval(() => {
      fetchSource(sourceKey);
    }, sourceConfig.intervalMs);
    sourceTimers.set(sourceKey, timer);
  }
}

function refreshConnectionStatus() {
  const allStates = Array.from(sourceStates.values());
  const loadingCount = allStates.filter((state) => state.loading).length;
  const errorCount = allStates.filter((state) => state.error).length;

  if (loadingCount > 0) {
    connectionStatusEl.textContent = `데이터 동기화 중 (${loadingCount})`;
    return;
  }

  if (errorCount > 0) {
    connectionStatusEl.textContent = `일부 소스 오류 (${errorCount})`;
    return;
  }

  const newest = allStates
    .map((state) => state.updatedAt)
    .filter(Boolean)
    .sort()
    .at(-1);

  connectionStatusEl.textContent = newest ? `정상 · 최근 ${formatTime(newest)} 갱신` : "데이터 수신 대기";
}

function refreshSymbolDependentSources() {
  fetchSource("stockSnapshot", { force: true });
  fetchSource("stockMonthHistory", { force: true });
  fetchSource("stockNews", { force: true });
}

function handleSymbolSubmit(event) {
  event.preventDefault();

  if (autocompleteState.items.length && autocompleteState.activeIndex >= 0 && !symbolSuggestionsEl.hidden) {
    applyAutocompleteIndex(autocompleteState.activeIndex);
    return;
  }

  if (
    autocompleteState.selectedSuggestion &&
    symbolInput.value.trim() === autocompleteState.selectedSuggestion.name
  ) {
    const selected = autocompleteState.selectedSuggestion;
    applySymbolSelection(selected.code, selected);
    return;
  }

  closeAutocomplete();
  applySymbolSelection(symbolInput.value);
}

function handleSymbolKeydown(event) {
  if (symbolSuggestionsEl.hidden || !autocompleteState.items.length) {
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveAutocompleteActive(1);
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    moveAutocompleteActive(-1);
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    applyAutocompleteIndex(autocompleteState.activeIndex);
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    closeAutocomplete();
  }
}

function handleSuggestionClick(event) {
  const button = event.target.closest("button[data-index]");
  if (!button) {
    return;
  }

  const index = Number(button.dataset.index);
  applyAutocompleteIndex(index);
}

function handleOutsideClick(event) {
  if (!symbolForm.contains(event.target)) {
    closeAutocomplete();
  }
}

function resetLayout() {
  panelOrder = [...defaultPanelOrder];
  panelOpenMap = {};
  savePanelOrder();
  savePanelOpenMap();
  buildPanels();
  renderAllPanels();
}

function bindEvents() {
  symbolForm.addEventListener("submit", handleSymbolSubmit);
  symbolInput.addEventListener("input", () => {
    autocompleteState.selectedSuggestion = null;
    scheduleAutocompleteFetch();
  });
  symbolInput.addEventListener("keydown", handleSymbolKeydown);
  symbolSuggestionsEl.addEventListener("mousedown", (event) => event.preventDefault());
  symbolSuggestionsEl.addEventListener("click", handleSuggestionClick);
  document.addEventListener("click", handleOutsideClick);

  if (resetLayoutBtn) {
    resetLayoutBtn.addEventListener("click", resetLayout);
  }
}

function bootstrap() {
  buildPanels();
  renderAllPanels();
  bindEvents();
  startPolling();
}

bootstrap();
