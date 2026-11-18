import { mountAiReport } from './ai-report.js';

// Portfolio dashboard components. The product API returns daily aggregates and
// a bounded sample of recent visits. Only the latter belongs in the visit list.
const firstReportDay = '2026-11-16';
const dayMs = 86400000;
const pages = { home: 'Главная', editor: 'Редактор', guide: 'Инструкция', connect: 'Подключение ИИ', privacy: 'Конфиденциальность' };
const devices = { phone: 'Телефон', tablet: 'Планшет', desktop: 'Компьютер', unknown: 'Не определено' };
const weekdays = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const tagPattern = /^[a-z0-9_-]{1,40}$/;
const numberFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short' });
const visitFormat = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const isCount = n => Number.isSafeInteger(n) && n >= 0;
const count = n => isCount(n) ? n : null;
const num = n => Number.isFinite(n) ? numberFormat.format(n) : '—';
const percent = n => Number.isFinite(n) ? num(n) + ' %' : '—';
const rate = (n, all) => isCount(n) && all > 0 ? n / all * 100 : null;
const sum = values => values.length && values.every(isCount) ? values.reduce((a, b) => a + b, 0) : null;
const list = value => Array.isArray(value) ? value : [];
const labelFor = (names, key) => typeof key === 'string' && Object.hasOwn(names, key) ? names[key] : '';
const weekday = t => (new Date(t).getUTCDay() + 6) % 7;
const dateKey = t => new Date(t).toISOString().slice(0, 10);
const fullDate = date => date.split('-').reverse().join('.');
const hourLabel = h => String(h).padStart(2, '0') + ':00';
const empty = message => `<p class="hint">${esc(message)}</p>`;

const metrics = [
  ['visits', 'Визиты'], ['editor', 'Открыли редактор'], ['converted', 'Визиты с ZIP модели'],
  ['exports', 'Экспорты ZIP'], ['rate', 'Доля визитов с ZIP модели'], ['downloads', 'Визиты с ZIP набора'],
];
const formatMetric = (key, value) => key === 'rate' ? percent(value) : num(value);

function pageCount(day, dimension, name) {
  const rows = day.traffic?.[dimension];
  if (!Array.isArray(rows)) return null;
  if (dimension === 'pages' && day.visits > 0 && day.funnel?.visitsWithPages === 0) return null;
  const matching = rows.filter(item => item?.name === name);
  if (matching.length) {
    const value = matching[0].visits;
    return matching.length === 1 && isCount(value) && value <= day.visits ? value : null;
  }
  // Old visits can have empty page lists even in a modern response.
  return !day.visits || rows.some(item => labelFor(pages, item?.name) && isCount(item.visits) && item.visits > 0 && item.visits <= day.visits) ? 0 : null;
}

function summary(days) {
  const total = read => sum(days.map(read));
  const visits = total(d => d.visits), converted = total(d => d.converted);
  // A zero-visit day cannot establish measurement for a legacy visit on
  // another day. Sum the steps actually observed, with coverage beside them.
  const editorCount = d => count(d.funnel?.editorVisits) ?? pageCount(d, 'pages', 'editor');
  const observed = visits > 0 ? days.filter(d => d.visits > 0 && d.funnel?.visitsWithPages !== 0 &&
    (d.funnel?.visitsWithPages > 0 || editorCount(d) !== null)) : days;
  const step = read => sum(observed.map(read));
  const editorStep = (d, key) => editorCount(d) === 0 ? 0 : count(d.funnel?.[key]);
  const editorFiles = d => {
    const measured = editorStep(d, 'editorFileVisits');
    if (measured !== null) return measured;
    // Older reports know the union exactly when no set was downloaded.
    return d.funnel?.set_download === 0 ? editorStep(d, 'editorExportVisits') : null;
  };
  return {
    visits, converted, rate: rate(converted, visits),
    editor: step(editorCount),
    editorExport: step(d => editorStep(d, 'editorExportVisits')),
    repeatExport: step(d => editorStep(d, 'editorRepeatExportVisits')),
    editorFiles: step(editorFiles),
    exports: total(d => d.exports),
    downloads: total(d => d.funnel?.set_download),
  };
}

function measuredHours(day) {
  const hours = day?.traffic?.hours;
  if (!Array.isArray(hours) || hours.length !== 24 || !hours.every(isCount)) return null;
  return day.visits === 0 || hours.some(n => n > 0) ? hours : null;
}

