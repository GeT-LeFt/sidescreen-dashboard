'use strict';
/*
 * ics-lib.js - zero-dependency ICS (RFC 5545) calendar parser for sidescreen-dashboard.
 * CommonJS. module.exports = { parseICS }
 *
 * parseICS(icsText, nowMs) -> [{ title, startMs, endMs, allDay }]
 *   - only occurrences overlapping the window [nowMs - 4h, nowMs + 14d]
 *   - sorted ascending by startMs
 *
 * Handles:
 *   - RFC5545 line unfolding (continuation lines starting with space/tab)
 *   - DTSTART/DTEND: UTC ("Z"), TZID via built-in fixed offset table
 *     (Asia/Shanghai, Asia/Hong_Kong, Asia/Taipei ... => +8), floating time
 *     and unknown TZID => local machine timezone, VALUE=DATE all-day events
 *   - SUMMARY unescaping (\n \, \; \\)
 *   - simple RRULE expansion: FREQ=DAILY, FREQ=WEEKLY (with BYDAY),
 *     INTERVAL / UNTIL / COUNT (approximate); other FREQ never crash and
 *     emit the raw first occurrence when inside the window
 *   - basic EXDATE removal (exact instant match; date-only EXDATE removes
 *     any occurrence starting on that day)
 *   - skips nested VALARM blocks and top-level VTIMEZONE blocks
 *   - skips STATUS:CANCELLED events
 */

var DAY_MS = 86400000;
var HOUR_MS = 3600000;
var MAX_ITER = 200000; // hard cap for any expansion loop

// Fixed offsets in minutes east of UTC. Zones with DST are approximate
// (standard offset); unknown TZIDs fall back to the local machine timezone.
var TZ_OFFSET_MIN = {
  'Asia/Shanghai': 480,
  'Asia/Chongqing': 480,
  'Asia/Hong_Kong': 480,
  'Asia/Macau': 480,
  'Asia/Macao': 480,
  'Asia/Taipei': 480,
  'Asia/Singapore': 480,
  'Asia/Kuala_Lumpur': 480,
  'Asia/Manila': 480,
  'Asia/Tokyo': 540,
  'Asia/Seoul': 540,
  'Asia/Bangkok': 420,
  'Asia/Jakarta': 420,
  'Asia/Kolkata': 330,
  'Asia/Calcutta': 330,
  'Asia/Dubai': 240,
  'UTC': 0,
  'Etc/UTC': 0,
  'Etc/GMT': 0,
  'GMT': 0,
  'Z': 0
};

function unfoldLines(text) {
  var raw = String(text == null ? '' : text).split(/\r\n|\n|\r/);
  var lines = [];
  for (var i = 0; i < raw.length; i++) {
    var l = raw[i];
    if (l.length === 0) continue;
    var c0 = l.charAt(0);
    if ((c0 === ' ' || c0 === '\t') && lines.length > 0) {
      lines[lines.length - 1] += l.slice(1);
    } else {
      lines.push(l);
    }
  }
  return lines;
}

