// weather-lib.js - pure mapping helpers for Open-Meteo responses. No network, no deps.
// CommonJS. Consumed by server.js (or any node script) after fetching:
//   https://api.open-meteo.com/v1/forecast?...&current_weather=true
//     &hourly=precipitation_probability,temperature_2m
//     &daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max
//     &timezone=auto&forecast_days=3
'use strict';

// WMO weather interpretation codes (full table).
// 0 clear; 1-2 partly cloudy; 3 overcast; 45/48 fog; 51-57 drizzle;
// 61-65 rain; 66-67 freezing rain; 71-77 snow; 80-82 rain showers;
// 85-86 snow showers; 95-99 thunderstorm.
const WMO = {
  0:  { icon: '☀️',  desc: '晴' },                                  // ☀️ 晴
  1:  { icon: '🌤️', desc: '少云' },                        // 🌤️ 少云
  2:  { icon: '⛅',        desc: '多云' },                            // ⛅ 多云
  3:  { icon: '☁️',  desc: '阴' },                                  // ☁️ 阴
  45: { icon: '🌫️', desc: '雾' },                             // 🌫️ 雾
  48: { icon: '🌫️', desc: '冻雾' },                       // 🌫️ 冻雾
  51: { icon: '🌦️', desc: '小毛毛雨' },           // 🌦️ 小毛毛雨
  53: { icon: '🌦️', desc: '毛毛雨' },                 // 🌦️ 毛毛雨
  55: { icon: '🌧️', desc: '大毛毛雨' },           // 🌧️ 大毛毛雨
  56: { icon: '🌧️', desc: '冻毛毛雨' },           // 🌧️ 冻毛毛雨
  57: { icon: '🌧️', desc: '强冻毛毛雨' },     // 🌧️ 强冻毛毛雨
  61: { icon: '🌧️', desc: '小雨' },                       // 🌧️ 小雨
  63: { icon: '🌧️', desc: '中雨' },                       // 🌧️ 中雨
  65: { icon: '🌧️', desc: '大雨' },                       // 🌧️ 大雨
  66: { icon: '🌧️', desc: '冻雨' },                       // 🌧️ 冻雨
  67: { icon: '🌧️', desc: '强冻雨' },                 // 🌧️ 强冻雨
  71: { icon: '🌨️', desc: '小雪' },                       // 🌨️ 小雪
  73: { icon: '🌨️', desc: '中雪' },                       // 🌨️ 中雪
  75: { icon: '❄️',  desc: '大雪' },                            // ❄️ 大雪
  77: { icon: '❄️',  desc: '雪粒' },                            // ❄️ 雪粒
  80: { icon: '🌦️', desc: '小阵雨' },                 // 🌦️ 小阵雨
  81: { icon: '🌧️', desc: '阵雨' },                       // 🌧️ 阵雨
  82: { icon: '🌧️', desc: '强阵雨' },                 // 🌧️ 强阵雨
  85: { icon: '🌨️', desc: '小阵雪' },                 // 🌨️ 小阵雪
  86: { icon: '🌨️', desc: '大阵雪' },                 // 🌨️ 大阵雪
  95: { icon: '⛈️',  desc: '雷暴' },                            // ⛈️ 雷暴
  96: { icon: '⛈️',  desc: '雷暴伴小冰雹' },    // ⛈️ 雷暴伴小冰雹
  99: { icon: '⛈️',  desc: '雷暴伴大冰雹' }     // ⛈️ 雷暴伴大冰雹
};

const UNKNOWN = { icon: '❓', desc: '未知' }; // ❓ 未知

function wmoIcon(code) {
  const e = WMO[code];
  return e ? e.icon : UNKNOWN.icon;
}

function wmoDesc(code) {
  const e = WMO[code];
  return e ? e.desc : UNKNOWN.desc;
}