// Dates are already Moscow calendar keys. UTC arithmetic here advances keys,
// independently of the viewer's time zone. Hour bins are already Moscow hours.
function buckets(days, period, end) {
  if (!days.length && (period === 1 || period === 0)) return [];
  if (period === 1) {
    const hours = measuredHours(days[0]);
    return Array.from({ length: 24 }, (_, h) => ({
      label: hourLabel(h), title: fullDate(end) + ', ' + hourLabel(h) + ' МСК',
      s: { visits: hours?.[h] ?? null },
    }));
  }
  const last = Date.parse(end), start = Date.parse(firstReportDay);
  const first = period ? last - (period - 1) * dayMs : start;
  const weekly = (last - first) / dayMs >= 120;
  const dates = new Map(days.map(day => [day.date, day]));
  const result = [];
  for (let t = first; t <= last;) {
    const endOfBin = weekly ? Math.min(last, t + (6 - weekday(t)) * dayMs) : t;
    const records = [];
    for (let cursor = t; cursor <= endOfBin; cursor += dayMs) {
      const day = dates.get(dateKey(cursor));
      if (day) records.push(day);
    }
    const complete = records.length === (endOfBin - t) / dayMs + 1;
    const label = dateFormat.format(t);
    const title = weekly ? fullDate(dateKey(t)) + ' – ' + fullDate(dateKey(endOfBin))
      : weekdays[weekday(t)] + ', ' + fullDate(dateKey(t));
    result.push({ label, title, week: weekly, s: summary(complete ? records : []) });
    t = endOfBin + dayMs;
  }
  return result;
}

function tip(title, rows) {
  const text = rows.map(([v, label]) => v + ' ' + label).join(', ');
  return `data-tip="${esc(title)}" data-tip-rows="${esc(JSON.stringify(rows))}" aria-label="${esc(title + '. ' + text)}"`;
}

function deltaHTML(cur, prev, has, fmt, isRate) {
  if (!has || !Number.isFinite(cur) || !Number.isFinite(prev)) return '';
  const d = cur - prev;
  if (!prev && !cur) return `<span class="db-delta">как в прошлый период: ${esc(fmt(0))}</span>`;
  const dir = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
  const mark = d > 0 ? '▲' : d < 0 ? '▼' : '=';
  const rel = isRate ? ` · ${d > 0 ? '+' : ''}${num(d)} п. п.` : prev ? ` · ${d > 0 ? '+' : ''}${num(d / prev * 100)}%` : '';
  return `<span class="db-delta is-${dir}"><span aria-hidden="true">${mark}</span> было ${esc(fmt(prev))}${esc(rel)}</span>`;
}

function spark(series) {
  const known = series.filter(Number.isFinite);
  if (known.length < 2) return '';
  const max = Math.max(1, ...known), n = series.length - 1;
  const segments = [];
  series.forEach((v, i) => {
    if (!Number.isFinite(v)) return;
    if (!i || !Number.isFinite(series[i - 1])) segments.push([]);
    segments[segments.length - 1].push(`${(i / n * 100).toFixed(2)},${(22 - v / max * 20).toFixed(2)}`);
  });
  const last = series[n];
  return `<svg class="db-spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">${segments.map(pts => `<polyline points="${pts.join(' ')}" vector-effect="non-scaling-stroke"/>`).join('')}</svg>${Number.isFinite(last) ? `<i class="db-spark-dot" style="bottom:${(12 + (2 + last / max * 20) / 24 * 20 - 4).toFixed(1)}px"></i>` : ''}`;
}

function kpi(key, label, cur, prev, has, series, sub) {
  const fmt = value => formatMetric(key, value);
  return `<div class="db-kpi${key === 'visits' ? ' db-kpi--hero' : ''}" data-kpi="${esc(key)}">
    <span class="db-kpi-l">${esc(label)}</span>
    <b class="db-kpi-v">${esc(fmt(cur))}</b>
    ${sub ? `<span class="db-kpi-sub">${esc(sub)}</span>` : ''}
    ${deltaHTML(cur, prev, has, fmt, key === 'rate')}${spark(series)}
  </div>`;
}