function splitOutsideQuotes(s, sep) {
  var parts = [];
  var cur = '';
  var inQ = false;
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (c === '"') { inQ = !inQ; cur += c; continue; }
    if (c === sep && !inQ) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

// "NAME;PARAM=V;PARAM2="Q:V":value" -> { name, params, value }
function parseLine(line) {
  var inQ = false;
  var colon = -1;
  for (var i = 0; i < line.length; i++) {
    var c = line.charAt(i);
    if (c === '"') inQ = !inQ;
    else if (c === ':' && !inQ) { colon = i; break; }
  }
  if (colon < 0) return null;
  var head = line.slice(0, colon);
  var value = line.slice(colon + 1);
  var parts = splitOutsideQuotes(head, ';');
  var name = parts[0].trim().toUpperCase();
  if (!name) return null;
  var params = {};
  for (var j = 1; j < parts.length; j++) {
    var eq = parts[j].indexOf('=');
    if (eq > 0) {
      var k = parts[j].slice(0, eq).trim().toUpperCase();
      var v = parts[j].slice(eq + 1).trim();
      if (v.length >= 2 && v.charAt(0) === '"' && v.charAt(v.length - 1) === '"') {
        v = v.slice(1, -1);
      }
      params[k] = v;
    }
  }
  return { name: name, params: params, value: value };
}

function unescapeText(s) {
  return String(s).replace(/\\(.)/g, function (_m, c) {
    if (c === 'n' || c === 'N') return '\n';
    return c; // \, \; \\ and anything else
  });
}

function tzOffsetFor(tzid) {
  if (!tzid) return null;
  if (Object.prototype.hasOwnProperty.call(TZ_OFFSET_MIN, tzid)) {
    return TZ_OFFSET_MIN[tzid];
  }
  return null; // unknown -> local machine timezone
}

// Returns { ms, allDay, offsetMin } or null.
// offsetMin: fixed offset in minutes used to interpret wall time,
//            or null meaning "local machine timezone".
function parseDT(value, params) {
  var v = String(value == null ? '' : value).trim();
  var p = params || {};
  var m;
  var dateOnly = (String(p.VALUE || '').toUpperCase() === 'DATE') || /^\d{8}$/.test(v);
  if (dateOnly) {
    m = /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    var dt = new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0); // local midnight
    return { ms: dt.getTime(), allDay: true, offsetMin: null };
  }
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) return null;
  var y = +m[1], mo = +m[2] - 1, d = +m[3], h = +m[4], mi = +m[5];
  var s = m[6] ? +m[6] : 0;
  if (m[7]) { // UTC
    return { ms: Date.UTC(y, mo, d, h, mi, s), allDay: false, offsetMin: 0 };
  }
  var off = tzOffsetFor(p.TZID);
  if (off === null) { // floating time or unknown TZID -> local machine timezone
    return { ms: new Date(y, mo, d, h, mi, s).getTime(), allDay: false, offsetMin: null };
  }
  return { ms: Date.UTC(y, mo, d, h, mi, s) - off * 60000, allDay: false, offsetMin: off };
}

