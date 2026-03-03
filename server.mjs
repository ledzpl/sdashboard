import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const KST_TIME_ZONE = "Asia/Seoul";
const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const DEFAULT_STOCK = "005930";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "application/json,text/plain,*/*"
};

const FETCH_TIMEOUT_MS = 8000;
const KOSPI_UNIVERSE_TTL_MS = 6 * 60 * 60 * 1000;
const KOSPI_PAGE_BATCH_SIZE = 8;
const API_RATE_WINDOW_MS = 60 * 1000;
const API_RATE_LIMIT_PER_WINDOW = 120;
const API_MAX_CONCURRENT_REQUESTS = 40;
const GOOGLE_NEWS_CACHE_TTL_MS = 60 * 1000;
const GOOGLE_NEWS_CACHE_MAX_ENTRIES = 256;
const STOCK_SEARCH_CACHE_TTL_MS = 30 * 1000;
const STOCK_SEARCH_CACHE_MAX_ENTRIES = 512;
const STOCK_SNAPSHOT_CACHE_TTL_MS = 2 * 1000;
const STOCK_SNAPSHOT_CACHE_MAX_ENTRIES = 256;
const STOCK_HISTORY_CACHE_TTL_MS = 60 * 1000;
const STOCK_HISTORY_CACHE_MAX_ENTRIES = 256;
const MARKET_OVERVIEW_CACHE_TTL_MS = 5 * 1000;
const MARKET_OVERVIEW_CACHE_MAX_ENTRIES = 16;
const KOSPI_UNIVERSE_CACHE = {
  items: null,
  loadedAt: 0,
  loadingPromise: null
};
const API_RATE_LIMIT_CACHE = new Map();
const GOOGLE_NEWS_CACHE = new Map();
const STOCK_SEARCH_CACHE = new Map();
const STOCK_SNAPSHOT_CACHE = new Map();
const STOCK_HISTORY_CACHE = new Map();
const MARKET_OVERVIEW_CACHE = new Map();
let activeApiRequests = 0;