function niceMax(m) {
  if (m <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(m)), f = m / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

function trendHTML(cur, prev, has, period) {
  if (!cur.length) return empty('Нет данных за период.');
  const missing = cur.some(b => b.s.visits == null) ? '<span><i class="db-lk is-unknown"></i>нет данных</span>' : '';
  const top = niceMax(Math.max(1, ...cur.concat(prev).map(b => b.s.visits ?? 0)));
  const ticks = [0, top / 2, top], every = Math.ceil(cur.length / 8);
  const hourly = period === 1, unit = hourly ? 'по часам, МСК' : cur[0].week ? 'по неделям' : 'по дням';
  return `<div class="db-trend">
    <div class="db-legend"><span><i class="db-lk db-lk--bar"></i>этот период</span>${has ? '<span><i class="db-lk db-lk--tick"></i>прошлый период</span>' : ''}${missing}<span class="hint">${unit}</span></div>
    <div class="db-plot">
      <div class="db-yaxis" aria-hidden="true">${ticks.slice().reverse().map(t => `<span>${num(t)}</span>`).join('')}</div>
      <div class="db-area">
        ${ticks.map(t => `<i class="db-grid" style="bottom:${t / top * 100}%"></i>`).join('')}
        <div class="db-cols">${cur.map((b, i) => {
    const n = b.s.visits, p = has ? prev[i] : null;
    const rows = (hourly ? metrics.slice(0, 1) : metrics).map(([key, label]) => [formatMetric(key, b.s[key]), label]);
    if (p) rows.push([num(p.s.visits), 'визитов за прошлый период (' + p.title + ')']);
    return `<span class="db-col${n == null ? ' is-unknown' : ''}" tabindex="0" ${tip(b.title, rows)}>
      ${n != null ? `<i class="db-bar" style="height:${n / top * 100}%"></i>` : ''}
      ${p?.s.visits != null ? `<i class="db-tick" style="bottom:${p.s.visits / top * 100}%"></i>` : ''}</span>`;
  }).join('')}</div></div></div>
    <div class="db-xaxis" aria-hidden="true">${cur.map((b, i) => `<span>${(cur.length - 1 - i) % every === 0 ? esc(b.label) : ''}</span>`).join('')}</div>
  </div>`;
}

function scrollTable(label, table) {
  return `<div class="db-table-scroll" style="overflow-x:auto" role="region" tabindex="0" aria-label="${esc(label)}">${table}</div>`;
}

function tableHTML(label, headers, rows) {
  return scrollTable(label, `<table class="db-table" aria-label="${esc(label)}"><thead><tr>${headers.map(h => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
}

function dayTableHTML(cur, period) {
  if (!cur.length) return '';
  const hourly = period === 1, selected = hourly ? metrics.slice(0, 1) : metrics;
  const title = hourly ? 'Таблица по часам' : cur[0].week ? 'Таблица по неделям' : 'Таблица по дням';
  const rows = cur.slice().reverse().map(b => [b.title, ...selected.map(([k]) => formatMetric(k, b.s[k]))]);
  return `<details class="db-details"><summary>${title}</summary>${tableHTML(title,
    [hourly ? 'Час, МСК' : 'Дата, МСК', ...selected.map(([, l]) => l)], rows)}</details>`;
}

function pageCoverage(days) {
  let lower = 0, upper = 0;
  for (const day of days) {
    if (isCount(day.funnel?.visitsWithPages)) {
      lower += day.funnel.visitsWithPages;
      upper += day.funnel.visitsWithPages;
      continue;
    }
    // A legacy histogram can count one visit on several pages.
    const counts = list(day.traffic?.pages)
      .filter(r => labelFor(pages, r?.name) && isCount(r.visits)).map(r => r.visits);
    const editor = count(day.funnel?.editorVisits) ?? 0;
    lower += Math.max(editor, 0, ...counts);
    upper += counts.length ? Math.min(day.visits, Math.max(editor, sum(counts))) : editor ? day.visits : 0;
  }
  return { lower, upper };
}

function funnelHTML(s, days) {
  const { lower, upper } = pageCoverage(days);
  const known = days.length && lower === upper ? lower : null;
  const steps = [
    ['Измеренные визиты', s.visits, s.visits, 'измеренных визитов'],
    ['Открыли редактор', s.editor, known, 'визитов с известными страницами'],
    ['Передали ZIP одной модели', s.editorExport, s.editor, 'визитов редактора'],
    ['Передали ещё один ZIP модели', s.repeatExport, s.editorExport, 'визитов редактора с ZIP модели'],
  ];
  const rows = steps.map(([label, n, base, unit]) => {
    const share = rate(n, base);
    return `<li tabindex="0" ${tip(label, [[num(n), 'визитов'], [num(base), unit]])}>
      <span class="db-f-l">${esc(label)}</span><span class="db-f-track">${share != null ? `<i style="width:${share}%"></i>` : ''}</span>
      <b>${num(n)}</b><span class="db-f-p">${percent(share)}</span>
      <span class="hint db-f-base">${num(n)} из ${num(base)} ${unit}</span></li>`;
  }).join('');
  const coverage = s.visits > 0 ? `Страницы известны для ${lower === upper ? num(lower) : num(lower) + '–' + num(upper)} из ${num(s.visits)} визитов. ` : '';
  return `<ol class="db-funnel">${rows}</ol>` + empty(coverage + 'Повторный экспорт считается в пределах одного визита.');
}

function resultHTML(s) {
  const share = rate(s.editorFiles, s.editor);
  let note = 'В отчёте недостаточно данных для расчёта.';
  if (s.editor === 0) note = 'Визитов с записанной страницей редактора за эти дни нет.';
  else if (share !== null) note = `${num(s.editorFiles)} из ${num(s.editor)} визитов с записанной страницей редактора.`;
  return `<section class="db-card" data-section="result"><h3>Из редактора в файл</h3>
    <p class="db-result-value">${percent(share)}</p><p>${esc(note)}</p>
    <p class="hint">Учитывается передача ZIP модели или набора для скачивания. Оба действия в одном визите дают один результат.</p>
    <details class="db-details"><summary>Границы измерения</summary><p class="hint">Счётчик не видит импорт в Blender, результат MCP и качество модели. Покупки, продления и выручка в этот отчёт не поступают.</p></details></section>`;
}

function heatHTML(days, visits) {
  const grid = Array.from({ length: 7 }, () => Array(24).fill(null));
  let covered = 0;
  for (const day of days) {
    const hours = measuredHours(day);
    if (!hours) continue;
    const row = grid[weekday(Date.parse(day.date))];
    hours.forEach((n, h) => { row[h] = (row[h] ?? 0) + n; covered += n; });
  }
  const max = Math.max(1, ...grid.flat());
  const missing = grid.some(row => row.includes(null)) ? ' · <i class="db-cell is-unknown"></i> нет данных' : '';
  const level = n => n ? Math.min(4, Math.ceil(n / max * 4)) : 0;
  // One tab stop for the map. All cells, including zeroes, support arrow navigation.
  let entry = grid.flat().findIndex(n => n > 0);
  if (entry < 0) entry = Math.max(0, grid.flat().findIndex(n => n != null));
  return `<div class="db-heat" role="group" aria-label="Визиты по дням недели и часам, МСК. Для перемещения используйте стрелки.">
    <span></span>${Array.from({ length: 24 }, (_, h) => `<span class="db-h-x">${h % 3 === 0 ? h : ''}</span>`).join('')}
    ${grid.map((row, d) => `<span class="db-h-y">${weekdays[d]}</span>${row.map((n, h) => {
    const i = d * 24 + h, title = `${weekdays[d]}, ${hourLabel(h)}–${hourLabel((h + 1) % 24)} МСК`;
    return `<i class="db-cell l${level(n)}${n == null ? ' is-unknown' : ''}" data-cell="${i}" tabindex="${i === entry ? 0 : -1}" ${tip(title, [[num(n), 'визитов']])}></i>`;
  }).join('')}`).join('')}
    </div><div class="db-heat-key hint">меньше <i class="db-cell l1"></i><i class="db-cell l2"></i><i class="db-cell l3"></i><i class="db-cell l4"></i> больше · МСК${missing}</div>
    ${visits > covered ? empty(`Час начала известен для ${num(covered)} из ${num(visits)} визитов.`) : ''}`;
}

function publicHost(value) {
  if (typeof value !== 'string' || !value || /[\s\\]/.test(value)) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : 'https://' + value);
    const host = url.hostname.replace(/^(?:www\.)+/, '').replace(/\.$/, '');
    if (url.username || url.password || host.length > 253 ||
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]+)$/.test(host) ||
        /(?:^|\.)(?:uglovato\.ru|localtest\.me|lvh\.me|nip\.io|sslip\.io|localhost|local|localdomain|internal|intranet|private|lan|corp|home|arpa|invalid|test|example|onion)$/.test(host)) return '';
    return host;
  } catch { return ''; }
}

function sourceLabel(item) {
  if (!item || typeof item.source !== 'string') return '';
  switch (item.kind) {
    case 'tag': return tagPattern.test(item.source) ? `ссылка «${item.source}»` : '';
    case 'ref': return publicHost(item.source);
    case 'direct': return item.source === '' ? 'Прямой заход' : '';
    case 'other': return item.source === '' ? 'Другие источники' : '';
    case 'unknown': return item.source === '' ? 'Источник неизвестен' : '';
    default: return '';
  }
}

function sourceGroups(days) {
  const groups = new Map();
  function add(item, date) {
    const label = sourceLabel(item);
    if (!label || !isCount(item.visits)) return false;
    const group = groups.get(label) || { label, kind: item.kind, tag: item.source, first: date, last: date, visits: 0, converted: 0 };
    group.first = date < group.first ? date : group.first;
    group.last = date > group.last ? date : group.last;
    group.visits += item.visits;
    group.converted = sum([group.converted, item.converted]);
    groups.set(label, group);
    return true;
  }
  for (const day of days) {
    let remaining = day.visits, converted = count(day.converted);
    for (const item of list(day.traffic?.sources)) {
      if (!add(item, day.date)) continue;
      remaining -= item.visits;
      converted = converted != null && isCount(item.converted) ? converted - item.converted : null;
    }
    if (remaining > 0) add({ kind: 'unknown', source: '', visits: remaining,
      converted: isCount(converted) && converted <= remaining ? converted : null }, day.date);
  }
  return [...groups.values()].sort(byVisits);
}

function byVisits(a, b) {
  return b.visits - a.visits || a.label.localeCompare(b.label, 'ru');
}

const systems = new Set(['Android', 'iOS', 'iPadOS', 'Windows', 'macOS', 'Linux', 'ChromeOS', 'Other']);
const browsers = new Set(['Chrome', 'Firefox', 'Safari', 'Edge', 'Opera', 'Yandex', 'Samsung', 'Telegram', 'Other']);
const dimensionNames = {
  devices: name => labelFor(devices, name),
  systems: name => systems.has(name) && (name === 'Other' ? 'Другая' : name),
  browsers: name => browsers.has(name) && (name === 'Other' ? 'Другой' : name),
  timezones: name => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(name) && name,
  screens: name => name === 'other' ? 'Другие размеры' : typeof name === 'string' && /^[1-9]\d{0,4}×[1-9]\d{0,4}$/.test(name) && name,
};

function dimensionRows(days, key) {
  const counts = new Map();
  for (const day of days) {
    for (const item of list(day.traffic?.[key])) {
      const label = dimensionNames[key](item?.name);
      if (label && isCount(item.visits)) counts.set(label, (counts.get(label) || 0) + item.visits);
    }
  }
  return [...counts].map(([label, visits]) => ({ label, visits })).sort(byVisits);
}

function barsHTML(title, key, rows, all, max = 6) {
  let shown = rows;
  if (rows.length > max) {
    const rest = rows.slice(max - 1);
    shown = [...rows.slice(0, max - 1), { label: 'Остальные', visits: sum(rest.map(r => r.visits)), converted: sum(rest.map(r => r.converted)) }];
  }
  return `<section class="db-card" data-dimension="${esc(key)}"><h3>${esc(title)}</h3>${shown.length
    ? `<ul class="db-bars">${shown.map(r => {
    const share = rate(r.visits, all);
    const details = [[num(r.visits), 'визитов'], [percent(share), 'от всех визитов']];
    if (key === 'sources') details.push([num(r.converted), 'с экспортом'], [percent(rate(r.converted, r.visits)), 'конверсия в экспорт']);
    return `<li tabindex="0" ${tip(r.label, details)}><span class="db-b-l">${esc(r.label)}</span><b>${num(r.visits)}</b><span class="db-b-p">${percent(share)}</span><span class="db-b-track"><i style="width:${share ?? 0}%"></i></span></li>`;
  }).join('')}</ul>` : empty('Нет данных')}</section>`;
}

function fromsHTML(groups) {
  const tags = groups.filter(r => r.kind === 'tag').sort((a, b) => b.last.localeCompare(a.last) || byVisits(a, b));
  if (!tags.length) return empty('За этот период нет записанных визитов по ссылкам с меткой.');
  return tableHTML('Отклики по меткам', ['Метка', 'Визиты', 'С экспортом', 'Конверсия в экспорт', 'Первый заход', 'Последний заход'],
    tags.map(r => [r.tag, num(r.visits), num(r.converted), percent(rate(r.converted, r.visits)), fullDate(r.first), fullDate(r.last)]));
}

function sectionsHTML(days, total) {
  const seen = new Set();
  for (const day of days) {
    for (const key of ['entries', 'pages']) {
      for (const item of list(day.traffic?.[key])) {
        if (labelFor(pages, item?.name) && isCount(item.visits)) seen.add(item.name);
      }
    }
  }
  if (!seen.size) return empty('Нет данных');
  // Show measured counts with an explicit coverage note when a dimension is missing.
  const observed = total > 0 ? days.filter(d => d.visits > 0) : days;
  const measured = (key, name) => sum(observed.map(d => pageCount(d, key, name)).filter(isCount));
  const rows = [...seen].map(name => ({
    name, entries: measured('entries', name), views: measured('pages', name),
  })).sort((a, b) => (b.views ?? -1) - (a.views ?? -1) || (b.entries ?? -1) - (a.entries ?? -1));
  const top = Math.max(1, ...rows.map(r => r.views ?? 0));
  return scrollTable('Разделы', `<table class="db-table db-table--cases" aria-label="Разделы"><thead><tr><th scope="col">Раздел</th><th scope="col">Страница входа</th><th scope="col">Посетили</th><th scope="col">Доля визитов</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${esc(pages[r.name])}</td><td>${num(r.entries)}</td><td>${r.views == null ? '' : `<span class="db-inline"><i style="width:${r.views / top * 100}%"></i></span>`}${num(r.views)}</td><td>${percent(rate(r.views, total))}</td></tr>`).join('')}
    </tbody></table>`) + empty('Учтены визиты с записанными страницами. Каждый раздел учитывается один раз за визит. Доля показывает зарегистрированные посещения раздела среди всех измеренных визитов за полученные дни.');
}

function tariffsHTML(days) {
  if (!days.length) return empty('Нет данных');
  const total = key => num(sum(days.map(d => d.funnel?.[key])));
  const rows = [['Неделя', total('set_offer_week'), total('set_interest_week')],
    ['Месяц', total('set_offer_month'), total('set_interest_month')],
    ['Любой тариф', total('offerVisits'), total('interestVisits')]];
  const keys = ['set_offer_week', 'set_interest_week', 'set_offer_month', 'set_interest_month', 'set_download'];
  const daily = days.map(d => [fullDate(d.date), ...keys.map(k => num(count(d.funnel?.[k])))]);
  return tableHTML('Интерес к тарифам', ['Тариф', 'Видели цену в наборах', 'Отметили интерес'], rows) +
    `<details class="db-details"><summary>Наборы по дням</summary>${tableHTML('Наборы по дням',
      ['Дата, МСК', 'Цена недели', 'Заявка на неделю', 'Цена месяца', 'Заявка на месяц', 'Скачивали набор'], daily)}</details>`;
}

function visitHTML(v) {
  const traits = [labelFor(devices, v.device), dimensionNames.systems(v.os), dimensionNames.browsers(v.browser),
    dimensionNames.screens(v.screen), dimensionNames.timezones(v.timezone)].filter(Boolean);
  const viewed = [...new Set(list(v.pages).map(k => labelFor(pages, k)).filter(Boolean))];
  const exported = v.converted === true ? 'Экспорт ZIP' : v.converted === false ? 'Без экспорта ZIP' : '';
  return `<li class="db-visit"><span class="db-v-when">${esc(visitFormat.format(v.started))}</span>
    <span class="db-v-main"><b>${esc(sourceLabel(v) || 'Источник неизвестен')}</b> · ${esc(traits.join(', ') || 'Нет данных')}
    <span class="hint">Вход: ${esc(labelFor(pages, v.entry) || '—')} · Страницы: ${esc(viewed.join(', ') || '—')}</span></span>
    <span class="db-v-tags">${exported ? `<span class="db-tag">${esc(exported)}</span>` : ''}</span></li>`;
}

function linkBuilderHTML() {
  return `<div class="db-link">
    <label class="f"><span>Страница</span><select class="inp" data-stats-page aria-label="Страница">${Object.entries(pages).map(([key, name]) => `<option value="${esc(key)}">${esc(name)}</option>`).join('')}</select></label>
    <label class="f st-co"><span>Метка источника</span><input type="text" class="inp" data-stats-co placeholder="telegram_post" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
    <code class="st-link" data-stats-link tabindex="0" aria-label="Ссылка с меткой">—</code><button class="btn btn--sm" type="button" data-act="stats-copy" disabled>Скопировать ссылку</button>
    <span class="hint" data-link-note role="status"></span></div>`;
}

function dashBody(days, previous, period, end, recent) {
  const has = period > 0 && days.length === period && previous?.length === period;
  const s = summary(days), p = summary(has ? previous : []);
  const cur = buckets(days, period, end);
  const prev = has ? buckets(previous, period, dateKey(Date.parse(end) - period * dayMs)) : [];
  const groups = sourceGroups(days);
  const unknown = groups.find(r => r.kind === 'unknown')?.visits ?? 0;
  const dimensions = [['devices', 'Устройство'], ['systems', 'Система'], ['browsers', 'Браузер'],
    ['timezones', 'Часовой пояс'], ['screens', 'Экран']];
  const from = period === 0 ? firstReportDay : dateKey(Date.parse(end) - (period - 1) * dayMs);
  const range = from < end ? fullDate(from) + ' – ' + fullDate(end) : fullDate(end);
  let notice = '';
  if (!days.length) notice = 'За выбранный период нет данных счётчика. Выберите другой период или обновите отчёт.';
  else if (!s.visits) notice = 'За этот период измеренных визитов не было.';
  const metricNotes = {
    visits: 'измерено за полученные дни', editor: 'по записанным страницам', converted: 'хотя бы один ZIP модели',
    exports: 'операций с одной моделью', rate: `${num(s.converted)} из ${num(s.visits)} визитов`, downloads: 'хотя бы один ZIP набора',
  };
  return `<div class="db-kpis">${metrics.map(([key, label]) =>
    kpi(key, label, s[key], p[key], has, cur.map(b => b.s[key]), metricNotes[key])).join('')}</div>
    ${notice ? `<p class="db-empty">${esc(notice)}</p>` : ''}
    <div class="db-row"><section class="db-card" data-section="funnel"><h3>Путь до экспорта</h3>${funnelHTML(s, days)}</section>${resultHTML(s)}</div>
    <section class="db-card db-card--wide" data-section="trend"><h3>Визиты</h3><p class="hint">${esc(range)} · МСК</p>
      ${trendHTML(cur, prev, has, period)}${period === 1 && days.length ? empty('По часам показаны визиты с известным временем начала.') : ''}${dayTableHTML(cur, period)}</section>
    <section class="db-card db-card--wide" data-section="heat"><h3>Когда заходят</h3>${heatHTML(days, s.visits)}</section>
    <section class="db-card db-card--wide" data-section="tags"><h3>Переходы по ссылкам с меткой</h3>${fromsHTML(groups)}
      ${s.visits ? empty(`Источник известен для ${num(s.visits - unknown)} из ${num(s.visits)} визитов.`) : ''}
      ${groups.some(r => r.kind === 'other') ? empty('В «Другие источники» попадают метки и домены сверх суточного лимита в 64 источника.') : ''}
      ${linkBuilderHTML()}</section>
    <div class="db-grid4">${barsHTML('Откуда', 'sources', groups, s.visits)}
      ${dimensions.map(([key, title]) => barsHTML(title, key, dimensionRows(days, key), s.visits)).join('')}</div>
    <section class="db-card db-card--wide" data-section="pages"><h3>Разделы</h3>${sectionsHTML(days, s.visits)}</section>
    <section class="db-card db-card--wide" data-section="tariffs"><h3>Интерес к тарифам в окне наборов</h3><p class="hint">Считаются визиты с событием в редакторе. Показы цен и действия в кабинете сюда не попадают.</p>${tariffsHTML(days)}</section>
    <div data-ai-report></div>
    <section class="db-card db-card--wide" data-section="recent"><h3>Последние визиты в браузере</h3>
      ${recent.length ? `<ul class="db-visits">${recent.slice(0, 20).map(visitHTML).join('')}</ul>` : empty('Нет данных')}
      ${recent.length > 20 ? `<button class="btn btn--line btn--sm" type="button" data-act="stats-more">Показать ещё (${num(recent.length - 20)})</button>` : ''}
    </section>`;
}

function bindLinkBuilder(root, signal) {
  const input = root.querySelector('[data-stats-co]'), page = root.querySelector('[data-stats-page]');
  const output = root.querySelector('[data-stats-link]'), copy = root.querySelector('[data-act="stats-copy"]');
  const note = root.querySelector('[data-link-note]');
  function update() {
    const valid = tagPattern.test(input.value) && Object.hasOwn(pages, page.value);
    const url = new URL(page.value === 'home' ? '/' : '/' + page.value + '/', 'https://uglovato.ru');
    url.searchParams.set('from', input.value);
    output.textContent = valid ? url.href : '—';
    copy.disabled = !valid;
    input.setAttribute('aria-invalid', String(Boolean(input.value && !valid)));
    note.textContent = input.value && !valid ? 'До 40 символов: строчные латинские буквы, цифры, дефис и подчёркивание.' : '';
  }
  input.addEventListener('input', update, { signal });
  page.addEventListener('change', update, { signal });
  copy.addEventListener('click', async () => {
    if (copy.disabled) return;
    const link = output.textContent;
    try {
      await root.ownerDocument.defaultView.navigator.clipboard.writeText(link);
      if (!signal.aborted && output.textContent === link) note.textContent = 'Ссылка скопирована.';
    } catch {
      if (signal.aborted || output.textContent !== link) return;
      output.focus();
      const range = root.ownerDocument.createRange(), selection = root.ownerDocument.getSelection();
      range.selectNodeContents(output);
      selection.removeAllRanges();
      selection.addRange(range);
      note.textContent = 'Ссылка выделена. Скопируйте её вручную.';
    }
  }, { signal });
}

function bindTooltips(root, signal) {
  const doc = root.ownerDocument, win = doc.defaultView;
  const box = doc.createElement('div');
  box.hidden = true;
  box.className = 'db-tip';
  box.setAttribute('role', 'tooltip');
  box.setAttribute('data-dbtip', '');
  root.append(box);
  let hover = null, focus = null;

  function tipShow(el) {
    if (!el) { box.hidden = true; return; }
    const heading = doc.createElement('div');
    heading.className = 'db-tip-h';
    heading.textContent = el.dataset.tip;
    box.replaceChildren(heading);
    for (const [value, label] of JSON.parse(el.dataset.tipRows)) {
      const row = doc.createElement('div'), b = doc.createElement('b');
      b.textContent = value;
      row.append(b, doc.createTextNode(' ' + label));
      box.append(row);
    }
    box.hidden = false;
    const rc = el.getBoundingClientRect(), w = box.offsetWidth, h = box.offsetHeight;
    const x = Math.max(8, Math.min(win.innerWidth - w - 8, rc.left + (rc.width - w) / 2));
    const above = rc.top - h - 8;
    const y = above < 8 ? Math.max(8, Math.min(rc.bottom + 8, win.innerHeight - h - 8)) : above;
    box.style.left = x + 'px';
    box.style.top = y + 'px';
  }
  const target = node => root.contains(node) ? node?.closest?.('[data-tip][data-tip-rows]') : null;
  root.addEventListener('pointerover', e => {
    hover = target(e.target);
    tipShow(hover || focus);
  }, { signal });
  root.addEventListener('pointerout', e => {
    hover = target(e.relatedTarget);
    tipShow(hover || focus);
  }, { signal });
  root.addEventListener('focusin', e => {
    focus = target(e.target);
    tipShow(focus);
  }, { signal });
  root.addEventListener('focusout', e => {
    focus = target(e.relatedTarget);
    tipShow(focus || hover);
  }, { signal });
  root.addEventListener('keydown', e => {
    if (e.key === 'Escape') { tipShow(null); return; }
    const cell = e.target.closest('[data-cell]');
    if (!cell || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    const i = Number(cell.dataset.cell), start = i - i % 24;
    const next = { ArrowLeft: Math.max(start, i - 1), ArrowRight: Math.min(start + 23, i + 1),
      ArrowUp: Math.max(i % 24, i - 24), ArrowDown: Math.min(144 + i % 24, i + 24), Home: start, End: start + 23 }[e.key];
    e.preventDefault();
    const grid = cell.closest('.db-heat'), nextCell = grid.querySelector(`[data-cell="${next}"]`);
    grid.querySelector('[tabindex="0"]').tabIndex = -1;
    nextCell.tabIndex = 0;
    nextCell.focus();
  }, { signal });
  const hide = () => tipShow(null);
  doc.addEventListener('scroll', hide, { capture: true, signal });
  win.addEventListener('resize', hide, { signal });
}

const mounted = new WeakMap();

export function clearDashboard(root) {
  mounted.get(root)?.abort();
  mounted.delete(root);
  root.replaceChildren();
}

export function renderDashboard(root, { days, previous = null, period, end }) {
  clearDashboard(root);
  const records = days.filter(d => d.date >= firstReportDay && d.date <= end);
  const recent = records.flatMap(d => list(d.traffic?.recent))
    .filter(v => isCount(v?.started) && Number.isFinite(new Date(v.started).getTime()))
    .sort((a, b) => b.started - a.started);
  root.innerHTML = dashBody(records, previous, period, end, recent);
  const controller = new root.ownerDocument.defaultView.AbortController();
  mounted.set(root, controller);
  const { signal } = controller;
  bindLinkBuilder(root, signal);
  bindTooltips(root, signal);
  const more = root.querySelector('[data-act="stats-more"]');
  if (more) {
    const visits = root.querySelector('.db-visits');
    let shown = visits.children.length;
    more.addEventListener('click', () => {
      const next = recent.slice(shown, shown + 40);
      visits.insertAdjacentHTML('beforeend', next.map(visitHTML).join(''));
      shown += next.length;
      if (shown >= recent.length) more.remove();
      else more.textContent = `Показать ещё (${num(recent.length - shown)})`;
    }, { signal });
  }
  mountAiReport(root.querySelector('[data-ai-report]'), { period, end });
}
