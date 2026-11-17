import { renderDashboard, clearDashboard } from './dashboard.js';
import { clearAiReport } from './ai-report.js';

const el = id => document.getElementById(id);
const reportTimeoutMs = 15000;
const dayMs = 86400000;
// First production release of the private product counter.
const firstReportDay = '2026-11-16';
const periods = [1, 7, 30, 90, 0];
const todayMSK = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
const shiftDate = (date, days) => new Date(Date.parse(date) + days * dayMs).toISOString().slice(0, 10);
const countDays = (first, last) => Math.round((Date.parse(last) - Date.parse(first)) / dayMs) + 1;

function reportStatus(message, error = false) {
  el('status').classList.toggle('is-error', error);
  el('status').textContent = message;
}

async function fetchReport(url, key, signal) {
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, reportTimeoutMs);
    try {
      const result = await fetch(url, {
        method: 'GET', headers: { 'X-Report-Key': key }, signal: controller.signal, redirect: 'error',
        credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      });
      controller.signal.throwIfAborted();
      if (attempt === 1 && [502, 503, 504].includes(result.status)) continue;
      if (result.status === 401) return { unauthorized: true };
      if (!result.ok) throw new Error('Report unavailable');
      const { days, access } = await result.json();
      if (access !== 'owner' && access !== 'report') throw new Error('Invalid access');
      controller.signal.throwIfAborted();
      return { days, access };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      abort(); // Release any unread error response before the next attempt.
    }
  }
}

function validateDays(days, count, end) {
  const first = shiftDate(end, 1 - count);
  if (!Array.isArray(days) || days.length > count) throw new Error('Invalid report');
  for (const [i, day] of days.entries()) {
    if (!day || typeof day.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.date) ||
        !Number.isFinite(Date.parse(day.date)) || shiftDate(day.date, 0) !== day.date ||
        day.date < first || day.date > end || (i && day.date >= days[i-1].date)) throw new Error('Wrong period');
    if (![day.visits, day.exports, day.converted].every(n => Number.isSafeInteger(n) && n >= 0) ||
        day.converted > Math.min(day.visits, day.exports)) throw new Error('Invalid report');
  }
}

// The collector supports windows of 1, 7 or 30 days. Slice its last window at
// the requested boundary; never infer a missing day from a partial response.
async function loadRange(count, end, currentEnd, proof, signal, setAccess) {
  const rows = [];
  for (let offset = 0; offset < count; offset += 30) {
    const needed = Math.min(30, count - offset);
    const batch = needed === 1 ? 1 : needed <= 7 ? 7 : 30;
    const last = shiftDate(end, -offset);
    const url = new URL('https://functions.yandexcloud.net/d4e88h7r9h993fogte3l');
    url.searchParams.set('days', String(batch));
    if (!currentEnd || offset) url.searchParams.set('end', last);
    const answer = await fetchReport(url, proof, signal);
    signal.throwIfAborted();
    if (answer.unauthorized) throw new Error('Unauthorized');
    setAccess(answer.access);
    validateDays(answer.days, batch, last);
    const first = shiftDate(last, 1 - needed);
    rows.push(...answer.days.filter(day => day.date >= first));
  }
  return rows;
}

export function createAdminReport({ getProof, setAccess, opened, denied, failed }) {
  const root = el('dashboard-root');
  const date = el('end-date');
  const selector = el('period');
  const buttons = [...el('report').querySelectorAll('button[data-days]')];
  let request;

  function showPeriod() {
    for (const button of buttons) {
      const historicalDay = button.dataset.days === '1' && date.value && date.value !== todayMSK();
      button.setAttribute('aria-pressed', String(button.dataset.days === selector.value && !historicalDay));
    }
  }

  function clear() {
    request?.abort();
    request = null;
    el('report').hidden = true;
    if (!date.validity.valid) date.value = '';
    reportStatus('');
    clearDashboard(root);
    clearAiReport();
  }

  async function report() {
    const proof = getProof();
    if (!proof) return;
    request?.abort();
    request = new AbortController();
    const { signal } = request;
    const period = Number(selector.value);
    date.max = todayMSK();
    showPeriod();
    clearDashboard(root);
    if (!periods.includes(period) || !date.validity.valid) {
      reportStatus('Выбери дату не позже сегодняшней по Москве.', true);
      return;
    }
    const end = date.value || date.max;
    const span = period || Math.max(1, countDays(firstReportDay, end));
    const previousEnd = shiftDate(end, -span);
    reportStatus('Загружаем отчёт…');
    try {
      const days = await loadRange(span, end, !date.value, proof, signal, setAccess);
      let previous = null, comparisonFailed = false;
      if (period && days.length === span && shiftDate(previousEnd, 1 - span) >= firstReportDay) {
        try {
          const rows = await loadRange(span, previousEnd, false, proof, signal, setAccess);
          if (rows.length === span) previous = rows;
        } catch (error) {
          if (signal.aborted || error.message === 'Unauthorized') throw error;
          comparisonFailed = true;
        }
      }
      signal.throwIfAborted();
      renderDashboard(root, { days, previous, period, end });
      const opening = el('report').hidden;
      el('report').hidden = false;
      opened();
      const notes = [];
      if (days.length < span) notes.push('Получено дней: ' + days.length + ' из ' + span + '.');
      if (comparisonFailed) notes.push('Прошлый период временно недоступен.');
      reportStatus(notes.join(' '));
      if (opening) buttons.find(b => b.dataset.days === selector.value)?.focus({preventScroll: true});
    } catch (error) {
      if (signal.aborted) return;
      clearDashboard(root);
      if (error.message === 'Unauthorized') { denied(); return; }
      failed();
      reportStatus(error.message === 'Wrong period'
        ? 'Сервер вернул другой период. Проверь дату или очисти её для просмотра последних дней.'
        : 'Не удалось загрузить статистику. Попробуй ещё раз.', true);
    }
  }

  for (const button of buttons) {
    button.addEventListener('click', () => {
      const resetDate = button.dataset.days === '1' && Boolean(date.value);
      if (selector.value === button.dataset.days && !resetDate) return;
      if (resetDate) date.value = '';
      selector.value = button.dataset.days;
      report();
    });
  }
  el('refresh').onclick = report;
  selector.onchange = report;
  date.max = todayMSK();
  date.onchange = report;
  showPeriod();
  return { open: report, clear };
}