function toJSON(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function toError(response, statusCode, message) {
  toJSON(response, statusCode, {
    error: message,
    timestamp: new Date().toISOString()
  });
}

function decodeXml(text) {
  if (!text) {
    return "";
  }

  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(text) {
  if (!text) {
    return "";
  }

  return text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function parseLooseNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const cleaned = String(value).replace(/,/g, "").replace(/[^0-9.+-]/g, "");
  if (!cleaned) {
    return null;
  }

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getRequestIp(request) {
  if (TRUST_PROXY) {
    const forwarded = String(request.headers["x-forwarded-for"] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    if (forwarded.length > 0) {
      return forwarded[0];
    }
  }

  return request.socket?.remoteAddress ?? "unknown";
}

function isRateLimited(request) {
  const now = Date.now();
  const ip = getRequestIp(request);
  const entry = API_RATE_LIMIT_CACHE.get(ip);

  if (!entry || now - entry.windowStart >= API_RATE_WINDOW_MS) {
    API_RATE_LIMIT_CACHE.set(ip, {
      windowStart: now,
      count: 1,
      lastSeenAt: now
    });
  } else {
    entry.count += 1;
    entry.lastSeenAt = now;
    API_RATE_LIMIT_CACHE.set(ip, entry);
  }

  if (API_RATE_LIMIT_CACHE.size > 2048) {
    for (const [key, value] of API_RATE_LIMIT_CACHE.entries()) {
      if (now - value.lastSeenAt > API_RATE_WINDOW_MS * 4) {
        API_RATE_LIMIT_CACHE.delete(key);
      }
    }
  }

  const current = API_RATE_LIMIT_CACHE.get(ip);
  return current ? current.count > API_RATE_LIMIT_PER_WINDOW : false;
}

function buildGoogleNewsCacheKey({ query, hl, gl, ceid, limit }) {
  return JSON.stringify([query, hl, gl, ceid, limit]);
}

function buildStockSearchCacheKey(query, limit) {
  return JSON.stringify([String(query ?? "").trim().toUpperCase(), limit]);
}

function buildStockSnapshotCacheKey(requested) {
  return normalizeStockInput(requested);
}

function hasOwnField(target, fieldName) {
  return !!target && Object.prototype.hasOwnProperty.call(target, fieldName);
}

function pruneTimedCache(cache, maxEntries) {
  if (cache.size <= maxEntries) {
    return;
  }

  const entries = Array.from(cache.entries()).sort(
    (a, b) => (a[1]?.lastAccessAt ?? 0) - (b[1]?.lastAccessAt ?? 0)
  );
  const removeCount = cache.size - maxEntries;

  for (let index = 0; index < removeCount; index += 1) {
    const key = entries[index]?.[0];
    if (key) {
      cache.delete(key);
    }
  }
}

async function getOrLoadTimedCache({
  cache,
  key,
  ttlMs,
  maxEntries,
  load,
  valueField = "value"
}) {
  const now = Date.now();
  const cached = cache.get(key);
  const hasCachedValue = hasOwnField(cached, valueField);

  if (cached) {
    cached.lastAccessAt = now;

    if (cached.loadingPromise) {
      if (hasCachedValue) {
        return cached.loadingPromise.catch(() => cached[valueField]);
      }
      return cached.loadingPromise;
    }

    if (hasCachedValue && now - cached.loadedAt < ttlMs) {
      return cached[valueField];
    }
  }

  const loadingPromise = (async () => {
    const loadedValue = await load();
    cache.set(key, {
      [valueField]: loadedValue,
      loadedAt: Date.now(),
      lastAccessAt: Date.now(),
      loadingPromise: null
    });
    pruneTimedCache(cache, maxEntries);
    return loadedValue;
  })();

  const nextEntry = {
    loadedAt: cached?.loadedAt ?? 0,
    lastAccessAt: now,
    loadingPromise
  };
  if (hasCachedValue) {
    nextEntry[valueField] = cached[valueField];
  }
  cache.set(key, nextEntry);

  try {
    return await loadingPromise;
  } catch (error) {
    const stale = cache.get(key);
    if (hasOwnField(stale, valueField)) {
      stale.loadingPromise = null;
      stale.lastAccessAt = Date.now();
      return stale[valueField];
    }

    cache.delete(key);
    throw error;
  } finally {
    const entry = cache.get(key);
    if (entry?.loadingPromise === loadingPromise) {
      entry.loadingPromise = null;
      entry.lastAccessAt = Date.now();
    }
  }
}

function normalizeStockInput(input) {
  const raw = String(input ?? "").trim().toUpperCase();

  if (!raw) {
    return `${DEFAULT_STOCK}.KS`;
  }

  if (/^\d{6}$/.test(raw)) {
    return `${raw}.KS`;
  }

  if (/^\d{6}\.(KS|KQ)$/.test(raw)) {
    return raw;
  }

  return raw;
}

function extractStockCode(input) {
  const normalized = normalizeStockInput(input);
  const matched = normalized.match(/(\d{6})\.(KS|KQ)$/);

  if (matched) {
    return matched[1];
  }

  if (/^\d{6}$/.test(normalized)) {
    return normalized;
  }

  return null;
}

async function resolveStockCode(input) {
  const directCode = extractStockCode(input);
  if (directCode) {
    return directCode;
  }

  try {
    const resolved = await resolveStockSymbol(input);
    const matched = resolved.match(/(\d{6})\.(KS|KQ)$/);
    return matched ? matched[1] : null;
  } catch (error) {
    return null;
  }
}

async function fetchResponse(url, headers = DEFAULT_HEADERS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Failed request: ${url} (${response.status})`);
    }

    return response;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out: ${url} (${FETCH_TIMEOUT_MS}ms)`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchJSON(url, headers = DEFAULT_HEADERS) {
  const response = await fetchResponse(url, headers);
  return response.json();
}

async function fetchText(url, headers = DEFAULT_HEADERS) {
  const response = await fetchResponse(url, headers);
  return response.text();
}

async function fetchTextEucKr(url, headers = DEFAULT_HEADERS) {
  const response = await fetchResponse(url, headers);
  const buffer = await response.arrayBuffer();
  return new TextDecoder("euc-kr").decode(buffer);
}

function parseKospiStocksFromPage(html) {
  const regex = /<a href="\/item\/main\.naver\?code=(\d{6})" class="tltle">([^<]+)<\/a>/g;
  const items = [];

  for (const match of html.matchAll(regex)) {
    const code = match[1];
    const name = stripHtml(decodeXml(match[2]));

    if (!code || !name) {
      continue;
    }

    items.push({
      code,
      name,
      symbol: `${code}.KS`,
      market: "KOSPI",
      exchangeName: "KOSPI"
    });
  }

  return items;
}

function parseKospiMaxPage(html) {
  const regex = /sise_market_sum\.naver\?sosok=0&page=(\d+)/g;
  let max = 1;

  for (const match of html.matchAll(regex)) {
    const page = parseLooseNumber(match[1]);
    if (page !== null) {
      max = Math.max(max, page);
    }
  }

  return clampNumber(max, 1, 200);
}

async function fetchKospiUniverseFromNaver() {
  const firstURL = "https://finance.naver.com/sise/sise_market_sum.naver?sosok=0&page=1";
  const firstPage = await fetchTextEucKr(firstURL);
  const maxPage = parseKospiMaxPage(firstPage);
  const seen = new Map();

  for (const item of parseKospiStocksFromPage(firstPage)) {
    seen.set(item.code, item);
  }

  for (let start = 2; start <= maxPage; start += KOSPI_PAGE_BATCH_SIZE) {
    const pages = [];
    const end = Math.min(start + KOSPI_PAGE_BATCH_SIZE - 1, maxPage);

    for (let page = start; page <= end; page += 1) {
      pages.push(page);
    }

    const pageHtmls = await Promise.all(
      pages.map((page) =>
        fetchTextEucKr(`https://finance.naver.com/sise/sise_market_sum.naver?sosok=0&page=${page}`)
      )
    );

    for (const html of pageHtmls) {
      for (const item of parseKospiStocksFromPage(html)) {
        if (!seen.has(item.code)) {
          seen.set(item.code, item);
        }
      }
    }
  }

  return Array.from(seen.values());
}

function triggerKospiUniverseRefresh() {
  if (KOSPI_UNIVERSE_CACHE.loadingPromise) {
    return KOSPI_UNIVERSE_CACHE.loadingPromise;
  }

  KOSPI_UNIVERSE_CACHE.loadingPromise = (async () => {
    const items = await fetchKospiUniverseFromNaver();
    KOSPI_UNIVERSE_CACHE.items = items;
    KOSPI_UNIVERSE_CACHE.loadedAt = Date.now();
    return items;
  })().finally(() => {
    KOSPI_UNIVERSE_CACHE.loadingPromise = null;
  });

  return KOSPI_UNIVERSE_CACHE.loadingPromise;
}

async function getKospiUniverse() {
  const now = Date.now();
  const hasCachedItems =
    Array.isArray(KOSPI_UNIVERSE_CACHE.items) && KOSPI_UNIVERSE_CACHE.items.length > 0;
  const cacheIsFresh = hasCachedItems
    ? now - KOSPI_UNIVERSE_CACHE.loadedAt < KOSPI_UNIVERSE_TTL_MS
    : false;

  if (cacheIsFresh) {
    return KOSPI_UNIVERSE_CACHE.items;
  }

  if (hasCachedItems) {
    triggerKospiUniverseRefresh().catch(() => {
      // Keep serving stale cache until refresh succeeds.
    });
    return KOSPI_UNIVERSE_CACHE.items;
  }

  return triggerKospiUniverseRefresh();
}

async function resolveStockSymbol(input) {
  const normalized = normalizeStockInput(input);

  if (/^\d{6}\.(KS|KQ)$/.test(normalized)) {
    return normalized;
  }

  if (/^\d{6}$/.test(normalized)) {
    return `${normalized}.KS`;
  }

  try {
    const matched = await searchKospiStocks(normalized, 1);
    if (matched.length > 0) {
      return matched[0].symbol;
    }
  } catch (error) {
    // Fallback to Yahoo search.
  }

  const searchURL = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
    normalized
  )}&quotesCount=10&newsCount=0`;
  const searchData = await fetchJSON(searchURL);
  const quotes = Array.isArray(searchData?.quotes) ? searchData.quotes : [];
  const korean = quotes.find((item) => typeof item.symbol === "string" && /(\.KS|\.KQ)$/.test(item.symbol));

  if (korean?.symbol) {
    return korean.symbol;
  }

  throw new Error("종목 코드를 찾지 못했습니다. 6자리 종목코드를 입력해 주세요.");
}

function scoreStockSearchResult(query, code, symbol, name) {
  const normalizedQuery = query.toUpperCase();
  const normalizedName = String(name ?? "").toUpperCase();

  if (code === normalizedQuery || symbol === normalizedQuery) {
    return 0;
  }

  if (normalizedName === normalizedQuery) {
    return 1;
  }

  if (code.startsWith(normalizedQuery)) {
    return 2;
  }

  if (normalizedName.startsWith(normalizedQuery)) {
    return 3;
  }

  if (normalizedName.includes(normalizedQuery)) {
    return 4;
  }

  return 5;
}

async function searchKospiStocksByNaverFrontApi(query, limit) {
  const size = clampNumber(limit * 4, 20, 100);
  const url = `https://m.stock.naver.com/front-api/search?q=${encodeURIComponent(
    query
  )}&target=stock&size=${size}&page=1`;
  const data = await fetchJSON(url);
  const items = Array.isArray(data?.result?.items) ? data.result.items : [];
  const seen = new Set();
  const matched = [];

  for (const item of items) {
    const code = String(item?.code ?? item?.reutersCode ?? "").trim();
    if (!/^\d{6}$/.test(code)) {
      continue;
    }

    const typeCode = String(item?.typeCode ?? "").toUpperCase();
    if (typeCode && typeCode !== "KOSPI") {
      continue;
    }

    if (seen.has(code)) {
      continue;
    }

    const name = String(item?.name ?? code).trim();
    const symbol = `${code}.KS`;
    seen.add(code);
    matched.push({
      code,
      name,
      symbol,
      market: "KOSPI",
      exchangeName: String(item?.typeName ?? "KOSPI"),
      score: scoreStockSearchResult(query.toUpperCase(), code, symbol, name)
    });
  }

  matched.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name, "ko"));
  return matched.slice(0, limit).map(({ score, ...rest }) => rest);
}

async function searchKospiStocks(query, limit = 8) {
  const trimmed = String(query ?? "").trim();
  if (!trimmed) {
    return [];
  }

  const normalizedQuery = trimmed.toUpperCase();

  try {
    const direct = await searchKospiStocksByNaverFrontApi(trimmed, limit);
    if (direct.length > 0) {
      return direct;
    }
  } catch (error) {
    // Try next fallback.
  }

  try {
    const universe = await getKospiUniverse();
    const matched = [];

    for (const item of universe) {
      const code = item.code;
      const symbol = item.symbol;
      const name = item.name;
      const normalizedName = name.toUpperCase();

      if (!code.includes(normalizedQuery) && !normalizedName.includes(normalizedQuery)) {
        continue;
      }

      matched.push({
        ...item,
        score: scoreStockSearchResult(normalizedQuery, code, symbol, name)
      });
    }

    matched.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name, "ko"));
    return matched.slice(0, limit).map(({ score, ...rest }) => rest);
  } catch (error) {
    const quotesCount = clampNumber(limit * 4, 20, 80);
    const searchURL = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
      trimmed
    )}&quotesCount=${quotesCount}&newsCount=0`;
    const searchData = await fetchJSON(searchURL);
    const quotes = Array.isArray(searchData?.quotes) ? searchData.quotes : [];
    const seen = new Set();
    const matched = [];

    for (const item of quotes) {
      const symbol = String(item?.symbol ?? "");
      if (!/^\d{6}\.KS$/.test(symbol)) {
        continue;
      }

      const code = symbol.slice(0, 6);
      if (seen.has(code)) {
        continue;
      }

      const name = String(item?.shortname ?? item?.longname ?? item?.name ?? code).trim();
      seen.add(code);
      matched.push({
        symbol,
        code,
        market: "KOSPI",
        name,
        exchangeName: String(item?.exchDisp ?? item?.exchange ?? "KOSPI"),
        score: scoreStockSearchResult(normalizedQuery, code, symbol, name)
      });
    }

    matched.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name, "ko"));
    return matched.slice(0, limit).map(({ score, ...rest }) => rest);
  }
}

