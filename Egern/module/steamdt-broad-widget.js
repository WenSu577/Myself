const BASE_URL = 'https://open.steamdt.com';
const INDEX_URL = `${BASE_URL}/open/cs2/broad/v1/index`;
const KLINE_URL = `${BASE_URL}/open/cs2/broad/v1/kline`;
const CACHE_KEY = 'steamdt:broad-widget:last-good';

export default async function(ctx) {
  const apiKey = String(ctx.env.STEAMDT_API_KEY || ctx.env.API_KEY || '').trim();
  const klineType = Number(ctx.env.KLINE_TYPE || 1);
  const refreshMinutes = Number(ctx.env.REFRESH_MINUTES || 15);

  if (!apiKey) {
    return messageWidget('SteamDT API Key missing', 'Add STEAMDT_API_KEY or API_KEY in widget env.');
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
    return messageWidget('SteamDT load failed', String(error && error.message ? error.message : error));
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
    throw new Error(indexJson.errorMsg || 'index api returned false');
  }
  if (!klineJson.success) {
    throw new Error(klineJson.errorMsg || 'kline api returned false');
  }

  const index = indexJson.data || {};
  const kline = normalizeKlineList(klineJson.data || index.historyMarketIndexList || []);
  const last = lastItem(kline);
  const prev = kline.length > 1 ? kline[kline.length - 2] : null;

  const current = numberOr(index.broadMarketIndex, index.index, index.value, last && last.close);
  const yesterday = numberOr(index.yesterdayBroadMarketIndex, index.yesterdayIndex, index.lastIndex);
  const diffYesterday = numberOr(
    index.diffYesterday,
    index.riseFallDiff,
    current !== null && yesterday !== null ? current - yesterday : null,
  );
  const diffYesterdayRatio = numberOr(
    index.diffYesterdayRatio,
    index.riseFallRate,
    yesterday ? (diffYesterday / yesterday) * 100 : null,
  );

  const hourDiff = last && prev ? last.close - prev.close : null;
  const hourRate = last && prev && prev.close ? (hourDiff / prev.close) * 100 : null;
  const hourAmountDiff = last && prev && last.amount !== null && prev.amount !== null ? last.amount - prev.amount : null;
  const hourAmountRate = last && prev && prev.amount ? (hourAmountDiff / prev.amount) * 100 : null;
  const amount = numberOr(index.transactionAmount, index.volumeAmount, index.amount, last && last.amount);
  const count = numberOr(index.transactionCount, index.volumeCount, index.count, last && last.count);
  const high = numberOr(index.highIndex, maxOf(kline, 'high'));
  const low = numberOr(index.lowIndex, minOf(kline, 'low'));
  const upNum = numberOr(index.upNum, index.riseNum, index.upCount);
  const flatNum = numberOr(index.flatNum, index.equalNum, index.flatCount);
  const downNum = numberOr(index.downNum, index.fallNum, index.downCount);
  const breadthTotal = [upNum, flatNum, downNum].reduce((sum, value) => sum + (Number(value) || 0), 0);

  return {
    current,
    yesterday,
    diffYesterday,
    diffYesterdayRatio,
    hourDiff,
    hourRate,
    amount,
    count,
    hourAmountDiff,
    hourAmountRate,
    high,
    low,
    upNum,
    flatNum,
    downNum,
    breadthTotal,
    updateTime: normalizeTime(index.updateTime || (last && last.time)),
    points: kline.slice(-16),
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
  const list = collectKlinePoints(raw);
  return list
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
      const looksLikeTuple = item.length >= 2 && item.some((value) => Number.isFinite(Number(value)));
      if (looksLikeTuple) {
        result.push(item);
      } else {
        result.push(...collectKlinePoints(item));
      }
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
    const low = numberOr(nums[3], Math.min(open, close));
    const high = numberOr(nums[4], Math.max(open, close));
    const amount = numberOr(nums[5], null);
    const count = numberOr(nums[6], null);
    if (!isFiniteNumber(close)) return null;
    return { time, open, close, low, high, amount, count };
  }

  const close = numberOr(item.close, item.c, item.index, item.value, item.price, item.marketIndex, item.broadMarketIndex);
  if (!isFiniteNumber(close)) return null;

  const open = numberOr(item.open, item.o, close);
  const high = numberOr(item.high, item.h, Math.max(open, close));
  const low = numberOr(item.low, item.l, Math.min(open, close));
  const time = numberOr(item.time, item.timestamp, item.updateTime, item.date, 0);
  const amount = numberOr(item.transactionAmount, item.volumeAmount, item.amount, item.turnover, null);
  const count = numberOr(item.transactionCount, item.volumeCount, item.count, null);
  return { time, open, close, high, low, amount, count };
}

