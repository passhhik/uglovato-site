const el = id => document.getElementById(id);
const dateFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow' });
const rubles = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' });
const limit = 25;
const date = iso => dateFormat.format(Date.parse(iso));
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const nullableDate = value => value === null || validDate(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const invalid = () => new Error('invalid_reply');

function readUser(row) {
  if (!row || typeof row.id !== 'string' || !row.id || typeof row.hasUsername !== 'boolean' ||
      !count(row.passkeyCount) || typeof row.hadPromo !== 'boolean' ||
      ![row.createdAt, row.disabledAt, row.paidUntil, row.promoUntil].every(nullableDate)) throw invalid();
  const { id, name = null, email = null, hasUsername, passkeyCount, hadPromo, createdAt, disabledAt, paidUntil, promoUntil } = row;
  if ((name !== null && typeof name !== 'string') || (email !== null && typeof email !== 'string')) throw invalid();
  return { id, name, email, hasUsername, passkeyCount, hadPromo, createdAt, disabledAt, paidUntil, promoUntil };
}

function validatePage(data, items, usedCursors) {
  if (!validDate(data?.asOf) || !Array.isArray(items) || items.length > limit ||
      !(data.nextCursor === null || (typeof data.nextCursor === 'string' && data.nextCursor && !usedCursors.has(data.nextCursor)))) throw invalid();
}

function remaining(until, now) {
  const ms = until - now;
  if (!(ms > 0)) return '0';
  const minutes = Math.floor(ms / 60000);
  if (!minutes) return 'меньше минуты';
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes / 60) % 24;
  return [days && days + ' дн.', hours && hours + ' ч.', minutes % 60 && minutes % 60 + ' мин.'].filter(Boolean).join(' ');
}

function sourcePeriod(until, now, absent) {
  if (!until) return absent;
  return (Date.parse(until) > now ? 'Активен до ' : 'Истёк ') + date(until);
}

function node(tag, text, className) {
  const n = document.createElement(tag);
  if (text) n.textContent = text;
  if (className) n.className = className;
  return n;
}

function button(text) {
  const b = node('button', text, 'btn btn--line btn--sm');
  b.type = 'button';
  return b;
}

function field(dl, label, value) {
  const pair = node('div');
  pair.append(node('dt', label), node('dd', value));
  dl.append(pair);
}

function historyEntry(item) {
  if (!item || !(typeof item.id === 'string' && item.id || count(item.id))) throw invalid();
  const row = node('li'), fields = node('dl');
  row.dataset.historyKind = item.kind;
  if (item.kind === 'payment') {
    if (!['live', 'test'].includes(item.mode) || !['paid', 'pending'].includes(item.status) ||
        !['week', 'month'].includes(item.offer) || !count(item.amountKopecks) ||
        ![item.createdAt, item.paidAt, item.validUntil].every(nullableDate)) throw invalid();
    const title = (item.mode === 'test' ? 'Тестовый счёт' : 'Счёт') + ' · ' + (item.status === 'paid' ? 'Оплачен' : 'Не оплачен');
    row.append(node('strong', title));
    field(fields, 'ID счёта', String(item.id));
    field(fields, 'Тариф', item.offer === 'week' ? 'Неделя' : 'Месяц');
    field(fields, 'Сумма', rubles.format(item.amountKopecks / 100));
    field(fields, 'Создан', item.createdAt ? date(item.createdAt) : 'Дата неизвестна');
    if (item.status === 'paid') field(fields, 'Оплачен', item.paidAt ? date(item.paidAt) : 'Дата неизвестна');
    if (item.validUntil) field(fields, 'Срок до', date(item.validUntil));
  } else if (item.kind === 'promo') {
    if (!['active', 'expired', 'revoked'].includes(item.status) || !count(item.days) ||
        ![item.redeemedAt, item.expiresAt, item.revokedAt].every(nullableDate)) throw invalid();
    row.append(node('strong', 'Промокод · ' + { active: 'Активен', expired: 'Истёк', revoked: 'Отозван' }[item.status]));
    field(fields, 'ID промокода', String(item.id));
    field(fields, 'Дней', String(item.days));
    field(fields, 'Активирован', item.redeemedAt ? date(item.redeemedAt) : 'Дата неизвестна');
    field(fields, 'Срок до', item.expiresAt ? date(item.expiresAt) : 'Дата неизвестна');
    if (item.status === 'revoked') field(fields, 'Отозван', item.revokedAt ? date(item.revokedAt) : 'Дата неизвестна');
  } else throw invalid();
  row.append(fields);
  return row;
}