async function getYahooQuote(symbols) {
  const quoteURL = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(
    symbols.join(",")
  )}`;
  const quoteData = await fetchJSON(quoteURL);
  return Array.isArray(quoteData?.quoteResponse?.result) ? quoteData.quoteResponse.result : [];
}

async function getYahooSummary(symbol) {
  const modules = ["price", "summaryDetail", "defaultKeyStatistics", "financialData"];
  const summaryURL = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
    symbol
  )}?modules=${modules.join(",")}`;
  const summaryData = await fetchJSON(summaryURL);
  return summaryData?.quoteSummary?.result?.[0] ?? null;
}

function parseNaverInfoMap(integration) {
  const infos = Array.isArray(integration?.totalInfos) ? integration.totalInfos : [];
  return infos.reduce((acc, info) => {
    if (info?.code) {
      acc[info.code] = info.value;
    }
    return acc;
  }, {});
}

function mapNaverStockToQuote({ code, basic, integration, asking }) {
  const infoMap = parseNaverInfoMap(integration);
  const topSell = Array.isArray(asking?.sellInfo) && asking.sellInfo.length ? asking.sellInfo[0] : null;
  const topBuy = Array.isArray(asking?.buyInfos) && asking.buyInfos.length ? asking.buyInfos[0] : null;

  return {
    symbol: `${code}.KS`,
    shortName: basic?.stockName ?? integration?.stockName ?? code,
    longName: basic?.stockName ?? integration?.stockName ?? code,
    exchangeName: basic?.stockExchangeName ?? "KOSPI",
    currency: "KRW",
    marketState: basic?.marketStatus ?? "UNKNOWN",
    marketTime: basic?.localTradedAt ? new Date(basic.localTradedAt).toISOString() : null,
    price: parseLooseNumber(basic?.closePrice),
    change: parseLooseNumber(basic?.compareToPreviousClosePrice),
    changePercent: parseLooseNumber(basic?.fluctuationsRatio),
    bid: parseLooseNumber(topBuy?.price),
    ask: parseLooseNumber(topSell?.price),
    bidSize: parseLooseNumber(topBuy?.count),
    askSize: parseLooseNumber(topSell?.count),
    dayHigh: parseLooseNumber(infoMap.highPrice),
    dayLow: parseLooseNumber(infoMap.lowPrice),
    open: parseLooseNumber(infoMap.openPrice),
    previousClose: parseLooseNumber(infoMap.lastClosePrice),
    volume: parseLooseNumber(infoMap.accumulatedTradingVolume),
    marketCap: infoMap.marketValue ?? null,
    trailingPE: parseLooseNumber(infoMap.per),
    epsTtm: parseLooseNumber(infoMap.eps),
    fiftyTwoWeekHigh: parseLooseNumber(infoMap.highPriceOf52Weeks),
    fiftyTwoWeekLow: parseLooseNumber(infoMap.lowPriceOf52Weeks)
  };
}

