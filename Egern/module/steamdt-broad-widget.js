const BASE_URL = 'https://open.steamdt.com';
const INDEX_URL = `${BASE_URL}/open/cs2/broad/v1/index`;
const KLINE_URL = `${BASE_URL}/open/cs2/broad/v1/kline`;
const CACHE_KEY = 'steamdt:broad-widget:last-good';

export default async function(ctx) {
  const apiKey = String(ctx.env.STEAMDT_API_KEY || ctx.env.API_KEY || '').trim();
  const klineType = Number(ctx.env.KLINE_TYPE || 1);
  const refreshMinutes = Number(ctx.env.REFRESH_MINUTES || 15);

  if (!apiKey) {
    return messageWidget('缺少 SteamDT API Key', '请在小组件环境变量中添加 API_KEY。');
  }

  try {
    const data = await loadMarketData(ctx, apiKey, klineType);
    ctx.storage.setJSON(CACHE_KEY, { data, cachedAt: Date.now() });
    return renderWidget(ctx, data, refreshMinutes, false);
  } catch (error) {
    const cached = ctx.storage.getJSON(CACHE_KEY);
    if (cached && cached.data) {
      return renderWidget(ctx, cached.data, refreshMinutes, true);
    }
    return messageWidget('SteamDT 加载失败', String(error && error.message ? error.message : error));
  }
}

async function loadMarketData(ctx, apiKey, klineType) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  const [indexJson, klineJson, publicSnapshot] = await Promise.all([
    requestJSON(ctx, 'GET', INDEX_URL, headers).catch((error) => ({ success: false, error })),
    requestJSON(ctx, 'POST', KLINE_URL, headers, { type: klineType }),
    loadPublicSnapshot(ctx).catch(() => null),
  ]);

  if (!indexJson.success && !publicSnapshot) throw new Error(indexJson.errorMsg || 'index api returned false');
  if (!klineJson.success) throw new Error(klineJson.errorMsg || 'kline api returned false');

  const index = indexJson.success ? (indexJson.data || {}) : {};
  const points = normalizeKlineList(klineJson.data || index.historyMarketIndexList || publicSnapshot.points || []);
  const last = lastItem(points);
  const prev = points.length > 1 ? points[points.length - 2] : null;

  const currentIndex = numberOr(index.broadMarketIndex, index.index, index.value, publicSnapshot && publicSnapshot.index, last && last.close);
  const prevIndex = numberOr(index.yesterdayBroadMarketIndex, index.yesterdayIndex, index.lastIndex, publicSnapshot && publicSnapshot.yesterdayIndex, prev && prev.close);
  const indexChange = calcChange(
    currentIndex,
    prevIndex,
    index.diffYesterday,
    index.diffYesterdayRatio,
    publicSnapshot && publicSnapshot.riseFallDiff,
    publicSnapshot && publicSnapshot.riseFallRate,
  );

  const currentK = last ? last.close : currentIndex;
  const prevK = prev ? prev.close : prevIndex;
  const kChange = calcChange(currentK, prevK);

  const currentAmount = numberOr(
    publicSnapshot && publicSnapshot.transactionAmount,
    index.transactionAmount,
    index.transactionAmt,
    index.turnover,
    index.volumeAmount,
    index.amount,
    last && last.amount,
    publicSnapshot && publicSnapshot.homeTurnover,
  );
  const prevAmount = numberOr(
    index.lastTransactionAmount,
    index.yesterdayTransactionAmount,
    index.yesterdayAmount,
    prev && prev.amount,
  );
  const amountChange = calcChange(
    currentAmount,
    prevAmount,
    index.transactionAmountDiff,
    publicSnapshot && publicSnapshot.transactionAmountRate,
    index.amountDiff,
    index.amountRate,
  );

  return {
    currentIndex,
    currentAmount,
    indexChange,
    kChange,
    amountChange,
    mood: buildMarketMood(publicSnapshot),
    updateTime: normalizeTime(index.updateTime || (publicSnapshot && publicSnapshot.updateTime) || (last && last.time)),
    points: points.slice(-24),
  };
}

async function requestJSON(ctx, method, url, headers, body) {
  const options = { headers, timeout: 10000 };
  if (body !== undefined) options.body = body;
  const resp = method === 'POST'
    ? await ctx.http.post(url, options)
    : await ctx.http.get(url, options);
  return await resp.json();
}

async function loadPublicSnapshot(ctx) {
  const [sectionResp, homeResp] = await Promise.all([
    ctx.http.get('https://www.steamdt.com/section?type=BROAD', { timeout: 10000 }),
    ctx.http.get('https://www.steamdt.com', { timeout: 10000 }).catch(() => null),
  ]);
  const section = parseSteamdtSsrBroad(await responseText(sectionResp));
  const home = homeResp ? parseSteamdtHomeSnapshot(await responseText(homeResp)) : null;
  return Object.assign({}, section || {}, home || {});
}

