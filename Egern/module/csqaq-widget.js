const BASE_URL = 'https://api.csqaq.com/api/v1';
const HOME_URL = `${BASE_URL}/current_data`;
const DETAIL_URL = `${BASE_URL}/sub_data`;
const KLINE_URL = `${BASE_URL}/sub/kline`;
const CACHE_KEY = 'csqaq:widget:last-good';

export default async function(ctx) {
  const apiToken = String(ctx.env.API_TOKEN || '').trim();
  const indexKey = String(ctx.env.CSQAQ_INDEX_KEY || 'init').trim();
  const indexId = String(ctx.env.CSQAQ_INDEX_ID || '').trim();
  const klineType = String(ctx.env.KLINE_TYPE || '1hour').trim();
  const refreshMinutes = Number(ctx.env.REFRESH_MINUTES || 15);

  try {
    const data = await loadCsqaqData(ctx, { apiToken, indexKey, indexId, klineType });
    ctx.storage.setJSON(CACHE_KEY, { data, cachedAt: Date.now() });
    return renderWidget(ctx, data, refreshMinutes, false);
  } catch (error) {
    const cached = ctx.storage.getJSON(CACHE_KEY);
    if (cached && cached.data) return renderWidget(ctx, cached.data, refreshMinutes, true);
    return messageWidget('CSQAQ 加载失败', String(error && error.message ? error.message : error));
  }
}

async function loadCsqaqData(ctx, options) {
  const currentJson = await requestJSON(ctx, `${HOME_URL}?type=${encodeURIComponent(options.indexKey)}`);
  if (!isSuccess(currentJson)) throw new Error(currentJson && currentJson.msg ? currentJson.msg : 'current_data 接口返回异常');

  const home = currentJson.data || {};
  const indexes = Array.isArray(home.sub_index_data) ? home.sub_index_data : [];
  const target = pickIndex(indexes, options.indexKey, options.indexId);
  if (!target) throw new Error('未找到目标指数');

  const id = numberOr(options.indexId, target.id);
  const [detailJson, klineJson] = await Promise.all([
    id ? requestFirstOptional(ctx, DETAIL_URL, [
      { id, type: options.klineType },
      { sub_id: id, type: options.klineType },
      { sub_index_id: id, type: options.klineType },
    ], options.apiToken) : Promise.resolve(null),
    id ? requestFirstOptional(ctx, KLINE_URL, [
      { id, type: options.klineType },
      { sub_id: id, type: options.klineType },
      { sub_index_id: id, type: options.klineType },
    ], options.apiToken) : Promise.resolve(null),
  ]);

  const detail = isSuccess(detailJson) ? (detailJson.data || {}) : {};
  const points = normalizeKlineList(klineJson && klineJson.data ? klineJson.data : detail);
  const publicPoint = normalizePublicPoint(target);
  const usablePoints = points.length ? points : publicPoint ? [publicPoint] : [];
  const last = lastItem(usablePoints);
  const prev = usablePoints.length > 1 ? usablePoints[usablePoints.length - 2] : null;

  const currentIndex = numberOr(target.market_index, target.close, detail.market_index, last && last.close);
  const indexChange = {
    diff: numberOr(target.chg_num, currentIndex !== null && target.open !== undefined ? currentIndex - Number(target.open) : null),
    rate: numberOr(target.chg_rate, target.open ? ((currentIndex - Number(target.open)) / Number(target.open)) * 100 : null),
  };
  const kChange = prev
    ? calcChange(last && last.close, prev.close)
    : { diff: indexChange.diff, rate: indexChange.rate };

  const marketMood = buildMarketMood(indexes);

  return {
    id,
    indexKey: target.name_key || options.indexKey,
    title: normalizeIndexName(target.name, target.name_key),
    currentIndex,
    open: numberOr(target.open, detail.open, last && last.open),
    close: numberOr(target.close, detail.close, last && last.close, currentIndex),
    high: numberOr(target.high, detail.high, last && last.high),
    low: numberOr(target.low, detail.low, last && last.low),
    indexChange,
    kChange,
    klineType: options.klineType,
    points: usablePoints.slice(-24),
    marketMood,
    focusIndexes: buildFocusIndexes(indexes),
    updateTime: normalizeTime(target.updated_at || detail.updated_at || (last && last.time)),
    enhanced: Boolean(points.length),
  };
}