function mapNaverStockFundamentals(integration, summary) {
  const infoMap = parseNaverInfoMap(integration);

  return {
    marketCap: infoMap.marketValue ?? null,
    foreignRate: infoMap.foreignRate ?? null,
    per: infoMap.per ?? null,
    eps: infoMap.eps ?? null,
    cnsPer: infoMap.cnsPer ?? null,
    cnsEps: infoMap.cnsEps ?? null,
    pbr: infoMap.pbr ?? null,
    bps: infoMap.bps ?? null,
    dividendYield: infoMap.dividendYieldRatio ?? null,
    dividend: infoMap.dividend ?? null,
    summaryEpsTitle: summary?.chartEps?.trTitleList?.at?.(-1)?.title ?? null
  };
}

function mapNaverInsights(integration, asking) {
  const sellLevelsRaw = Array.isArray(asking?.sellInfo) ? asking.sellInfo.slice(0, 5) : [];
  const buyLevelsRaw = Array.isArray(asking?.buyInfos) ? asking.buyInfos.slice(0, 5) : [];
  const dealTrendRaw = Array.isArray(integration?.dealTrendInfos) ? integration.dealTrendInfos : [];

  const mapOrderLevel = (level) => ({
    price: parseLooseNumber(level?.price),
    count: parseLooseNumber(level?.count),
    rate: parseLooseNumber(level?.rate)
  });

  const investorTrend = dealTrendRaw.slice(0, 12).map((item) => ({
    bizdate: item?.bizdate ?? null,
    closePrice: parseLooseNumber(item?.closePrice),
    change: parseLooseNumber(item?.compareToPreviousClosePrice),
    foreignerNet: parseLooseNumber(item?.foreignerPureBuyQuant),
    organNet: parseLooseNumber(item?.organPureBuyQuant),
    individualNet: parseLooseNumber(item?.individualPureBuyQuant),
    foreignerHoldRatio: item?.foreignerHoldRatio ?? null,
    volume: parseLooseNumber(item?.accumulatedTradingVolume)
  }));

  return {
    orderBook: {
      totalSell: parseLooseNumber(asking?.totalSell),
      totalBuy: parseLooseNumber(asking?.totalBuy),
      middlePrice: parseLooseNumber(asking?.middleInfo?.price),
      middleSellCount: parseLooseNumber(asking?.middleInfo?.sellCount),
      middleBuyCount: parseLooseNumber(asking?.middleInfo?.buyCount),
      sellLevels: sellLevelsRaw.map((level) => mapOrderLevel(level)),
      buyLevels: buyLevelsRaw.map((level) => mapOrderLevel(level))
    },
    investorTrend
  };
}

function mapNaverHistoryPoint(item) {
  const date = String(item?.localTradedAt ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return null;
  }

  const close = parseLooseNumber(item?.closePrice);
  if (close === null) {
    return null;
  }

  const timestamp = new Date(`${date}T00:00:00+09:00`).getTime();
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return {
    date,
    timestamp,
    open: parseLooseNumber(item?.openPrice),
    high: parseLooseNumber(item?.highPrice),
    low: parseLooseNumber(item?.lowPrice),
    close,
    change: parseLooseNumber(item?.compareToPreviousClosePrice),
    changePercent: parseLooseNumber(item?.fluctuationsRatio),
    volume: parseLooseNumber(item?.accumulatedTradingVolume)
  };
}