export function createAdminUsers({ post, opened, denied, failed }) {
  const accounts = new Map(), cursors = new Set();
  const dialog = el('user-confirmation');
  let request, historyView, target, nextCursor, asOf;

  function note(text, error = false) {
    el('users-status').textContent = text;
    el('users-status').classList.toggle('is-error', error);
  }

  function closeHistory() {
    if (!historyView) return;
    historyView.request?.abort();
    historyView.toggle.setAttribute('aria-expanded', 'false');
    historyView.panel.hidden = true;
    historyView.list.replaceChildren();
    historyView.panel.replaceChildren();
    historyView = null;
  }

  function dismiss() {
    target = null;
    if (dialog.open) dialog.close();
    for (const id of ['user-confirm-title', 'user-target', 'user-consequence']) el(id).textContent = '';
  }

  function updateControls() {
    for (const control of el('users').querySelectorAll('button, input, select')) control.disabled = Boolean(request);
    el('users-more').hidden = !nextCursor;
  }

  function clear() {
    request?.abort();
    request = null;
    closeHistory();
    dismiss();
    accounts.clear();
    cursors.clear();
    nextCursor = asOf = null;
    el('users-list').replaceChildren();
    el('users-search').reset();
    el('users-empty').hidden = el('users').hidden = true;
    el('users-asof').textContent = '';
    note('');
    updateControls();
  }

  async function loadHistory(view) {
    if (historyView !== view || view.request) return;
    const current = new AbortController();
    view.request = current;
    view.note.textContent = 'Загружаем историю…';
    view.more.hidden = view.retry.hidden = true;
    const timer = setTimeout(() => current.abort(), 15000);
    try {
      const body = { accountId: view.id, limit };
      if (view.cursor) body.cursor = view.cursor;
      const data = await post('history', body, current.signal);
      if (historyView !== view) return;
      current.signal.throwIfAborted();
      validatePage(data, data?.items, view.cursors);
      const entries = data.items.map(historyEntry);
      view.list.append(...entries);
      view.cursor = data.nextCursor;
      if (view.cursor) view.cursors.add(view.cursor);
      view.more.hidden = !view.cursor;
      view.note.textContent = view.list.childElementCount ? 'На ' + date(data.asOf) + ' МСК' :
        view.cursor ? 'На этой странице записей нет.' : 'Счетов и использованных промокодов нет.';
    } catch (error) {
      if (historyView !== view) return;
      if (error.status === 401 && error.code === 'promo_admin_unauthorized') return denied();
      view.note.textContent = error.status === 429 ? 'Слишком много запросов. Повторите позднее.' :
        'История сейчас недоступна. Повторите загрузку.';
      view.retry.hidden = false;
    } finally {
      clearTimeout(timer);
      view.request = null;
    }
  }

  function toggleHistory(id, toggle, panel) {
    const wasOpen = historyView?.id === id;
    closeHistory();
    if (wasOpen || !accounts.has(id) || request) return;
    const list = node('ul', '', 'user-history-list'), status = node('p', '', 'hint');
    status.setAttribute('role', 'status');
    const more = button('Показать ещё'), retry = button('Повторить');
    more.dataset.historyMore = retry.dataset.historyRetry = '';
    const view = { id, toggle, panel, list, note: status, more, retry, cursors: new Set(), cursor: null };
    more.onclick = retry.onclick = () => loadHistory(view);
    historyView = view;
    panel.replaceChildren(node('h3', 'История счетов и промокодов'), status, list, more, retry);
    panel.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    loadHistory(view);
  }

  function confirmChange(user) {
    if (request || accounts.get(user.id) !== user) return;
    const disabled = !user.disabledAt;
    target = { accountId: user.id, disabled };
    el('user-confirm-title').textContent = disabled ? 'Отключить аккаунт?' : 'Восстановить аккаунт?';
    el('user-target').textContent = user.id;
    el('user-consequence').textContent = disabled
      ? 'Пользователь выйдет из всех сессий и не сможет войти. Сроки оплаты и промокодов продолжат идти.'
      : 'Пользователь сможет войти заново. Старые сессии останутся закрытыми. Действующие сроки оплаты и промокодов сохранятся.';
    el('user-confirm').textContent = disabled ? 'Отключить' : 'Восстановить';
    dialog.showModal();
  }

  function render() {
    closeHistory();
    const list = el('users-list'), fragment = document.createDocumentFragment();
    const now = Date.parse(asOf);
    for (const user of accounts.values()) {
      const row = node('li', '', 'db-card user-card');
      row.dataset.accountId = user.id;
      const fields = node('dl');
      const until = Math.max(Date.parse(user.paidUntil) || 0, Date.parse(user.promoUntil) || 0);
      const methods = [];
      if (user.hasUsername) methods.push(user.email ? 'Почта и пароль' : 'Логин и пароль');
      if (user.passkeyCount) methods.push('Ключи доступа (passkey): ' + user.passkeyCount);
      field(fields, 'Имя', user.name || 'Не указано');
      field(fields, 'Почта', user.email || 'Не указана');
      field(fields, 'Регистрация', user.createdAt ? date(user.createdAt) : 'Дата неизвестна');
      field(fields, 'Способы входа', methods.join(' · ') || 'Нет');
      field(fields, 'Аккаунт', user.disabledAt ? 'Отключён ' + date(user.disabledAt) : 'Включён');
      field(fields, 'Доступ к наборам', user.disabledAt ? 'Закрыт' : until > now ? 'Активен' : until ? 'Истёк' : 'Нет активного периода');
      field(fields, 'Оплаченный период', sourcePeriod(user.paidUntil, now, 'Нет'));
      field(fields, 'Промодоступ', sourcePeriod(user.promoUntil, now, user.hadPromo ? 'Был ранее' : 'Нет'));
      field(fields, 'Осталось по сроку', remaining(until, now));
      const actions = node('div', '', 'row'), toggle = button('История');
      const change = button(user.disabledAt ? 'Восстановить' : 'Отключить');
      change.dataset.userAction = user.disabledAt ? 'restore' : 'disable';
      change.setAttribute('aria-label', change.textContent + ' аккаунт ' + user.id);
      change.onclick = () => confirmChange(user);
      const panel = node('section', '', 'user-history');
      panel.dataset.historyPanel = toggle.dataset.userHistory = '';
      panel.hidden = true;
      panel.id = 'users-history-' + fragment.childElementCount;
      toggle.setAttribute('aria-controls', panel.id);
      toggle.setAttribute('aria-expanded', 'false');
      toggle.onclick = () => toggleHistory(user.id, toggle, panel);
      actions.append(toggle, change);
      row.append(node('h2', 'ID ' + user.id), fields, actions, panel);
      fragment.append(row);
    }
    list.replaceChildren(fragment);
    el('users-asof').textContent = 'Данные на ' + date(asOf) + ' МСК';
    el('users-empty').hidden = accounts.size > 0;
  }

  async function run(action, body, accept) {
    if (request) return;
    closeHistory();
    dismiss();
    const current = new AbortController();
    request = current;
    updateControls();
    note(action === 'list' ? 'Ищем пользователей…' : 'Обновляем статус аккаунта…');
    const timer = setTimeout(() => current.abort(), 15000);
    try {
      const data = await post(action, body, current.signal);
      if (request !== current) return;
      current.signal.throwIfAborted();
      accept(data);
      opened();
    } catch (error) {
      if (request !== current) return;
      if (error.message === 'relay_unconfigured') {
        note('Подключение кабинета ещё не настроено. После настройки обновите страницу.', true);
        return;
      }
      if (error.status === 401 && error.code === 'promo_admin_unauthorized') return denied();
      if (error.status === 400 && error.code === 'invalid_request' && action === 'list' && (body.accountId || body.username || body.email)) {
        note('Проверьте ' + (body.accountId ? 'ID аккаунта' : body.email ? 'адрес почты' : 'логин') + ' и повторите поиск.', true);
        return;
      }
      if (action === 'status') {
        failed(() => load({ accountId: body.accountId }), 'Проверить статус');
        note('Смена статуса не подтверждена. Проверьте текущее состояние аккаунта.', true);
      } else {
        failed(() => load(body));
        note(error.status === 429 ? 'Слишком много запросов. Повторите позднее.' :
          'Список пользователей сейчас недоступен. Повторите загрузку.', true);
      }
    } finally {
      clearTimeout(timer);
      if (request === current) { request = null; updateControls(); }
    }
  }

  function load(body = { limit }) {
    const append = Boolean(body.cursor), searching = Boolean(body.username || body.email || body.accountId);
    if (request) return;
    if (!append) {
      accounts.clear();
      cursors.clear();
      nextCursor = null;
      el('users-list').replaceChildren();
      el('users-asof').textContent = '';
      el('users-empty').hidden = true;
    }
    return run('list', body, data => {
      validatePage(data, data?.users, cursors);
      const rows = data.users.map(readUser);
      if (searching && (data.nextCursor || rows.length > 1 || (body.accountId && rows.some(u => u.id !== body.accountId)))) throw invalid();
      for (const row of rows) accounts.set(row.id, row);
      nextCursor = data.nextCursor;
      if (nextCursor) cursors.add(nextCursor);
      asOf = data.asOf;
      el('users-empty').textContent = nextCursor ? 'На этой странице нет пользователей.' :
        searching ? 'Пользователь не найден.' : 'Пользователей пока нет.';
      el('users').hidden = false;
      render();
      note('');
    });
  }

  el('users-search').onsubmit = event => {
    event.preventDefault();
    const query = el('users-query').value.trim();
    if (request || !query) return;
    const by = el('users-search-by').value;
    el('users-query').value = '';
    load({ [by]: query });
  };
  el('users-reset').onclick = () => { el('users-search').reset(); load(); };
  el('users-more').onclick = () => { if (nextCursor) load({ limit, cursor: nextCursor }); };
  el('user-cancel').onclick = dismiss;
  dialog.oncancel = dismiss;
  el('user-confirm').onclick = () => {
    if (!target || request) return;
    const change = target;
    run('status', change, data => {
      const user = readUser(data?.user);
      if (!validDate(data.asOf) || user.id !== change.accountId || Boolean(user.disabledAt) !== change.disabled) throw invalid();
      accounts.set(user.id, user);
      asOf = data.asOf;
      render();
      note(change.disabled ? 'Аккаунт отключён.' : 'Аккаунт восстановлен.');
      el('users-list').querySelector('[data-account-id="' + CSS.escape(user.id) + '"] [data-user-action]')?.focus();
    });
  };
  return { open: load, clear };
}
