/**
 * weather.mjs — 零依赖口语天气解析 + Open-Meteo 事实卡片查询
 * 只返回客观结构化事实卡片，由会话模型消化成角色自己的自然口吻。
 */

const DAY_MS = 86_400_000;

export const WMO_TEXT = Object.freeze({
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨',
  56: '冻雨', 57: '冻雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '阵雨', 82: '强阵雨',
  85: '阵雪', 86: '阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '雷阵雨伴冰雹',
});

export function wmoText(code) {
  return WMO_TEXT[code] || '未知';
}

export const PERIOD_WINDOWS = Object.freeze({
  凌晨: [0, 5], 半夜: [0, 4], 深夜: [0, 5],
  清早: [5, 8], 一大早: [5, 8],
  清晨: [6, 8], 早上: [6, 9], 早晨: [6, 9],
  上午: [8, 12],
  白天: [6, 18],
  中午: [11, 14],
  下午: [12, 18],
  傍晚: [17, 19], 黄昏: [17, 19],
  晚上: [18, 23], 夜里: [18, 23], 夜间: [20, 23],
});

const CITY_ALIASES = Object.freeze({
  长沙: '长沙市',
  首尔: 'Seoul',
  首爾: 'Seoul',
});

const CN_DIGITS = Object.freeze({ 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 });

function cnToInt(s) {
  if (!s) return NaN;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (s === '十') return 10;
  if (s.includes('十')) {
    const [a, b] = s.split('十');
    const tens = a === '' ? 1 : (CN_DIGITS[a] ?? NaN);
    const ones = b === '' ? 0 : (CN_DIGITS[b] ?? NaN);
    if (Number.isNaN(tens) || Number.isNaN(ones)) return NaN;
    return tens * 10 + ones;
  }
  return CN_DIGITS[s] ?? NaN;
}

function weekdayOffset(prefix, ch, now) {
  const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
  const target = map[ch];
  const today = now.getDay();
  let diff = (target - today + 7) % 7;
  if (prefix === '下') diff += 7;
  else if (prefix === '下下') diff += 14;
  else if (prefix === '上') diff -= 7;
  return diff;
}

function localDateAtOffset(offsetDays, now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseDayExpression(text, now = new Date()) {
  const t = String(text || '').trim();
  if (!t) return null;

  const relPatterns = [
    [/大前天/, -3], [/前天/, -2], [/昨天|昨日/, -1],
    [/大后天/, 3], [/后天/, 2], [/明天|明日/, 1], [/今天|今日/, 0],
  ];
  for (const [re, offset] of relPatterns) {
    const m = t.match(re);
    if (m) {
      const rest = (t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length)).trim();
      return { offset, label: m[0], rest };
    }
  }

  const wdRe = /(下下|下|上|本|这)?(?:周|星期|礼拜)([一二三四五六日天])/;
  let m = t.match(wdRe);
  if (m) {
    const rest = (t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length)).trim();
    return { offset: weekdayOffset(m[1], m[2], now), label: m[0], rest };
  }

  const weekendRe = /(下|上)?周末/;
  m = t.match(weekendRe);
  if (m) {
    let offset = weekdayOffset(m[1] || '', '六', now);
    if (!m[1]) offset = (6 - now.getDay() + 7) % 7 || 7;
    const rest = (t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length)).trim();
    return { offset, label: m[0], rest };
  }

  const absRe = /(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日号]/;
  m = t.match(absRe);
  if (m) {
    const year = m[1] ? Number(m[1]) : now.getFullYear();
    const target = new Date(year, Number(m[2]) - 1, Number(m[3]));
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const offset = Math.round((target.getTime() - today.getTime()) / DAY_MS);
    const rest = (t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length)).trim();
    return { offset, label: m[0], rest };
  }

  const nAfter = t.match(/(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*天后/);
  if (nAfter) {
    const n = cnToInt(nAfter[1]);
    if (n > 0 && n <= 15) {
      const rest = (t.slice(0, nAfter.index) + ' ' + t.slice(nAfter.index + nAfter[0].length)).trim();
      return { offset: n, label: nAfter[0], rest };
    }
  }
  return null;
}

export function parsePeriodExpression(text) {
  const t = String(text || '');
  for (const [period, window] of Object.entries(PERIOD_WINDOWS)) {
    const idx = t.indexOf(period);
    if (idx >= 0) {
      const rest = (t.slice(0, idx) + ' ' + t.slice(idx + period.length)).trim();
      return { period, hours: window, rest };
    }
  }
  return null;
}

function extractCityCandidate(text) {
  let s = String(text || '')
    .replace(/[，。？！?!,.、：:]/g, ' ')
    .replace(/(帮我看看|帮我查查|查一下|看看|请问|顺便|大概|多少度|什么天气|啥天气|天气怎么样|天气如何|天气|穿什么|要带伞吗|带伞吗|冷不冷|热不热|下不下雨|会下雨吗|去|到|在|的)/g, ' ')
    .trim();
  const tokens = s.split(/\s+/).filter(Boolean);
  return tokens[0] || '';
}

