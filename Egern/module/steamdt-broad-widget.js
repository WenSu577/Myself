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

  const [indexJson, klineJson] = await Promise.all([
    requestJSON(ctx, 'GET', INDEX_URL, headers),
    requestJSON(ctx, 'POST', KLINE_URL, headers, { type: klineType }),
  ]);

  if (!indexJson.success) throw new Error(indexJson.errorMsg || 'index api returned false');
  if (!klineJson.success) throw new Error(klineJson.errorMsg || 'kline api returned false');

  const index = indexJson.data || {};
  const points = normalizeKlineList(klineJson.data || index.historyMarketIndexList || []);
  const last = lastItem(points);
  const prev = points.length > 1 ? points[points.length - 2] : null;

  const currentIndex = numberOr(index.broadMarketIndex, index.index, index.value, last && last.close);
  const prevIndex = numberOr(index.yesterdayBroadMarketIndex, index.yesterdayIndex, index.lastIndex, prev && prev.close);
  const indexChange = calcChange(
    currentIndex,
    prevIndex,
    index.diffYesterday,
    index.diffYesterdayRatio,
    index.riseFallDiff,
    index.riseFallRate,
  );

  const currentK = last ? last.close : currentIndex;
  const prevK = prev ? prev.close : prevIndex;
  const kChange = calcChange(currentK, prevK);

  const currentAmount = numberOr(index.transactionAmount, index.volumeAmount, index.amount, last && last.amount);
  const prevAmount = numberOr(index.lastTransactionAmount, index.yesterdayTransactionAmount, prev && prev.amount);
  const amountChange = calcChange(
    currentAmount,
    prevAmount,
    index.transactionAmountDiff,
    index.transactionAmountRate,
    index.amountDiff,
    index.amountRate,
  );

  return {
    currentIndex,
    currentAmount,
    indexChange,
    kChange,
    amountChange,
    updateTime: normalizeTime(index.updateTime || (last && last.time)),
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

function normalizeKlineList(raw) {
  return collectKlinePoints(raw)
    .map(normalizeKlinePoint)
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);
}

function collectKlinePoints(raw) {
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

function normalizeKlinePoint(item) {
  if (Array.isArray(item)) {
    const nums = item.map((value) => Number(value));
    const time = nums[0] || 0;
    const open = numberOr(nums[1], nums[2]);
    const close = numberOr(nums[2], nums[1]);
    const high = numberOr(nums[4], Math.max(open, close));
    const low = numberOr(nums[3], Math.min(open, close));
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
      row('实时成交额', shortMoney(data.currentAmount), '#AAB3C2', '#FFFFFF'),
      metricRow('成交额环比', data.amountChange, amountColor),
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
      trendLine(points, color, height),
    ],
  };
}

function metricRow(label, change, color) {
  return row(label, `${signed(change.diff)}  ${signedPct(change.rate)}`, '#AAB3C2', color);
}

function trendLine(points, color, height) {
  const values = (points || []).map((item) => item.close).filter(isFiniteNumber);
  if (values.length < 2) {
    return { type: 'spacer', length: height };
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const baseline = values[0];

  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'end',
    gap: 2,
    height,
    children: values.map((value) => {
      const ratio = (value - min) / span;
      return {
        type: 'stack',
        direction: 'column',
        flex: 1,
        height,
        children: [
          { type: 'spacer' },
          {
            type: 'stack',
            height: Math.max(4, Math.round(6 + ratio * (height - 6))),
            backgroundColor: value >= baseline ? color : '#3B4453',
            borderRadius: 2,
            children: [],
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
  if (!Number.isFinite(num)) return '--';
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