// "P1DT2H30M" / "PT45M" / "P2W" -> milliseconds (or null)
function parseDuration(v) {
  var m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v || '').trim());
  if (!m) return null;
  var ms = (+(m[2] || 0)) * 7 * DAY_MS + (+(m[3] || 0)) * DAY_MS +
           (+(m[4] || 0)) * HOUR_MS + (+(m[5] || 0)) * 60000 + (+(m[6] || 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

function parseRRule(v) {
  var rule = {};
  var parts = String(v || '').split(';');
  for (var i = 0; i < parts.length; i++) {
    var eq = parts[i].indexOf('=');
    if (eq > 0) {
      rule[parts[i].slice(0, eq).trim().toUpperCase()] = parts[i].slice(eq + 1).trim().toUpperCase();
    }
  }
  return rule;
}

var BYDAY_NUM = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function byDaySet(byday, fallbackDow) {
  var set = {};
  var any = false;
  if (byday) {
    var parts = String(byday).split(',');
    for (var i = 0; i < parts.length; i++) {
      // strip ordinal prefix like "2MO" / "-1FR" (only meaningful for MONTHLY)
      var m = /([A-Z]{2})\s*$/.exec(parts[i].trim());
      if (m && BYDAY_NUM.hasOwnProperty(m[1])) { set[BYDAY_NUM[m[1]]] = true; any = true; }
    }
  }
  if (!any) set[fallbackDow] = true;
  return set;
}

// Day-of-week (0=Sun..6=Sat) of an absolute instant, evaluated in the
// event's own frame: fixed offset if known, otherwise local machine tz.
function dowAt(ms, offsetMin) {
  if (offsetMin === null || offsetMin === undefined) return new Date(ms).getDay();
  return new Date(ms + offsetMin * 60000).getUTCDay();
}

// Calendar-day key of an instant in the event's frame (for date-only EXDATE).
function dayKey(ms, offsetMin) {
  var shift;
  if (offsetMin === null || offsetMin === undefined) {
    shift = -new Date(ms).getTimezoneOffset() * 60000;
  } else {
    shift = offsetMin * 60000;
  }
  return Math.floor((ms + shift) / DAY_MS);
}

function isExcluded(ev, startMs) {
  var i;
  for (i = 0; i < ev.exdatesMs.length; i++) {
    if (ev.exdatesMs[i] === startMs) return true;
  }
  if (ev.exdateDayKeys.length) {
    var k = dayKey(startMs, ev.offsetMin);
    for (i = 0; i < ev.exdateDayKeys.length; i++) {
      if (ev.exdateDayKeys[i] === k) return true;
    }
  }
  return false;
}

function pushOcc(out, ev, startMs, durMs, winStart, winEnd) {
  var endMs = startMs + durMs;
  if (startMs > winEnd) return;
  if (endMs < winStart) return;
  out.push({ title: ev.title, startMs: startMs, endMs: endMs, allDay: ev.allDay });
}

function expandEvent(ev, out, winStart, winEnd) {
  var durMs = ev.endMs - ev.startMs;
  if (durMs < 0) durMs = 0;
  var rule = ev.rrule;

  if (!rule || !rule.FREQ) {
    pushOcc(out, ev, ev.startMs, durMs, winStart, winEnd);
    return;
  }

  var freq = rule.FREQ;
  var interval = parseInt(rule.INTERVAL, 10);
  if (!(interval >= 1)) interval = 1;
  var count = rule.COUNT ? parseInt(rule.COUNT, 10) : null;
  if (count !== null && !(count >= 1)) count = null;

  var hardEnd = winEnd;
  if (rule.UNTIL) {
    var u = parseDT(rule.UNTIL, {});
    if (u) {
      var untilMs = u.allDay ? (u.ms + DAY_MS - 1) : u.ms; // date-only UNTIL: inclusive end of day
      if (untilMs < hardEnd) hardEnd = untilMs;
    }
  }

  var iter, st;

  if (freq === 'DAILY') {
    var step = interval * DAY_MS;
    var k0 = 0;
    if (ev.startMs + durMs < winStart) {
      k0 = Math.floor((winStart - durMs - ev.startMs) / step);
      if (k0 < 0) k0 = 0;
    }
    for (iter = 0; iter < MAX_ITER; iter++) {
      var k = k0 + iter;
      if (count !== null && k >= count) break;
      st = ev.startMs + k * step;
      if (st > hardEnd) break;
      if (!isExcluded(ev, st)) pushOcc(out, ev, st, durMs, winStart, winEnd);
    }
    return;
  }

  if (freq === 'WEEKLY') {
    var days = byDaySet(rule.BYDAY, dowAt(ev.startMs, ev.offsetMin));
    // Anchor "week 0" to the Monday-started week containing DTSTART (WKST
    // default is MO). Approximate: computed with fixed 24h days.
    var startDow = dowAt(ev.startMs, ev.offsetMin);
    var weekBase = ev.startMs - ((startDow + 6) % 7) * DAY_MS;
    var cur = ev.startMs;
    // Fast-forward only when COUNT is absent (COUNT needs every occurrence
    // counted from DTSTART).
    if (count === null && cur + durMs < winStart) {
      var weekStep = interval * 7 * DAY_MS;
      var skip = Math.floor((winStart - durMs - cur) / weekStep);
      if (skip > 0) cur += skip * weekStep;
    }
    var occSeen = 0;
    for (iter = 0; iter < MAX_ITER; iter++) {
      if (cur > hardEnd) break;
      if (count !== null && occSeen >= count) break;
      var weekIdx = Math.floor(Math.round((cur - weekBase) / DAY_MS) / 7);
      if (weekIdx % interval === 0 && days[dowAt(cur, ev.offsetMin)] && cur >= ev.startMs) {
        occSeen++; // COUNT applies to generated set, before EXDATE removal
        if (!isExcluded(ev, cur)) pushOcc(out, ev, cur, durMs, winStart, winEnd);
      }
      cur += DAY_MS;
    }
    return;
  }

  // Other FREQ (MONTHLY / YEARLY / ...): do not crash; emit the raw first
  // occurrence if it lands inside the window.
  pushOcc(out, ev, ev.startMs, durMs, winStart, winEnd);
}

function finalizeEvent(raw, out, winStart, winEnd) {
  if (!raw.start) return;
  if (raw.cancelled) return;
  var ev = {
    title: raw.summary != null ? raw.summary : '(no title)',
    startMs: raw.start.ms,
    allDay: !!raw.start.allDay,
    offsetMin: raw.start.offsetMin,
    rrule: raw.rrule,
    exdatesMs: [],
    exdateDayKeys: []
  };
  if (raw.end) {
    ev.endMs = raw.end.ms;
  } else if (raw.durMs != null) {
    ev.endMs = raw.start.ms + raw.durMs;
  } else if (ev.allDay) {
    ev.endMs = raw.start.ms + DAY_MS;
  } else {
    ev.endMs = raw.start.ms; // RFC: date-time DTSTART without DTEND => zero duration
  }
  if (ev.endMs < ev.startMs) ev.endMs = ev.startMs;

  for (var i = 0; i < raw.exdates.length; i++) {
    var ex = raw.exdates[i];
    if (!ex) continue;
    if (ex.allDay) ev.exdateDayKeys.push(dayKey(ex.ms, ex.offsetMin));
    else ev.exdatesMs.push(ex.ms);
  }

  expandEvent(ev, out, winStart, winEnd);
}

function parseICS(icsText, nowMs) {
  var now = (typeof nowMs === 'number' && isFinite(nowMs)) ? nowMs : Date.now();
  var winStart = now - 4 * HOUR_MS;
  var winEnd = now + 14 * DAY_MS;
  var out = [];
  var lines = unfoldLines(icsText);
  var cur = null;     // raw VEVENT being collected
  var skipDepth = 0;  // nested components inside a VEVENT (e.g. VALARM)

  for (var i = 0; i < lines.length; i++) {
    var p = parseLine(lines[i]);
    if (!p) continue;

    if (p.name === 'BEGIN') {
      var bt = p.value.trim().toUpperCase();
      if (cur) { skipDepth++; continue; }             // VALARM etc. inside VEVENT
      if (bt === 'VEVENT') {
        cur = { summary: null, start: null, end: null, durMs: null,
                rrule: null, exdates: [], cancelled: false };
      }
      continue; // VTIMEZONE/VCALENDAR bodies ignored (cur stays null)
    }
    if (p.name === 'END') {
      if (skipDepth > 0) { skipDepth--; continue; }
      if (cur && p.value.trim().toUpperCase() === 'VEVENT') {
        try { finalizeEvent(cur, out, winStart, winEnd); } catch (_e) { /* never crash on one bad event */ }
        cur = null;
      }
      continue;
    }
    if (!cur || skipDepth > 0) continue;

    try {
      switch (p.name) {
        case 'SUMMARY':
          cur.summary = unescapeText(p.value).replace(/\n/g, ' ').trim();
          break;
        case 'DTSTART':
          cur.start = parseDT(p.value, p.params);
          break;
        case 'DTEND':
          cur.end = parseDT(p.value, p.params);
          break;
        case 'DURATION':
          cur.durMs = parseDuration(p.value);
          break;
        case 'RRULE':
          cur.rrule = parseRRule(p.value);
          break;
        case 'EXDATE':
          var vals = p.value.split(',');
          for (var j = 0; j < vals.length; j++) {
            var ex = parseDT(vals[j], p.params);
            if (ex) cur.exdates.push(ex);
          }
          break;
        case 'STATUS':
          if (p.value.trim().toUpperCase() === 'CANCELLED') cur.cancelled = true;
          break;
      }
    } catch (_e) { /* ignore malformed property */ }
  }

  out.sort(function (a, b) {
    return (a.startMs - b.startMs) || (a.endMs - b.endMs) ||
           (a.title < b.title ? -1 : a.title > b.title ? 1 : 0);
  });
  return out;
}

module.exports = { parseICS: parseICS };