export async function geocodeCity(city, fetchImpl = fetch) {
  const raw = String(city || '').trim();
  if (!raw) return { ok: false, error: 'missing-city', message: '缺少要查询的城市名称' };
  const query = CITY_ALIASES[raw] || raw;
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=5&language=zh&format=json`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return { ok: false, error: `geocode-http-${res.status}` };
  const data = await res.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  if (!results.length && query !== raw.replace(/[市县区]$/, '')) {
    const stripped = raw.replace(/[市县区]$/, '');
    if (stripped && stripped !== query) return geocodeCity(stripped, fetchImpl);
  }
  if (!results.length) return { ok: false, error: 'city-not-found', city: raw };
  const best = results[0];
  return {
    ok: true,
    city: best.name || raw,
    admin1: best.admin1 || '',
    country: best.country || '',
    latitude: best.latitude,
    longitude: best.longitude,
    timezone: best.timezone || 'Asia/Shanghai',
  };
}

export async function queryWeatherFactCard({
  text = '',
  city = '',
  date = '',
  period = '',
  now = new Date(),
  fetchImpl = fetch,
} = {}) {
  let working = String(text || '').trim();
  let dayInfo = date ? parseDayExpression(date, now) : parseDayExpression(working, now);
  if (dayInfo && !date) working = dayInfo.rest;

  let periodInfo = period ? parsePeriodExpression(period) : parsePeriodExpression(working);
  if (periodInfo && !period) working = periodInfo.rest;

  const resolvedCity = String(city || '').trim() || extractCityCandidate(working);
  if (!resolvedCity) {
    return {
      ok: false,
      error: 'missing-city',
      hint: '没听出具体城市，可以先自然问对方一句去哪个城市。',
    };
  }

  const offset = dayInfo ? dayInfo.offset : 0;
  if (offset < -2 || offset > 15) {
    return {
      ok: false,
      error: 'date-out-of-range',
      city: resolvedCity,
      offsetDays: offset,
      hint: '超出免费天气预报覆盖天数（最多未来 15 天）。',
    };
  }

  const geo = await geocodeCity(resolvedCity, fetchImpl);
  if (!geo.ok) return geo;

  const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : localDateAtOffset(offset, now);
  const pastDays = offset < 0 ? Math.abs(offset) + 1 : 0;
  const forecastDays = Math.max(3, Math.min(16, offset + 2));

  const params = new URLSearchParams({
    latitude: String(geo.latitude),
    longitude: String(geo.longitude),
    timezone: geo.timezone || 'auto',
    current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    hourly: 'temperature_2m,apparent_temperature,precipitation_probability,weather_code',
    forecast_days: String(forecastDays),
  });
  if (pastDays > 0) params.set('past_days', String(pastDays));

  const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) return { ok: false, error: `forecast-http-${res.status}`, city: geo.city };
  const data = await res.json();

  const dailyTimes = data?.daily?.time || [];
  const dIdx = dailyTimes.indexOf(targetDate);
  if (dIdx < 0) {
    return { ok: false, error: 'target-date-unavailable', city: geo.city, targetDate };
  }

  const dailySummary = {
    date: targetDate,
    dayLabel: dayInfo?.label || (offset === 0 ? '今天' : `${offset}天后`),
    weather: wmoText(data.daily.weather_code?.[dIdx]),
    tempMinC: data.daily.temperature_2m_min?.[dIdx] ?? null,
    tempMaxC: data.daily.temperature_2m_max?.[dIdx] ?? null,
    precipProbMaxPct: data.daily.precipitation_probability_max?.[dIdx] ?? null,
  };

  let periodSummary = null;
  if (periodInfo) {
    const [startH, endH] = periodInfo.hours;
    const hTimes = data?.hourly?.time || [];
    const slice = [];
    for (let i = 0; i < hTimes.length; i++) {
      const stamp = hTimes[i]; // YYYY-MM-DDTHH:00
      if (!stamp.startsWith(targetDate + 'T')) continue;
      const hour = Number(stamp.slice(11, 13));
      if (hour >= startH && hour <= endH) {
        slice.push({
          hour,
          tempC: data.hourly.temperature_2m?.[i],
          feelsLikeC: data.hourly.apparent_temperature?.[i],
          precipProbPct: data.hourly.precipitation_probability?.[i] ?? 0,
          weather: wmoText(data.hourly.weather_code?.[i]),
        });
      }
    }
    if (slice.length) {
      const temps = slice.map((x) => x.tempC).filter((x) => typeof x === 'number');
      const feels = slice.map((x) => x.feelsLikeC).filter((x) => typeof x === 'number');
      const precips = slice.map((x) => x.precipProbPct).filter((x) => typeof x === 'number');
      periodSummary = {
        period: periodInfo.period,
        hourRange: `${String(startH).padStart(2, '0')}:00-${String(endH).padStart(2, '0')}:00`,
        tempMinC: temps.length ? Math.min(...temps) : null,
        tempMaxC: temps.length ? Math.max(...temps) : null,
        feelsLikeMinC: feels.length ? Math.min(...feels) : null,
        precipProbMaxPct: precips.length ? Math.max(...precips) : null,
        dominantWeather: slice[Math.floor(slice.length / 2)].weather,
      };
    }
  }

  return {
    ok: true,
    factCard: {
      location: {
        city: geo.city,
        region: geo.admin1,
        country: geo.country,
        timezone: geo.timezone,
      },
      current: offset === 0 && data.current
        ? {
            tempC: data.current.temperature_2m,
            feelsLikeC: data.current.apparent_temperature,
            weather: wmoText(data.current.weather_code),
            windKmh: data.current.wind_speed_10m,
          }
        : null,
      daily: dailySummary,
      period: periodSummary,
    },
  };
}