function renderWidget(ctx, data, refreshMinutes, stale) {
  const family = ctx.widgetFamily || 'systemMedium';
  const compact = family === 'systemSmall' || family === 'accessoryRectangular';
  const large = family === 'systemLarge' || family === 'systemExtraLarge';
  const positive = Number(data.diffYesterdayRatio) >= 0;
  const accent = positive ? '#FF4D5E' : '#20C787';
  const softAccent = positive ? '#5C2630' : '#1E4C3A';

  if (family === 'accessoryInline') {
    return {
      type: 'widget',
      children: [{
        type: 'text',
        text: `CS2 ${fmt(data.current)} ${signedPct(data.diffYesterdayRatio)} Amt ${shortMoney(data.amount)}`,
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
        row('CS2', signedPct(data.diffYesterdayRatio), '#FFFFFF', accent),
        {
          type: 'text',
          text: fmt(data.current),
          font: { size: 24, weight: 'bold', family: 'Menlo' },
          textColor: '#FFFFFF',
          maxLines: 1,
          minScale: 0.6,
        },
        row('Amt', shortMoney(data.amount), '#AAB3C2', '#DCE5F2'),
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
      indexLine(data, compact, accent),
      row('vs Yesterday', `${signed(data.diffYesterday)}  ${signedPct(data.diffYesterdayRatio)}`, '#AAB3C2', accent),
      row('Hourly K', `${signed(data.hourDiff)}  ${signedPct(data.hourRate)}`, '#AAB3C2', colorBy(data.hourRate)),
      volumeLine(data),
      compact ? compactDetails(data, accent, softAccent) : detailPanel(data, accent, softAccent, large),
      { type: 'spacer' },
      {
        type: 'text',
        text: data.updateTime ? `Updated ${data.updateTime}` : 'SteamDT OpenAPI',
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
      { type: 'text', text: stale ? 'CS2 Market · cached' : 'CS2 Market', font: { size: 'caption1', weight: 'semibold' }, textColor: '#DCE5F2' },
      { type: 'spacer' },
      { type: 'text', text: 'SteamDT', font: { size: 'caption2', weight: 'medium' }, textColor: '#7F8A9B' },
    ],
  };
}

function indexLine(data, compact, accent) {
  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'end',
    gap: 8,
    children: [
      {
        type: 'text',
        text: fmt(data.current),
        font: { size: compact ? 32 : 38, weight: 'bold', family: 'Menlo' },
        textColor: '#FFFFFF',
        maxLines: 1,
        minScale: 0.55,
      },
      {
        type: 'text',
        text: signedPct(data.diffYesterdayRatio),
        font: { size: 'caption1', weight: 'bold', family: 'Menlo' },
        textColor: accent,
        maxLines: 1,
      },
    ],
  };
}

function volumeLine(data) {
  const amountMomentum = data.hourAmountRate === null
    ? shortMoney(data.amount)
    : `${shortMoney(data.amount)}  ${signedPct(data.hourAmountRate)} HoH`;
  return row('Turnover', amountMomentum, '#AAB3C2', colorBy(data.hourAmountRate));
}

function compactDetails(data, accent, softAccent) {
  return {
    type: 'stack',
    direction: 'column',
    gap: 8,
    children: [
      sparkline(data.points, accent, softAccent, 34),
      row('Breadth', breadthText(data), '#AAB3C2', '#DCE5F2'),
    ],
  };
}

function detailPanel(data, accent, softAccent, large) {
  const children = [
    sparkline(data.points, accent, softAccent, large ? 54 : 42),
    {
      type: 'stack',
      direction: 'row',
      gap: 8,
      children: [
        statCard('Trades', shortNumber(data.count), '#263243'),
        statCard('High', fmt(data.high), '#263243'),
        statCard('Low', fmt(data.low), '#263243'),
      ],
    },
    breadthBar(data, accent),
  ];

  if (large) {
    children.push({
      type: 'stack',
      direction: 'row',
      gap: 8,
      children: [
        statCard('Yesterday', fmt(data.yesterday), '#263243'),
        statCard('Amt HoH', signedPct(data.hourAmountRate), '#263243'),
        statCard('K Diff', signed(data.hourDiff), '#263243'),
      ],
    });
  }

  return {
    type: 'stack',
    direction: 'column',
    gap: 8,
    children,
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
      { type: 'text', text: label, font: { size: 'caption2' }, textColor: '#AAB3C2', maxLines: 1, minScale: 0.75 },
      { type: 'text', text: value, font: { size: 'caption1', weight: 'semibold', family: 'Menlo' }, textColor: '#FFFFFF', maxLines: 1, minScale: 0.68 },
    ],
  };
}

function breadthBar(data) {
  const total = Number(data.breadthTotal) || 0;
  if (!total) {
    return row('Breadth', '--', '#AAB3C2', '#DCE5F2');
  }

  const upFlex = Math.max(1, Number(data.upNum) || 0);
  const flatFlex = Math.max(1, Number(data.flatNum) || 0);
  const downFlex = Math.max(1, Number(data.downNum) || 0);
  return {
    type: 'stack',
    direction: 'column',
    gap: 5,
    children: [
      row('Breadth', breadthText(data), '#AAB3C2', '#DCE5F2'),
      {
        type: 'stack',
        direction: 'row',
        height: 7,
        gap: 3,
        children: [
          { type: 'stack', flex: upFlex, backgroundColor: '#FF4D5E', borderRadius: 4, children: [] },
          { type: 'stack', flex: flatFlex, backgroundColor: '#8AB4FF', borderRadius: 4, children: [] },
          { type: 'stack', flex: downFlex, backgroundColor: '#20C787', borderRadius: 4, children: [] },
        ],
      },
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
  const start = values[0];
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
          backgroundColor: value >= start ? accent : softAccent,
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
      { type: 'text', text: label, font: { size: 'caption1', weight: 'medium' }, textColor: labelColor, maxLines: 1, minScale: 0.75 },
      { type: 'spacer' },
      { type: 'text', text: value, font: { size: 'caption1', weight: 'semibold', family: 'Menlo' }, textColor: valueColor, maxLines: 1, minScale: 0.66 },
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

function breadthText(data) {
  if (!data.breadthTotal) return '--';
  return `${shortNumber(data.upNum)} up · ${shortNumber(data.flatNum)} flat · ${shortNumber(data.downNum)} down`;
}

function numberOr(...values) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function maxOf(list, key) {
  const values = (list || []).map((item) => item[key]).filter(isFiniteNumber);
  return values.length ? Math.max(...values) : null;
}

function minOf(list, key) {
  const values = (list || []).map((item) => item[key]).filter(isFiniteNumber);
  return values.length ? Math.min(...values) : null;
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

function shortNumber(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '--';
  if (Math.abs(num) >= 100000000) return `${trim(num / 100000000)}e`;
  if (Math.abs(num) >= 10000) return `${trim(num / 10000)}w`;
  return trim(num);
}

function shortMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '--';
  return `¥${shortNumber(num)}`;
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
