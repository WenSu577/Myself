const BASE_URL = 'https://open.steamdt.com';
const INDEX_URL = `${BASE_URL}/open/cs2/broad/v1/index`;
const KLINE_URL = `${BASE_URL}/open/cs2/broad/v1/kline`;
const CACHE_KEY = 'steamdt:broad-widget:last-good';

export default async function(ctx) {
  const apiKey = (ctx.env.STEAMDT_API_KEY || ctx.env.API_KEY || '').trim();
  const klineType = Number(ctx.env.KLINE_TYPE || 1);
  const refreshMinutes = Number(ctx.env.REFRESH_MINUTES || 15);

  if (!apiKey) {
    return messageWidget('SteamDT API Key 未配置', '请在 Widget env 中添加 STEAMDT_API_KEY。');
  }

  try {
    const data = await loadBroadData(ctx, apiKey, klineType);
    ctx.storage.setJSON(CACHE_KEY, { data, cachedAt: Date.now() });
    return renderWidget(ctx, data, refreshMinutes, false);
  } catch (error) {
    const cached = ctx.storage.getJSON(CACHE_KEY);
    if (cached && cached.data) {
      return renderWidget(ctx, cached.data, refreshMinutes, true);
    }
    return messageWidget('SteamDT 大盘加载失败', String(error && error.message ? error.message : error));
  }
}

async function loadBroadData(ctx, apiKey, klineType) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  const [indexJson, klineJson] = await Promise.all([
    requestJSON(ctx, 'GET', INDEX_URL, headers),
    requestJSON(ctx, 'POST', KLINE_URL, headers, { type: klineType }),
  ]);

  if (!indexJson.success) {
    throw new Error(indexJson.errorMsg || '指数接口返回失败');
  }
  if (!klineJson.success) {
    throw new Error(klineJson.errorMsg || 'K线接口返回失败');
  }

  const index = indexJson.data || {};
  const kline = normalizeKlineList(klineJson.data || index.historyMarketIndexList || []);
  const last = lastItem(kline);
  const prev = kline.length > 1 ? kline[kline.length - 2] : null;

  const current = numberOr(index.broadMarketIndex, last && last.close);
  const hourDiff = last && prev ? last.close - prev.close : null;
  const hourRate = last && prev && prev.close ? (hourDiff / prev.close) * 100 : null;
  const high = kline.length ? Math.max(...kline.map((item) => item.high).filter(isFiniteNumber)) : null;
  const low = kline.length ? Math.min(...kline.map((item) => item.low).filter(isFiniteNumber)) : null;

  return {
    current,
    updateTime: normalizeTime(index.updateTime || (last && last.time)),
    diffYesterday: numberOr(index.diffYesterday, null),
    diffYesterdayRatio: numberOr(index.diffYesterdayRatio, null),
    hourDiff,
    hourRate,
    high: isFiniteNumber(high) ? high : null,
    low: isFiniteNumber(low) ? low : null,
    points: kline.slice(-12),
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
  const list = Array.isArray(raw) ? raw.flat(2).filter((item) => item && typeof item === 'object') : [];
  return list
    .map(normalizeKlinePoint)
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);
}

function normalizeKlinePoint(item) {
  if (Array.isArray(item)) {
    const nums = item.map((value) => Number(value));
    const time = nums[0];
    const open = numberOr(nums[1], nums[2]);
    const close = numberOr(nums[2], nums[1]);
    const low = numberOr(nums[3], Math.min(open, close));
    const high = numberOr(nums[4], Math.max(open, close));
    if (!isFiniteNumber(close)) return null;
    return { time, open, close, low, high };
  }

  const close = numberOr(item.close, item.c, item.index, item.value, item.price, item.marketIndex);
  if (!isFiniteNumber(close)) return null;

  const open = numberOr(item.open, item.o, close);
  const high = numberOr(item.high, item.h, Math.max(open, close));
  const low = numberOr(item.low, item.l, Math.min(open, close));
  const time = numberOr(item.time, item.timestamp, item.updateTime, item.date, 0);
  return { time, open, close, high, low };
}