async function responseText(resp) {
  if (!resp) return '';
  if (typeof resp.text === 'function') return await resp.text();
  if (typeof resp.body === 'string') return resp.body;
  if (typeof resp.rawBody === 'string') return resp.rawBody;
  if (resp.data && typeof resp.data === 'string') return resp.data;
  return '';
}

function parseSteamdtSsrBroad(text) {
  const match = text.match(/<script[^>]+id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;

  try {
    const table = JSON.parse(match[1]);
    const broad = findObjectWithKey(table, 'transactionAmount', new Set());
    if (!broad) return null;
    return materializeDevalueObject(table, broad);
  } catch (_) {
    return null;
  }
}

function parseSteamdtHomeSnapshot(text) {
  const match = text.match(/<script[^>]+id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;

  try {
    const table = JSON.parse(match[1]);
    const market = findObjectWithKey(table, 'tradeAmountRatio', new Set());
    if (!market) return null;
    const data = materializeDevalueObject(table, market);
    return {
      homeTurnover: numberOr(data.turnover, null),
      transactionAmountRate: numberOr(data.tradeAmountRatio, null),
    };
  } catch (_) {
    return null;
  }
}

function findObjectWithKey(value, key, seen) {
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);

  if (!Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, key)) {
    return value;
  }

  const items = Array.isArray(value) ? value : Object.values(value);
  for (const item of items) {
    const found = findObjectWithKey(item, key, seen);
    if (found) return found;
  }

  return null;
}

function materializeDevalueObject(table, obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = derefDevalueValue(table, value);
  }
  return out;
}

function derefDevalueValue(table, value) {
  if (typeof value !== 'number') return value;
  const target = table[value];
  if (target === null || ['string', 'number', 'boolean'].includes(typeof target)) return target;
  return value;
}

function normalizeKlineList(raw) {
  return collectKlinePoints(raw)
    .map(normalizeKlinePoint)
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);
}

function collectKlinePoints(raw) {
  if (!raw) return [];
  if (!Array.isArray(raw) && typeof raw === 'object') {
    return collectObjectKlinePoints(raw, 0);
  }
  if (!Array.isArray(raw)) return [];
  const result = [];

  for (const item of raw) {
    if (!item) continue;
    if (Array.isArray(item)) {
      const tuple = item.length >= 2 && item.some((value) => Number.isFinite(Number(value)));
      if (tuple) result.push(item);
      else result.push(...collectKlinePoints(item));
    } else if (typeof item === 'object') {
      result.push(item);
    }
  }

  return result;
}

function collectObjectKlinePoints(raw, depth) {
  if (!raw || depth > 6) return [];

  const result = [];
  if (hasKlineValue(raw)) result.push(raw);

  for (const value of Object.values(raw)) {
    if (Array.isArray(value)) {
      result.push(...collectKlinePoints(value));
    } else if (value && typeof value === 'object') {
      result.push(...collectObjectKlinePoints(value, depth + 1));
    }
  }

  return result;
}

function hasKlineValue(item) {
  return ['close', 'c', 'index', 'value', 'marketIndex', 'broadMarketIndex'].some((key) => isFiniteNumber(item[key]));
}

function normalizeKlinePoint(item) {
  if (Array.isArray(item)) {
    const nums = item.map((value) => Number(value));
    const time = nums[0] || 0;
    const open = numberOr(nums[1], nums[2]);
    const close = numberOr(nums[2], nums[1]);
    const high = numberOr(nums[3], Math.max(open, close));
    const low = numberOr(nums[4], Math.min(open, close));
    const amount = numberOr(nums[5], null);
    if (!isFiniteNumber(close)) return null;
    return { time, open, close, high, low, amount };
  }

  const close = numberOr(item.close, item.c, item.index, item.value, item.marketIndex, item.broadMarketIndex);
  if (!isFiniteNumber(close)) return null;

  return {
    time: numberOr(item.time, item.timestamp, item.updateTime, item.date, 0),
    open: numberOr(item.open, item.o, close),
    close,
    high: numberOr(item.high, item.h, close),
    low: numberOr(item.low, item.l, close),
    amount: numberOr(item.transactionAmount, item.volumeAmount, item.amount, item.turnover, null),
  };
}