function summarizeHistoryPoints(points) {
  if (!Array.isArray(points) || !points.length) {
    return null;
  }

  const first = points[0];
  const last = points.at(-1);
  const firstClose = first?.close;
  const lastClose = last?.close;
  const change =
    typeof firstClose === "number" && typeof lastClose === "number" ? lastClose - firstClose : null;
  const changePercent =
    typeof change === "number" && typeof firstClose === "number" && firstClose !== 0 ? (change / firstClose) * 100 : null;

  const highs = points
    .map((point) => point.high)
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  const lows = points
    .map((point) => point.low)
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  const volumes = points
    .map((point) => point.volume)
    .filter((value) => typeof value === "number" && Number.isFinite(value));

  return {
    from: first?.date ?? null,
    to: last?.date ?? null,
    firstClose: typeof firstClose === "number" ? firstClose : null,
    lastClose: typeof lastClose === "number" ? lastClose : null,
    change,
    changePercent,
    high: highs.length ? Math.max(...highs) : null,
    low: lows.length ? Math.min(...lows) : null,
    totalVolume: volumes.length ? volumes.reduce((sum, value) => sum + value, 0) : null
  };
}

async function fetchNaverStockHistory(code) {
  const encodedCode = encodeURIComponent(code);
  const pageSize = 60;
  const url = `https://m.stock.naver.com/api/stock/${encodedCode}/price?pageSize=${pageSize}&page=1`;
  const rows = await fetchJSON(url);
  const parsed = Array.isArray(rows) ? rows.map((row) => mapNaverHistoryPoint(row)).filter(Boolean) : [];

  parsed.sort((a, b) => a.timestamp - b.timestamp);

  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - 31);
  const cutoffTs = cutoff.getTime();

  let points = parsed.filter((point) => point.timestamp >= cutoffTs);
  if (points.length < 10) {
    points = parsed.slice(-22);
  }

  const normalizedPoints = points.map(({ timestamp, ...rest }) => rest);

  return {
    source: "NAVER",
    symbol: `${code}.KS`,
    range: "1m",
    points: normalizedPoints,
    summary: summarizeHistoryPoints(normalizedPoints)
  };
}

async function fetchNaverStock(code) {
  const encodedCode = encodeURIComponent(code);
  const base = "https://m.stock.naver.com/api/stock";

  const [basic, integration, asking, summary] = await Promise.all([
    fetchJSON(`${base}/${encodedCode}/basic`),
    fetchJSON(`${base}/${encodedCode}/integration`),
    fetchJSON(`${base}/${encodedCode}/askingPrice`),
    fetchJSON(`${base}/${encodedCode}/finance/summary`)
  ]);

  return {
    source: "NAVER",
    symbol: `${code}.KS`,
    quote: mapNaverStockToQuote({ code, basic, integration, asking }),
    fundamentals: mapNaverStockFundamentals(integration, summary),
    insights: mapNaverInsights(integration, asking),
    raw: {
      basic,
      integration,
      asking
    }
  };
}

function pickRaw(value) {
  if (value && typeof value === "object" && "raw" in value) {
    return value.raw;
  }

  return value ?? null;
}

function mapYahooQuote(quote) {
  if (!quote) {
    return null;
  }

  return {
    symbol: quote.symbol,
    shortName: quote.shortName,
    longName: quote.longName,
    exchangeName: quote.fullExchangeName ?? quote.exchange,
    currency: quote.currency,
    marketState: quote.marketState,
    marketTime: quote.regularMarketTime ? new Date(quote.regularMarketTime * 1000).toISOString() : null,
    price: quote.regularMarketPrice ?? null,
    change: quote.regularMarketChange ?? null,
    changePercent: quote.regularMarketChangePercent ?? null,
    bid: quote.bid ?? null,
    ask: quote.ask ?? null,
    bidSize: quote.bidSize ?? null,
    askSize: quote.askSize ?? null,
    dayHigh: quote.regularMarketDayHigh ?? null,
    dayLow: quote.regularMarketDayLow ?? null,
    open: quote.regularMarketOpen ?? null,
    previousClose: quote.regularMarketPreviousClose ?? null,
    volume: quote.regularMarketVolume ?? null,
    marketCap: quote.marketCap ?? null,
    trailingPE: quote.trailingPE ?? null,
    epsTtm: quote.epsTrailingTwelveMonths ?? null,
    fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh ?? null,
    fiftyTwoWeekLow: quote.fiftyTwoWeekLow ?? null
  };
}

function mapYahooFundamentals(summary) {
  if (!summary) {
    return null;
  }

  const price = summary.price ?? {};
  const detail = summary.summaryDetail ?? {};
  const stats = summary.defaultKeyStatistics ?? {};
  const finance = summary.financialData ?? {};

  return {
    marketCap: pickRaw(price.marketCap),
    foreignRate: null,
    per: pickRaw(detail.trailingPE),
    eps: pickRaw(stats.trailingEps),
    cnsPer: null,
    cnsEps: null,
    pbr: pickRaw(stats.priceToBook),
    bps: pickRaw(stats.bookValue),
    dividendYield: pickRaw(detail.dividendYield),
    dividend: pickRaw(detail.dividendRate),
    recommendation: finance.recommendationKey ?? null,
    recommendationMean: pickRaw(finance.recommendationMean),
    targetPriceMean: pickRaw(finance.targetMeanPrice)
  };
}