async function requestOptional(ctx, url, params, apiToken) {
  try {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null && value !== '') query.set(key, value);
    }
    if (apiToken) query.set('API_TOKEN', apiToken);

    const headers = {};
    if (apiToken) {
      headers.API_TOKEN = apiToken;
    }

    const json = await requestJSON(ctx, `${url}?${query.toString()}`, headers);
    return json;
  } catch (_) {
    return null;
  }
}

async function requestFirstOptional(ctx, url, candidates, apiToken) {
  for (const params of candidates) {
    const json = await requestOptional(ctx, url, params, apiToken);
    if (isSuccess(json)) return json;
  }
  return null;
}

async function requestJSON(ctx, url, headers) {
  const resp = await ctx.http.get(url, { headers: headers || {}, timeout: 10000 });
  return await resp.json();
}

function isSuccess(json) {
  return json && (json.code === 200 || json.success === true || json.status === 200);
}

function pickIndex(indexes, indexKey, indexId) {
  const id = Number(indexId);
  if (Number.isFinite(id)) {
    const byId = indexes.find((item) => Number(item.id) === id);
    if (byId) return byId;
  }
  const byKey = indexes.find((item) => String(item.name_key || '') === indexKey);
  return byKey || indexes[0] || null;
}

function normalizePublicPoint(item) {
  if (!item) return null;
  const close = numberOr(item.close, item.market_index);
  if (!isFiniteNumber(close)) return null;
  return {
    time: item.updated_at || 0,
    open: numberOr(item.open, close),
    close,
    high: numberOr(item.high, Math.max(numberOr(item.open, close), close)),
    low: numberOr(item.low, Math.min(numberOr(item.open, close), close)),
  };
}

function normalizeKlineList(raw) {
  return collectKlinePoints(raw)
    .map(normalizeKlinePoint)
    .filter(Boolean)
    .sort((a, b) => timeValue(a.time) - timeValue(b.time));
}

function collectKlinePoints(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    const result = [];
    for (const item of raw) {
      if (!item) continue;
      if (Array.isArray(item)) result.push(item);
      else if (typeof item === 'object') result.push(...collectKlinePoints(item));
    }
    return result;
  }
  if (typeof raw !== 'object') return [];
  if (hasKlineValue(raw)) return [raw];

  const result = [];
  for (const value of Object.values(raw)) {
    if (value && (Array.isArray(value) || typeof value === 'object')) result.push(...collectKlinePoints(value));
  }
  return result;
}

function hasKlineValue(item) {
  return ['market_index', 'close', 'c', 'index', 'value'].some((key) => isFiniteNumber(item[key]));
}

function normalizeKlinePoint(item) {
  if (Array.isArray(item)) {
    const nums = item.map((value) => Number(value));
    const time = item[0];
    const open = numberOr(nums[1], nums[2]);
    const close = numberOr(nums[2], nums[1]);
    if (!isFiniteNumber(close)) return null;
    return {
      time,
      open,
      close,
      high: numberOr(nums[3], Math.max(open, close)),
      low: numberOr(nums[4], Math.min(open, close)),
      amount: numberOr(nums[5], null),
    };
  }

  const close = numberOr(item.close, item.c, item.market_index, item.index, item.value);
  if (!isFiniteNumber(close)) return null;
  return {
    time: item.time || item.timestamp || item.created_at || item.updated_at || item.date || 0,
    open: numberOr(item.open, item.o, close),
    close,
    high: numberOr(item.high, item.h, close),
    low: numberOr(item.low, item.l, close),
    amount: numberOr(item.amount, item.total_price, item.turnover, null),
  };
}

function buildMarketMood(indexes) {
  const items = Array.isArray(indexes) ? indexes : [];
  let up = 0;
  let flat = 0;
  let down = 0;

  for (const item of items) {
    const rate = numberOr(item.chg_rate, null);
    if (!isFiniteNumber(rate) || Math.abs(Number(rate)) < 0.005) flat += 1;
    else if (Number(rate) > 0) up += 1;
    else down += 1;
  }

  const count = up + flat + down;
  const upPct = count ? Math.round((up / count) * 100) : 0;
  const downPct = count ? Math.round((down / count) * 100) : 0;
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

  return { up, flat, down, count, upPct, downPct, label, color };
}

function buildFocusIndexes(indexes) {
  const list = Array.isArray(indexes) ? indexes : [];
  const keys = [
    ['手套指数', 'gloves'],
    ['收藏品指数', 'collection'],
    ['千战指数', 'thousand_weapon'],
    ['百战指数', 'main_weapon'],
    ['红皮指数', 'covert_weapon'],
  ];
  return keys.map(([label, key]) => {
    const item = list.find((entry) => String(entry.name_key || '') === key);
    return {
      label,
      key,
      value: item ? numberOr(item.market_index, item.close) : null,
      diff: item ? numberOr(item.chg_num, null) : null,
      rate: item ? numberOr(item.chg_rate, null) : null,
    };
  });
}

