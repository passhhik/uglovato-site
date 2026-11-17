// Timeweb App Platform frontend access log, adapted from the portfolio's ai-traffic parser.
const agents = [
  ['ChatGPT-User', 'ChatGPT', 'request'],
  ['Claude-User', 'Claude', 'request'],
  ['Claude-Agent', 'Claude', 'request'],
  ['Perplexity-User', 'Perplexity', 'request'],
  ['OAI-SearchBot', 'OpenAI', 'crawler'],
  ['GPTBot', 'OpenAI', 'crawler'],
  ['Claude-SearchBot', 'Claude', 'crawler'],
  ['ClaudeBot', 'Claude', 'crawler'],
  ['PerplexityBot', 'Perplexity', 'crawler'],
].map(([name, service, kind]) => ({
  name, service, kind, match: new RegExp('(?:^|[\\s;(])' + name + '(?=/|[\\s;)]|$)', 'i'),
}));

const pageNames = new Map([
  ['/', 'Главная'], ['/editor/', 'Редактор'], ['/guide/', 'Инструкция'],
  ['/connect/', 'Подключение ИИ'], ['/privacy/', 'Конфиденциальность'],
]);
const publicPage = /^\/(?:index\.html|(?:editor|guide|connect|privacy)(?:\/(?:index\.html)?)?)?$/;
const logLine = /^\S+\s+\[([^\]]+)\]\s+"(\S+) (\S+) HTTP\/[\d.]+"\s+(\d{3})\s+(?:\d+|-)(?:\s+"([^"]*)")?\s+"([^"]*)"$/;
const timeFormat = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'medium',
});
const dayMs = 86400000;
let active = null;

function readLog(text) {
  let parsed = 0;
  const grouped = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = logLine.exec(line.trim());
    if (!match) continue;
    const [, time, method, target, status, host, ua] = match;
    const clock = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d(?:\.\d+)?)(Z|[+-]\d\d:?\d\d)?$/i.exec(time);
    if (!clock) continue;
    const at = Date.parse(clock[1] + 'T' + clock[2] + (clock[3] || '+03:00'));
    if (!Number.isFinite(at)) continue;
    parsed++;
    if (host && host !== '-' && !/^(?:www\.)?uglovato\.ru(?::(?:80|443))?$/i.test(host)) continue;
    if (method !== 'GET' || (status !== '200' && status !== '304') || /PortfolioAnalyticsCheck\//.test(ua)) continue;
    const path = target.split(/[?#]/, 1)[0];
    if (!publicPage.test(path)) continue;
    const agent = agents.find(rule => rule.match.test(ua));
    if (!agent) continue;
    const page = path.replace(/(?:\/index\.html|\/)$/, '') + '/';
    const key = [at, page, agent.name].join('|');
    const row = grouped.get(key);
    if (row) row.count++;
    else grouped.set(key, { at, page, agent, count: 1 });
  }
  return { parsed, grouped };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function fillList(container, rows, kind, empty) {
  const selected = rows.filter(row => row.agent.kind === kind);
  if (!selected.length) {
    container.replaceChildren(element('p', 'hint', empty));
    return;
  }
  const list = element('ul', 'db-visits');
  for (const { at, agent, page, count } of selected.slice(0, 100)) {
    const item = element('li', 'db-visit');
    const main = element('span', 'db-v-main');
    main.append(element('b', '', agent.service), ' · ' + pageNames.get(page) + (count > 1 ? ' × ' + count : ''),
      element('span', 'hint', agent.name + ' · По названию клиента'));
    item.append(element('span', 'db-v-when', timeFormat.format(at)), main);
    list.append(item);
  }
  container.replaceChildren(list);
  if (selected.length > 100) container.append(element('p', 'hint', 'Показаны последние 100 записей.'));
}

function updateLists(view) {
  const midnight = Date.parse(view.end + 'T00:00:00+03:00');
  const until = midnight + dayMs;
  const since = view.period ? until - view.period * dayMs : -Infinity;
  const rows = [...view.rows.values()].filter(({ at }) => at >= since && at < until).sort((a, b) => b.at - a.at);
  fillList(view.requests, rows, 'request', 'В доступных записях за этот период нет запросов распознанных ассистентов.');
  fillList(view.crawlers, rows, 'crawler', 'Распознанных обходов за период нет.');
}

async function importFile(view, file) {
  if (active !== view || !file || view.input.disabled) return;
  if (file.size > 32 * 1024 * 1024) {
    view.status.textContent = 'Выберите текстовый журнал объёмом до 32 МБ.';
    return;
  }
  view.input.disabled = true;
  view.status.textContent = 'Читаем журнал…';
  try {
    const text = await file.text();
    if (active !== view) return;
    const { parsed, grouped } = readLog(text);
    if (!parsed) {
      view.status.textContent = 'Не найдены строки журнала доступа Timeweb. Выберите выгрузку из «Логов доступа».';
      return;
    }
    // Overlapping snapshots retain the largest observed count for each group.
    for (const [key, row] of grouped) {
      if (row.count > (view.rows.get(key)?.count || 0)) view.rows.set(key, row);
    }
    updateLists(view);
    view.status.textContent = 'Журнал загружен. Последний ручной импорт — ' + timeFormat.format(Date.now()) + ' МСК.';
  } catch {
    if (active === view) view.status.textContent = 'Не удалось прочитать файл. Выберите текстовый журнал ещё раз.';
  } finally {
    if (active === view) view.input.disabled = false;
  }
}

function createView() {
  const card = element('section', 'db-card db-card--wide');
  const requests = element('div'), crawlers = element('div');
  const crawlDetails = element('details', 'db-details'), fileDetails = element('details', 'db-details');
  crawlDetails.append(element('summary', '', 'Автоматические обходы'), crawlers);
  const input = element('input');
  input.type = 'file';
  input.accept = '.txt,.log,text/plain';
  input.dataset.aiFile = '';
  input.setAttribute('aria-label', 'Журнал доступа Timeweb');
  fileDetails.append(element('summary', '', 'Загрузить журнал Timeweb'),
    element('p', 'hint', 'Выберите текстовый файл из «Логов доступа» приложения «Угловато». Браузер обрабатывает его локально. Записи доступны до выхода из статистики.'), input);
  const status = element('p', 'hint');
  status.setAttribute('role', 'status');
  card.append(element('h3', '', 'Обращения ИИ'),
    element('p', 'hint', 'Источник — ручной импорт журнала Timeweb. Время указано по Москве.'),
    requests, crawlDetails, fileDetails, status);
  const view = { card, requests, crawlers, input, status, rows: new Map() };
  input.onchange = () => {
    const file = input.files[0];
    input.value = '';
    return importFile(view, file);
  };
  return view;
}

export function mountAiReport(container, { period, end }) {
  active ??= createView();
  active.period = Number(period);
  active.end = end;
  container.replaceChildren(active.card);
  updateLists(active);
}

export function clearAiReport() {
  if (!active) return;
  active.input.onchange = null;
  active.card.remove();
  active.card.replaceChildren();
  active.requests.replaceChildren();
  active.crawlers.replaceChildren();
  active.status.textContent = '';
  active.rows.clear();
  active = null;
}