function renderWidget(ctx, data, refreshMinutes, stale) {
  const family = ctx.widgetFamily || 'systemMedium';
  const compact = family === 'systemSmall' || family === 'accessoryRectangular';
  const large = family === 'systemLarge' || family === 'systemExtraLarge';
  const indexColor = colorBy(data.indexChange.rate);
  const kColor = colorBy(data.kChange.rate);
  const amountColor = colorBy(data.amountChange.rate);

  if (family === 'accessoryInline') {
    return {
      type: 'widget',
      children: [{
        type: 'text',
        text: `CS2大盘 ${fmt(data.currentIndex)} ${signed(data.indexChange.diff)} ${signedPct(data.indexChange.rate)}`,
      }],
    };
  }

  if (family === 'accessoryRectangular') {
    return {
      type: 'widget',
      padding: 8,
      gap: 4,
      url: 'https://www.steamdt.com/section?type=BROAD',
      backgroundColor: '#151821',
      children: [
        row('指数', `${signed(data.indexChange.diff)} ${signedPct(data.indexChange.rate)}`, '#DCE5F2', indexColor),
        valueText(fmt(data.currentIndex), 24),
        row('成交额', shortMoney(data.currentAmount), '#AAB3C2', '#FFFFFF'),
      ],
    };
  }

  return {
    type: 'widget',
    padding: compact ? 14 : 16,
    gap: compact ? 8 : 10,
    url: 'https://www.steamdt.com/section?type=BROAD',
    backgroundGradient: {
      type: 'linear',
      colors: ['#10141B', '#1B2430'],
      startPoint: { x: 0, y: 0 },
      endPoint: { x: 1, y: 1 },
    },
    refreshAfter: new Date(Date.now() + refreshMinutes * 60 * 1000).toISOString(),
    children: [
      header(stale),
      indexBlock(data, compact, indexColor),
      chartBlock(data.points, indexColor, large ? 92 : compact ? 58 : 76),
      metricRow(klineLabel(data.points), data.kChange, kColor),
      row('饰品成交额', `${shortMoney(data.currentAmount)}  ${signedPct(data.amountChange.rate)}`, '#AAB3C2', amountColor),
      marketMoodRow(data.mood),
      { type: 'spacer' },
      {
        type: 'text',
        text: data.updateTime ? `更新 ${data.updateTime}` : 'SteamDT OpenAPI',
        font: { size: 'caption2' },
        textColor: '#7F8A9B',
        maxLines: 1,
      },
    ],
  };
}

function header(stale) {
  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    gap: 6,
    children: [
      { type: 'image', src: 'sf-symbol:chart.line.uptrend.xyaxis', color: '#8AB4FF', width: 16, height: 16 },
      { type: 'text', text: stale ? 'CS2 大盘 · 缓存' : 'CS2 大盘', font: { size: 'caption1', weight: 'semibold' }, textColor: '#DCE5F2' },
      { type: 'spacer' },
      { type: 'text', text: 'SteamDT', font: { size: 'caption2', weight: 'medium' }, textColor: '#7F8A9B' },
    ],
  };
}

function indexBlock(data, compact, color) {
  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'end',
    gap: 8,
    children: [
      valueText(fmt(data.currentIndex), compact ? 34 : 42),
      {
        type: 'stack',
        direction: 'column',
        alignItems: 'end',
        gap: 2,
        padding: [0, 0, 4, 0],
        children: [
          {
            type: 'text',
            text: signed(data.indexChange.diff),
            font: { size: 'caption2', weight: 'bold', family: 'Menlo' },
            textColor: color,
            maxLines: 1,
          },
          {
            type: 'text',
            text: signedPct(data.indexChange.rate),
            font: { size: 'caption1', weight: 'bold', family: 'Menlo' },
            textColor: color,
            maxLines: 1,
          },
        ],
      },
    ],
  };
}

function chartBlock(points, color, height) {
  return {
    type: 'stack',
    direction: 'column',
    gap: 5,
    children: [
      {
        type: 'text',
        text: '大盘走势',
        font: { size: 'caption2', weight: 'medium' },
        textColor: '#7F8A9B',
        maxLines: 1,
      },
      trendBars(points, color, height),
    ],
  };
}

function metricRow(label, change, color) {
  return row(label, `${signed(change.diff)}  ${signedPct(change.rate)}`, '#AAB3C2', color);
}

function marketMoodRow(mood) {
  if (!mood || !mood.total) {
    return row('市场情绪', '未取到', '#AAB3C2', '#DCE5F2');
  }
  return row('市场情绪', `${mood.label}  ${mood.upPct}%↑ / ${mood.downPct}%↓`, '#AAB3C2', mood.color);
}