async function fetchYahooStock(symbolInput) {
  const symbol = await resolveStockSymbol(symbolInput);
  const quote = (await getYahooQuote([symbol]))[0] ?? null;
  const summary = await getYahooSummary(symbol);

  return {
    source: "YAHOO",
    symbol,
    quote: mapYahooQuote(quote),
    fundamentals: mapYahooFundamentals(summary),
    insights: null
  };
}

async function fetchStockSnapshot(input) {
  const code = await resolveStockCode(input);

  if (code) {
    try {
      return await fetchNaverStock(code);
    } catch (error) {
      // Fallback to Yahoo only if Naver path fails.
    }
  }

  return fetchYahooStock(input);
}

async function fetchNaverIndex(code) {
  const base = "https://m.stock.naver.com/api/index";
  const basic = await fetchJSON(`${base}/${encodeURIComponent(code)}/basic`);

  return {
    symbol: basic?.itemCode ?? code,
    shortName: basic?.stockName ?? code,
    longName: basic?.stockName ?? code,
    exchangeName: "KRX",
    currency: "KRW",
    marketState: basic?.marketStatus ?? "UNKNOWN",
    marketTime: basic?.localTradedAt ? new Date(basic.localTradedAt).toISOString() : null,
    price: parseLooseNumber(basic?.closePrice),
    change: parseLooseNumber(basic?.compareToPreviousClosePrice),
    changePercent: parseLooseNumber(basic?.fluctuationsRatio),
    source: "NAVER"
  };
}

function parseStooqCsvRow(line) {
  const fields = line.split(",");
  if (fields.length < 7) {
    return null;
  }

  const [symbol, date, time, open, high, low, close, volume] = fields;

  if (date === "N/D") {
    return null;
  }

  const openNum = parseLooseNumber(open);
  const closeNum = parseLooseNumber(close);
  const change = openNum !== null && closeNum !== null ? closeNum - openNum : null;
  const changePercent =
    openNum !== null && closeNum !== null && openNum !== 0 ? ((closeNum - openNum) / openNum) * 100 : null;

  return {
    symbol,
    shortName: symbol,
    longName: symbol,
    exchangeName: "STOOQ",
    currency: symbol.includes("USDKRW") ? "KRW" : "USD",
    marketState: "LIVE",
    marketTime: `${date}${time ? `T${time}` : ""}`,
    price: closeNum,
    change,
    changePercent,
    dayHigh: parseLooseNumber(high),
    dayLow: parseLooseNumber(low),
    open: openNum,
    volume: parseLooseNumber(volume),
    source: "STOOQ"
  };
}

async function fetchStooqQuotes(symbols) {
  const query = symbols.join(",");
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(query)}&i=1`;
  const text = await fetchText(url, {
    ...DEFAULT_HEADERS,
    Accept: "text/plain,*/*"
  });

  const rows = text
    .trim()
    .split(/\r?\n/)
    .map((line) => parseStooqCsvRow(line))
    .filter(Boolean);

  return rows;
}

function getKstParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: KST_TIME_ZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short"
  });

  const parts = formatter.formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday
  };
}

function getKrxSession() {
  const nowParts = getKstParts(new Date());
  const isWeekend = nowParts.weekday === "Sat" || nowParts.weekday === "Sun";

  if (isWeekend) {
    return {
      sessionCode: "WEEKEND_CLOSED",
      sessionLabel: "주말 휴장",
      nextEvent: "다음 영업일 08:30 동시호가 시작"
    };
  }

  const minutes = nowParts.hour * 60 + nowParts.minute;

  if (minutes < 8 * 60 + 30) {
    return {
      sessionCode: "BEFORE_OPEN",
      sessionLabel: "장 시작 전",
      nextEvent: "08:30 시가 동시호가"
    };
  }

  if (minutes < 9 * 60) {
    return {
      sessionCode: "PRE_OPEN_CALL_AUCTION",
      sessionLabel: "시가 동시호가",
      nextEvent: "09:00 정규장 시작"
    };
  }

  if (minutes < 15 * 60 + 20) {
    return {
      sessionCode: "REGULAR_TRADING",
      sessionLabel: "정규장 진행 중",
      nextEvent: "15:20 종가 동시호가"
    };
  }

  if (minutes < 15 * 60 + 30) {
    return {
      sessionCode: "CLOSE_CALL_AUCTION",
      sessionLabel: "종가 동시호가",
      nextEvent: "15:30 정규장 종료"
    };
  }

  if (minutes < 16 * 60) {
    return {
      sessionCode: "AFTER_HOURS_CLOSING",
      sessionLabel: "시간외 종가 매매",
      nextEvent: "16:00 시간외 단일가"
    };
  }

  if (minutes < 18 * 60) {
    return {
      sessionCode: "AFTER_HOURS_SINGLE_PRICE",
      sessionLabel: "시간외 단일가",
      nextEvent: "18:00 장 종료"
    };
  }

  return {
    sessionCode: "CLOSED",
    sessionLabel: "장 마감",
    nextEvent: "다음 영업일 08:30 동시호가 시작"
  };
}

function parseRssItems(xmlText) {
  const items = [];
  const regex = /<item>([\s\S]*?)<\/item>/g;

  for (const match of xmlText.matchAll(regex)) {
    const block = match[1];

    const readTag = (tag) => {
      const found = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
      return found ? decodeXml(found[1].trim()) : "";
    };

    const link = readTag("link").replace(/&amp;/g, "&");

    items.push({
      title: stripHtml(readTag("title")),
      link,
      source: stripHtml(readTag("source")),
      publishedAt: readTag("pubDate")
    });
  }

  return items;
}

async function getGoogleNews({ query, hl, gl, ceid, limit = 12 }) {
  const cacheKey = buildGoogleNewsCacheKey({ query, hl, gl, ceid, limit });
  return getOrLoadTimedCache({
    cache: GOOGLE_NEWS_CACHE,
    key: cacheKey,
    ttlMs: GOOGLE_NEWS_CACHE_TTL_MS,
    maxEntries: GOOGLE_NEWS_CACHE_MAX_ENTRIES,
    valueField: "items",
    load: async () => {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${encodeURIComponent(
        hl
      )}&gl=${encodeURIComponent(gl)}&ceid=${encodeURIComponent(ceid)}`;
      const xml = await fetchText(url);
      return parseRssItems(xml)
        .filter((item) => item.title && item.link)
        .slice(0, limit);
    }
  });
}