function renderWidget(ctx, data, refreshMinutes, stale) {
  const family = ctx.widgetFamily || 'systemMedium';
  const compact = family === 'systemSmall' || family === 'accessoryRectangular';
  const large = family === 'systemLarge' || family === 'systemExtraLarge';
  const indexColor = colorBy(data.indexChange.rate);
  const kColor = colorBy(data.kChange.rate);

  if (family === 'accessoryInline') {
    return {
      type: 'widget',
      children: [{
        type: 'text',
        text: `CSQAQ ${fmt(data.currentIndex)} ${signed(data.indexChange.diff)} ${signedPct(data.indexChange.rate)}`,
      }],
    };
  }

  if (family === 'accessoryRectangular') {
    return {
      type: 'widget',
      padding: 8,
      gap: 4,
      url: 'https://csqaq.com/home',
      backgroundColor: '#151821',
      children: [
        row(data.title, signedPct(data.indexChange.rate), '#DCE5F2', indexColor),
        valueText(fmt(data.currentIndex), 24),
        row('市场情绪', data.marketMood.label, '#AAB3C2', data.marketMood.color),
      ],
    };
  }

  return {
    type: 'widget',
    padding: compact ? 14 : 16,
    gap: compact ? 8 : 10,
    url: 'https://csqaq.com/home',
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
      chartBlock(data.points, indexColor, large ? 92 : compact ? 58 : 76, data.enhanced),
      metricRow(klineLabel(data.klineType), data.kChange, kColor),
      marketMoodRow(data.marketMood),
      focusIndexGrid(data.focusIndexes, compact),
      { type: 'spacer' },
      {
        type: 'text',
        text: data.updateTime ? `更新 ${data.updateTime}` : 'CSQAQ OpenAPI',
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
      { type: 'text', text: stale ? 'CSQAQ 饰品指数 · 缓存' : 'CSQAQ 饰品指数', font: { size: 'caption1', weight: 'semibold' }, textColor: '#DCE5F2' },
      { type: 'spacer' },
      { type: 'text', text: 'csqaq.com', font: { size: 'caption2', weight: 'medium' }, textColor: '#7F8A9B' },
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
          { type: 'text', text: signed(data.indexChange.diff), font: { size: 'caption2', weight: 'bold', family: 'Menlo' }, textColor: color, maxLines: 1 },
          { type: 'text', text: signedPct(data.indexChange.rate), font: { size: 'caption1', weight: 'bold', family: 'Menlo' }, textColor: color, maxLines: 1 },
        ],
      },
    ],
  };
}

function chartBlock(points, color, height, enhanced) {
  return {
    type: 'stack',
    direction: 'column',
    gap: 5,
    children: [
      {
        type: 'text',
        text: enhanced ? '指数走势' : '日内K线',
        font: { size: 'caption2', weight: 'medium' },
        textColor: '#7F8A9B',
        maxLines: 1,
      },
      trendBars(points, color, height, enhanced),
    ],
  };
}

function trendBars(points, color, height, enhanced) {
  const items = (points || []).filter((item) => isFiniteNumber(item.close));
  if (items.length < 2) {
    const item = items[0];
    return {
      type: 'stack',
      direction: 'column',
      gap: 5,
      height,
      backgroundColor: '#182231',
      borderRadius: 8,
      padding: [8, 10],
      children: [
        { type: 'text', text: enhanced ? '暂无走势数据' : '填写 API_TOKEN 后尝试加载完整K线', font: { size: 'caption2' }, textColor: '#7F8A9B', maxLines: 1, minScale: 0.7 },
        item ? singleCandle(item, height - 28) : { type: 'spacer' },
      ],
    };
  }

  const values = [];
  for (const item of items) values.push(Number(item.high), Number(item.low), Number(item.close), Number(item.open));
  const min = Math.min(...values.filter(Number.isFinite));
  const max = Math.max(...values.filter(Number.isFinite));
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
      const open = Number(item.open);
      const close = Number(item.close);
      const high = Number(item.high);
      const low = Number(item.low);
      const top = Math.max(open, close);
      const bottom = Math.min(open, close);
      const candleHeight = Math.max(4, Math.round(((top - bottom) / span) * (height - 18)));
      const wickHeight = Math.max(candleHeight, Math.round(((high - low) / span) * (height - 18)));
      const offset = Math.max(0, Math.round(((bottom - min) / span) * (height - 18)));
      const rising = close >= open;
      return {
        type: 'stack',
        direction: 'column',
        flex: 1,
        height: height - 14,
        children: [
          { type: 'spacer' },
          {
            type: 'stack',
            height: wickHeight + offset,
            direction: 'column',
            children: [
              { type: 'spacer' },
              {
                type: 'stack',
                height: candleHeight,
                backgroundColor: rising ? '#FF4D5E' : '#20C787',
                borderRadius: 2,
                children: [{ type: 'spacer' }],
              },
            ],
          },
        ],
      };
    }),
  };
}