// Open-Meteo hourly.time entries are local-time ISO strings WITHOUT offset
// (e.g. "2026-07-11T15:00" in the location timezone when timezone=auto).
// Convert to epoch ms using apiJson.utc_offset_seconds.
function localIsoToEpochMs(iso, utcOffsetSeconds) {
  const t = Date.parse(iso + (iso.length <= 16 ? ':00' : '') + 'Z');
  if (Number.isNaN(t)) return NaN;
  return t - (utcOffsetSeconds || 0) * 1000;
}

/**
 * mapForecast(apiJson, nowMs) -> {
 *   temp        current temperature (number|null)
 *   code        current WMO weather code (number|null)
 *   icon, desc  from code
 *   hi, lo      today's max/min temperature (daily[0])
 *   rainSoonMin minutes until the first hour slot within the next 120 min
 *               whose precipitation probability >= 50 (null if none).
 *               The in-progress hour counts as 0 minutes away.
 *   probMax2h   max precipitation probability over hour slots overlapping
 *               [now, now+2h] (0 if no data)
 *   hourlyProb  precipitation probability for the next 6 hour slots,
 *               starting with the in-progress hour
 * }
 * Pure function: pass nowMs explicitly (e.g. Date.now()).
 */
function mapForecast(apiJson, nowMs) {
  if (!apiJson || typeof apiJson !== 'object') return null;
  if (typeof nowMs !== 'number' || Number.isNaN(nowMs)) nowMs = Date.now();

  const cw = apiJson.current_weather || {};
  const code = (typeof cw.weathercode === 'number') ? cw.weathercode : null;
  const temp = (typeof cw.temperature === 'number') ? cw.temperature : null;

  const daily = apiJson.daily || {};
  const hi = Array.isArray(daily.temperature_2m_max) && typeof daily.temperature_2m_max[0] === 'number'
    ? daily.temperature_2m_max[0] : null;
  const lo = Array.isArray(daily.temperature_2m_min) && typeof daily.temperature_2m_min[0] === 'number'
    ? daily.temperature_2m_min[0] : null;

  const hourly = apiJson.hourly || {};
  const times = Array.isArray(hourly.time) ? hourly.time : [];
  const probs = Array.isArray(hourly.precipitation_probability) ? hourly.precipitation_probability : [];
  const offset = typeof apiJson.utc_offset_seconds === 'number' ? apiJson.utc_offset_seconds : 0;

  const HOUR = 3600000;
  // Build [{startMs, prob}] for hour slots that are still relevant (slot end > now).
  const slots = [];
  for (let i = 0; i < times.length; i++) {
    const startMs = localIsoToEpochMs(times[i], offset);
    if (Number.isNaN(startMs)) continue;
    if (startMs + HOUR <= nowMs) continue; // slot fully in the past
    const p = (typeof probs[i] === 'number') ? probs[i] : null;
    slots.push({ startMs, prob: p });
  }
  slots.sort((a, b) => a.startMs - b.startMs);

  // hourlyProb: next 6 slots (in-progress hour first)
  const hourlyProb = slots.slice(0, 6).map((s) => s.prob);

  // probMax2h + rainSoonMin over slots overlapping [now, now+120min]
  const windowEnd = nowMs + 120 * 60000;
  let probMax2h = 0;
  let rainSoonMin = null;
  for (const s of slots) {
    if (s.startMs >= windowEnd) break;
    if (s.prob === null) continue;
    if (s.prob > probMax2h) probMax2h = s.prob;
    if (rainSoonMin === null && s.prob >= 50) {
      rainSoonMin = Math.max(0, Math.round((s.startMs - nowMs) / 60000));
    }
  }

  return {
    temp,
    code,
    icon: code === null ? UNKNOWN.icon : wmoIcon(code),
    desc: code === null ? UNKNOWN.desc : wmoDesc(code),
    hi,
    lo,
    rainSoonMin,
    probMax2h,
    hourlyProb
  };
}

module.exports = { wmoIcon, wmoDesc, mapForecast };