function renderWidget(ctx, data, refreshMinutes, stale) {
  const compact = ctx.widgetFamily === 'systemSmall' || ctx.widgetFamily === 'accessoryRectangular';
  const positive = data.diffYesterdayRatio >= 0;
  const accent = positive ? '#FF4D5E' : '#20C787';
  const softAccent = positive ? '#FFE8EB' : '#DFF8EC';

  if (ctx.widgetFamily === 'accessoryInline') {
    return {
      type: 'widget',
      children: [{
        type: 'text',
        text: `CS2大盘 ${fmt(data.current)} ${signedPct(data.diffYesterdayRatio)}`,
      }],
    };
  }

  if (ctx.widgetFamily === 'accessoryRectangular') {
    return {
      type: 'widget',
      padding: 8,
      url: 'https://www.steamdt.com/section?type=BROAD',
      children: [
        row('CS2大盘', signedPct(data.diffYesterdayRatio), '#FFFFFF', accent),
        {
          type: 'text',
          text: fmt(data.current),
          font: { size: 24, weight: 'bold', family: 'Menlo' },
          textColor: '#FFFFFF',
          maxLines: 1,
          minScale: 0.6,
        },
      ],
      backgroundColor: '#151821',
      gap: 4,
    };
  }

  return {
    type: 'widget',
    padding: compact ? 14 : 16,
    gap: compact ? 8 : 10,
    url: 'https://www.steamdt.com/section?type=BROAD',
    backgroundGradient: {
      type: 'linear',
      colors: ['#11151C', '#1F2937'],
      startPoint: { x: 0, y: 0 },
      endPoint: { x: 1, y: 1 },
    },
    refreshAfter: new Date(Date.now() + refreshMinutes * 60 * 1000).toISOString(),
    children: [
      header(stale),
      {
        type: 'text',
        text: fmt(data.current),
        font: { size: compact ? 32 : 38, weight: 'bold', family: 'Menlo' },
        textColor: '#FFFFFF',
        maxLines: 1,
        minScale: 0.55,
      },
      row('较昨日', `${signed(data.diffYesterday)}  ${signedPct(data.diffYesterdayRatio)}`, '#AAB3C2', accent),
      row('时K变化', `${signed(data.hourDiff)}  ${signedPct(data.hourRate)}`, '#AAB3C2', colorBy(data.hourRate)),
      compact ? sparkline(data.points, accent, softAccent, 34) : statGrid(data, accent, softAccent),
      {
        type: 'spacer',
      },
      {
        type: 'text',
        text: data.updateTime ? `更新 ${data.updateTime}` : 'SteamDT OpenAPI',
        font: { size: 'caption2' },
        textColor: '#7F8A9B',
        maxLines: 1,
        minScale: 0.8,
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
      { type: 'text', text: stale ? 'CS2饰品大盘 · 缓存' : 'CS2饰品大盘', font: { size: 'caption1', weight: 'semibold' }, textColor: '#DCE5F2' },
      { type: 'spacer' },
      { type: 'text', text: 'SteamDT', font: { size: 'caption2', weight: 'medium' }, textColor: '#7F8A9B' },
    ],
  };
}

function statGrid(data, accent, softAccent) {
  return {
    type: 'stack',
    direction: 'column',
    gap: 8,
    children: [
      sparkline(data.points, accent, softAccent, 42),
      {
        type: 'stack',
        direction: 'row',
        gap: 8,
        children: [
          statCard('K高', fmt(data.high), '#2B3443'),
          statCard('K低', fmt(data.low), '#2B3443'),
        ],
      },
    ],
  };
}

function statCard(label, value, color) {
  return {
    type: 'stack',
    direction: 'column',
    gap: 2,
    flex: 1,
    padding: [8, 10],
    backgroundColor: color,
    borderRadius: 8,
    children: [
      { type: 'text', text: label, font: { size: 'caption2' }, textColor: '#AAB3C2' },
      { type: 'text', text: value, font: { size: 'caption1', weight: 'semibold', family: 'Menlo' }, textColor: '#FFFFFF', maxLines: 1, minScale: 0.75 },
    ],
  };
}

function sparkline(points, accent, softAccent, height) {
  const values = (points || []).map((item) => item.close).filter(isFiniteNumber);
  if (values.length < 2) {
    return { type: 'spacer', length: height };
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const bars = values.map((value) => {
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
          height: Math.max(4, Math.round(8 + ratio * (height - 8))),
          backgroundColor: value >= values[0] ? accent : softAccent,
          borderRadius: 2,
          children: [],
        },
      ],
    };
  });

  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'end',
    gap: 3,
    height,
    children: bars,
  };
}

function row(label, value, labelColor, valueColor) {
  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    gap: 6,
    children: [
      { type: 'text', text: label, font: { size: 'caption1', weight: 'medium' }, textColor: labelColor },
      { type: 'spacer' },
      { type: 'text', text: value, font: { size: 'caption1', weight: 'semibold', family: 'Menlo' }, textColor: valueColor, maxLines: 1, minScale: 0.7 },
    ],
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
  return Number(value) >= 0 ? '#FF4D5E' : '#20C787';
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