async function handleQuote(response, url) {
  const requested = url.searchParams.get("symbol") ?? DEFAULT_STOCK;
  const cached = await getOrLoadTimedCache({
    cache: STOCK_SNAPSHOT_CACHE,
    key: buildStockSnapshotCacheKey(requested),
    ttlMs: STOCK_SNAPSHOT_CACHE_TTL_MS,
    maxEntries: STOCK_SNAPSHOT_CACHE_MAX_ENTRIES,
    valueField: "snapshotPayload",
    load: async () => ({
      snapshot: await fetchStockSnapshot(requested),
      fetchedAt: new Date().toISOString()
    })
  });
  const snapshot = cached.snapshot;

  toJSON(response, 200, {
    requestedSymbol: requested,
    symbol: snapshot.symbol,
    source: snapshot.source,
    fetchedAt: cached.fetchedAt,
    quote: snapshot.quote,
    fundamentals: snapshot.fundamentals,
    insights: snapshot.insights ?? null
  });
}

async function handleStockHistory(response, url) {
  const requested = url.searchParams.get("symbol") ?? DEFAULT_STOCK;
  const code = await resolveStockCode(requested);

  if (!code) {
    throw new Error("종목 코드를 찾지 못했습니다. 6자리 종목코드 또는 종목명을 입력해 주세요.");
  }

  const history = await getOrLoadTimedCache({
    cache: STOCK_HISTORY_CACHE,
    key: code,
    ttlMs: STOCK_HISTORY_CACHE_TTL_MS,
    maxEntries: STOCK_HISTORY_CACHE_MAX_ENTRIES,
    valueField: "historyPayload",
    load: () => fetchNaverStockHistory(code)
  });

  toJSON(response, 200, {
    requestedSymbol: requested,
    symbol: history.symbol,
    source: history.source,
    range: history.range,
    fetchedAt: new Date().toISOString(),
    points: history.points,
    summary: history.summary
  });
}

async function handleStockSearch(response, url) {
  const query = url.searchParams.get("q") ?? "";
  const limit = clampNumber(parseLooseNumber(url.searchParams.get("limit")) ?? 8, 1, 20);
  const cached = await getOrLoadTimedCache({
    cache: STOCK_SEARCH_CACHE,
    key: buildStockSearchCacheKey(query, limit),
    ttlMs: STOCK_SEARCH_CACHE_TTL_MS,
    maxEntries: STOCK_SEARCH_CACHE_MAX_ENTRIES,
    valueField: "searchPayload",
    load: async () => ({
      items: await searchKospiStocks(query, limit),
      fetchedAt: new Date().toISOString()
    })
  });

  toJSON(response, 200, {
    fetchedAt: cached.fetchedAt,
    query,
    limit,
    items: cached.items
  });
}

async function fetchMarketOverviewPayload() {
  const [kospi, kosdaq, kpi200] = await Promise.all([
    fetchNaverIndex("KOSPI"),
    fetchNaverIndex("KOSDAQ"),
    fetchNaverIndex("KPI200")
  ]);

  let stooq = [];
  try {
    stooq = await fetchStooqQuotes(["USDKRW", "^SPX", "^DJI", "^NDQ", "CL.F", "GC.F"]);
  } catch (error) {
    stooq = [];
  }

  return {
    fetchedAt: new Date().toISOString(),
    overview: [kospi, kosdaq, kpi200, ...stooq],
    notes: {
      domestic: "네이버 실시간 지수",
      global: "STOOQ 기준(변동률은 시가 대비)"
    }
  };
}

async function handleMarketOverview(response) {
  const payload = await getOrLoadTimedCache({
    cache: MARKET_OVERVIEW_CACHE,
    key: "market-overview:v1",
    ttlMs: MARKET_OVERVIEW_CACHE_TTL_MS,
    maxEntries: MARKET_OVERVIEW_CACHE_MAX_ENTRIES,
    valueField: "overviewPayload",
    load: fetchMarketOverviewPayload
  });

  toJSON(response, 200, payload);
}

async function handleKrxInfo(response) {
  const now = new Date();
  const session = getKrxSession();

  toJSON(response, 200, {
    fetchedAt: now.toISOString(),
    timezone: KST_TIME_ZONE,
    nowKst: new Intl.DateTimeFormat("ko-KR", {
      timeZone: KST_TIME_ZONE,
      dateStyle: "full",
      timeStyle: "medium"
    }).format(now),
    market: {
      marketName: "KRX 유가증권시장(KOSPI)",
      regularSession: "월~금 09:00~15:30 (KST)",
      preOpenCallAuction: "08:30~09:00 (KST)",
      closeCallAuction: "15:20~15:30 (KST)",
      afterHoursClosePrice: "15:40~16:00 (KST)",
      afterHoursSinglePrice: "16:00~18:00 (KST)"
    },
    currentSession: session
  });
}