function singleCandle(item, height) {
  const rising = Number(item.close) >= Number(item.open);
  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'end',
    height,
    children: [
      { type: 'spacer' },
      {
        type: 'stack',
        width: 18,
        height: Math.max(8, height - 8),
        backgroundColor: rising ? '#FF4D5E' : '#20C787',
        borderRadius: 3,
        children: [{ type: 'spacer' }],
      },
      { type: 'spacer' },
    ],
  };
}

function metricRow(label, change, color) {
  return row(label, `${signed(change.diff)}  ${signedPct(change.rate)}`, '#AAB3C2', color);
}

function marketMoodRow(stats) {
  if (!stats || !stats.count) return row('市场情绪', '未取到', '#AAB3C2', '#DCE5F2');
  return row('市场情绪', `${stats.label}  涨${stats.upPct}% / 跌${stats.downPct}%`, '#AAB3C2', stats.color);
}

function focusIndexGrid(items, compact) {
  const list = (items || []).slice(0, compact ? 3 : 5);
  return {
    type: 'stack',
    direction: 'column',
    gap: 5,
    children: [
      {
        type: 'text',
        text: '重点指数变化',
        font: { size: 'caption2', weight: 'medium' },
        textColor: '#7F8A9B',
        maxLines: 1,
      },
      {
        type: 'stack',
        direction: 'row',
        gap: 8,
        children: [
          {
            type: 'stack',
            direction: 'column',
            gap: 4,
            flex: 1,
            children: list.filter((_, index) => index % 2 === 0).map(focusIndexRow),
          },
          {
            type: 'stack',
            direction: 'column',
            gap: 4,
            flex: 1,
            children: list.filter((_, index) => index % 2 === 1).map(focusIndexRow),
          },
        ],
      },
    ],
  };
}

function focusIndexRow(item) {
  const color = colorBy(item && item.rate);
  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    gap: 4,
    children: [
      { type: 'text', text: item ? item.label : '--', font: { size: 'caption2', weight: 'medium' }, textColor: '#AAB3C2', maxLines: 1, minScale: 0.68 },
      { type: 'spacer' },
      { type: 'text', text: item ? signedPct(item.rate) : '--', font: { size: 'caption2', weight: 'bold', family: 'Menlo' }, textColor: color, maxLines: 1, minScale: 0.68 },
    ],
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

function calcChange(current, previous) {
  const diff = current !== null && previous !== null ? Number(current) - Number(previous) : null;
  const rate = previous ? (diff / Number(previous)) * 100 : null;
  return { diff, rate };
}

function klineLabel(type) {
  const value = String(type || '').toLowerCase();
  if (value.includes('hour') || value.includes('60') || value.includes('1h')) return '时K环比';
  if (value.includes('week')) return '周K环比';
  return '日K环比';
}

function normalizeIndexName(name, key) {
  if (typeof name === 'string' && /[\u4e00-\u9fff]/.test(name)) return name;
  const names = {
    init: '饰品指数',
    lease: '租赁指数',
    main_weapon: '百元主战',
    agent: '探员指数',
    no_painted: '原皮指数',
    covert_weapon: '红皮指数',
    thousand_weapon: '千战指数',
    wk: '武库指数',
    sticker: '贴纸指数',
    knives: '匕首指数',
    gloves: '手套指数',
    charm: '挂件指数',
    collection: '收藏品',
    doppler: '多普勒',
    gamma_doppler: '伽玛多普勒',
    music_kits: '音乐盒',
  };
  return names[key] || '饰品指数';
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

function normalizeTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (part) => String(part).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function timeValue(value) {
  const num = Number(value);
  if (Number.isFinite(num)) return num < 10000000000 ? num * 1000 : num;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}