function buildMarketMood(snapshot) {
  if (!snapshot) return null;
  const up = numberOr(snapshot.upNum, null);
  const flat = numberOr(snapshot.flatNum, null);
  const down = numberOr(snapshot.downNum, null);
  const total = (up || 0) + (flat || 0) + (down || 0);
  if (!total) return null;

  const upPct = Math.round((up / total) * 100);
  const downPct = Math.round((down / total) * 100);
  const spread = upPct - downPct;
  let label = '均衡';
  let color = '#8AB4FF';

  if (spread >= 8) {
    label = '偏强';
    color = '#FF4D5E';
  } else if (spread <= -8) {
    label = '偏弱';
    color = '#20C787';
  }

  return { label, color, up, flat, down, total, upPct, downPct };
}

function trendBars(points, color, height) {
  const items = (points || []).filter((item) => isFiniteNumber(item.close));
  const values = items.map((item) => Number(item.close));
  if (items.length < 2) {
    return {
      type: 'text',
      text: '暂无走势数据',
      font: { size: 'caption1' },
      textColor: '#7F8A9B',
      height,
    };
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'end',
    gap: 2,
    height,
    backgroundColor: '#182231',
    borderRadius: 8,
    padding: [7, 8],
    children: items.map((item) => {
      const value = Number(item.close);
      const ratio = (value - min) / span;
      const barHeight = Math.max(4, Math.round(6 + ratio * (height - 20)));
      const rising = Number(item.close) >= Number(item.open);
      return {
        type: 'stack',
        direction: 'column',
        flex: 1,
        height: height - 14,
        children: [
          { type: 'spacer' },
          {
            type: 'stack',
            height: barHeight,
            backgroundColor: rising ? '#FF4D5E' : '#20C787',
            borderRadius: 2,
            children: [{ type: 'spacer' }],
          },
        ],
      };
    }),
  };
}

function row(label, value, labelColor, valueColor) {
  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    gap: 6,
    children: [
      { type: 'text', text: label, font: { size: 'caption1', weight: 'medium' }, textColor: labelColor, maxLines: 1, minScale: 0.7 },
      { type: 'spacer' },
      { type: 'text', text: value, font: { size: 'caption1', weight: 'semibold', family: 'Menlo' }, textColor: valueColor, maxLines: 1, minScale: 0.62 },
    ],
  };
}

function valueText(text, size) {
  return {
    type: 'text',
    text,
    font: { size, weight: 'bold', family: 'Menlo' },
    textColor: '#FFFFFF',
    maxLines: 1,
    minScale: 0.55,
  };
}

function messageWidget(title, detail) {
  return {
    type: 'widget',
    padding: 16,
    gap: 8,
    backgroundColor: '#151821',
    children: [
      { type: 'text', text: title, font: { size: 'headline', weight: 'bold' }, textColor: '#FFFFFF' },
      { type: 'text', text: detail, font: { size: 'caption1' }, textColor: '#AAB3C2', maxLines: 3 },
    ],
  };
}

function calcChange(current, previous, apiDiff, apiRate, fallbackDiff, fallbackRate) {
  const diff = numberOr(apiDiff, fallbackDiff, current !== null && previous !== null ? current - previous : null);
  const rate = numberOr(apiRate, fallbackRate, previous ? (diff / previous) * 100 : null);
  return { diff, rate };
}

function klineLabel(points) {
  const last = lastItem(points);
  const prev = points && points.length > 1 ? points[points.length - 2] : null;
  if (!last || !prev) return 'K线环比';

  const delta = Math.abs(Number(last.time) - Number(prev.time));
  if (delta >= 20 * 60 * 60 * 1000 || delta >= 20 * 60 * 60) return '日K环比';
  return '时K环比';
}

function numberOr(...values) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function isFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

function lastItem(list) {
  return list && list.length ? list[list.length - 1] : null;
}

function colorBy(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '#DCE5F2';
  return num >= 0 ? '#FF4D5E' : '#20C787';
}

function fmt(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '--';
  return num.toFixed(2);
}

function signed(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '--';
  return `${num >= 0 ? '+' : ''}${num.toFixed(2)}`;
}

function signedPct(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '--';
  return `${num >= 0 ? '+' : ''}${num.toFixed(2)}%`;
}

function shortMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '未取到';
  if (Math.abs(num) >= 100000000) return `¥${trim(num / 100000000)}亿`;
  if (Math.abs(num) >= 10000) return `¥${trim(num / 10000)}万`;
  return `¥${trim(num)}`;
}

function trim(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '--';
  return num >= 100 ? num.toFixed(0) : num >= 10 ? num.toFixed(1) : num.toFixed(2);
}

function normalizeTime(value) {
  if (!value) return '';
  const num = Number(value);
  const date = Number.isFinite(num)
    ? new Date(num < 10000000000 ? num * 1000 : num)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  const pad = (part) => String(part).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