async function handleKoreaNews(response) {
  const news = await getGoogleNews({
    query: "한국 증시 OR 코스피 OR 코스닥",
    hl: "ko",
    gl: "KR",
    ceid: "KR:ko",
    limit: 14
  });

  toJSON(response, 200, {
    fetchedAt: new Date().toISOString(),
    topic: "한국 주요 증시 뉴스",
    items: news
  });
}

async function handleStockNews(response, url) {
  const requested = url.searchParams.get("symbol") ?? DEFAULT_STOCK;
  const explicitKeyword = String(url.searchParams.get("keyword") ?? "").trim();
  let symbol = requested;
  let stockName = explicitKeyword || requested;

  if (!explicitKeyword) {
    let snapshot;
    try {
      snapshot = await fetchStockSnapshot(requested);
    } catch (error) {
      snapshot = {
        symbol: requested,
        quote: {
          shortName: requested
        }
      };
    }

    symbol = snapshot?.symbol ?? requested;
    stockName = snapshot?.quote?.longName ?? snapshot?.quote?.shortName ?? requested;
  }

  const symbolText = String(symbol).replace(/\.KS$|\.KQ$/i, "").trim();
  const keyword = explicitKeyword || `${stockName} 주식`;

  const news = await getGoogleNews({
    query: `${keyword} OR ${symbolText}`,
    hl: "ko",
    gl: "KR",
    ceid: "KR:ko",
    limit: 14
  });

  toJSON(response, 200, {
    fetchedAt: new Date().toISOString(),
    requestedSymbol: requested,
    symbol,
    stockName,
    keyword,
    items: news
  });
}

async function handleGlobalNews(response) {
  const news = await getGoogleNews({
    query: "(Fed OR US Treasury OR oil prices OR China economy) AND Korea market",
    hl: "en-US",
    gl: "US",
    ceid: "US:en",
    limit: 14
  });

  toJSON(response, 200, {
    fetchedAt: new Date().toISOString(),
    topic: "한국 시장 영향 해외 뉴스",
    items: news
  });
}

async function handleLiveTv(response) {
  const channels = [
    {
      name: "SBS Biz",
      channelId: "UCbMjg2EvXs_RUGW-KrdM3pw"
    },
    {
      name: "연합뉴스TV",
      channelId: "UCTHCOPwqNfZ0uiKOvFyhGwg"
    },
    {
      name: "매일경제TV",
      channelId: "UCnfwIKyFYRuqZzzKBDt6JOA"
    },
    {
      name: "한국경제TV뉴스",
      channelId: "UC7cF2ZYvGm_zgrX-xCV88mA"
    }
  ];

  const streams = channels.map((channel) => ({
    name: channel.name,
    embedUrl: `https://www.youtube.com/embed/live_stream?channel=${channel.channelId}&autoplay=0&mute=1`,
    livePage: `https://www.youtube.com/channel/${channel.channelId}/live`
  }));

  toJSON(response, 200, {
    fetchedAt: new Date().toISOString(),
    streams
  });
}

const API_ROUTE_MAP = new Map([
  ["/api/search/stocks", (response, url) => handleStockSearch(response, url)],
  ["/api/stock/history", (response, url) => handleStockHistory(response, url)],
  ["/api/quote", (response, url) => handleQuote(response, url)],
  ["/api/market-overview", (response) => handleMarketOverview(response)],
  ["/api/krx/info", (response) => handleKrxInfo(response)],
  ["/api/news/korea", (response) => handleKoreaNews(response)],
  ["/api/news/stock", (response, url) => handleStockNews(response, url)],
  ["/api/news/global", (response) => handleGlobalNews(response)],
  ["/api/tv/live", (response) => handleLiveTv(response)]
]);

async function handleAPI(response, url) {
  const handler = API_ROUTE_MAP.get(url.pathname);
  if (!handler) {
    return false;
  }

  await handler(response, url);
  return true;
}

function parseRequestUrl(request) {
  const forwardedProto = String(request.headers["x-forwarded-proto"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .find(Boolean);
  const protocol = forwardedProto || "http";
  const host = request.headers.host || `${HOST}:${PORT}`;
  return new URL(request.url || "/", `${protocol}://${host}`);
}

async function serveStatic(response, url) {
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const normalizedPath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, normalizedPath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    toError(response, 403, "Forbidden");
    return;
  }

  try {
    const content = await readFile(filePath);
    const extension = extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[extension] ?? "application/octet-stream";

    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": extension === ".html" ? "no-store" : "public, max-age=60"
    });
    response.end(content);
  } catch (error) {
    toError(response, 404, "Not found");
  }
}

export async function handleRequest(request, response) {
  let url;
  try {
    url = parseRequestUrl(request);
  } catch {
    toError(response, 400, "Invalid request URL");
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    if (activeApiRequests >= API_MAX_CONCURRENT_REQUESTS) {
      toError(response, 503, "Server is busy. Please retry shortly.");
      return;
    }

    if (isRateLimited(request)) {
      toError(response, 429, "Too many requests. Please retry later.");
      return;
    }

    activeApiRequests += 1;
    try {
      const handled = await handleAPI(response, url);

      if (!handled) {
        toError(response, 404, "Unknown API path");
      }
    } catch (error) {
      toError(response, 502, error instanceof Error ? error.message : "Data source error");
    } finally {
      activeApiRequests = Math.max(0, activeApiRequests - 1);
    }

    return;
  }

  await serveStatic(response, url);
}

export default handleRequest;

const isDirectRun = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const server = createServer(handleRequest);
  server.listen(PORT, HOST, () => {
    console.log(`KOSPI dashboard server is running on http://${HOST}:${PORT}`);
  });
}
