export function createAdminPromos({ post, opened, denied, failed }) {
  const el = id => document.getElementById(id);
  const statuses = new Map([
    ['issued', 'Выдан'], ['active', 'Активирован'], ['expired', 'Истёк'], ['revoked', 'Отозван'],
  ]);
  const dateFormat = new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow',
  });
  const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
  const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
  function note(message, error = false) {
    el('promo-status').classList.toggle('is-error', error);
    el('promo-status').textContent = message;
  }
  let controller = null, promos = [], receiptId = '', selected = '', pendingCreate = null;
  let nextCursor = null;

  function readPromo(promo) {
    if (!promo || !uuid.test(promo.id) || !statuses.has(promo.status) ||
        !Number.isInteger(promo.days) || promo.days < 1 || promo.days > 365 ||
        !validDate(promo.createdAt) || !validDate(promo.expiresAt)) throw new Error('invalid_reply');
    // Only public metadata belongs in the list, even if the server adds more fields.
    const { id, days, status, createdAt, expiresAt } = promo;
    return { id, days, status, createdAt, expiresAt };
  }

  function buttons() {
    const busy = Boolean(controller);
    el('create').querySelector('button').disabled = busy || Boolean(receiptId);
    el('duration').disabled = busy;
    el('list-refresh').disabled = busy;
    el('list-more').disabled = busy;
    for (const button of el('promo-list').querySelectorAll('button')) button.disabled = busy;
  }

  function hideCode() {
    el('receipt').hidden = true;
    el('issued-code').textContent = '';
    receiptId = '';
    buttons();
  }

  function clear({ logout = false } = {}) {
    controller?.abort();
    controller = null;
    promos = [];
    nextCursor = null;
    el('list-more').hidden = true;
    if (logout) {
      pendingCreate = null;
      el('duration').value = '7';
    }
    selected = '';
    el('promo-list').replaceChildren();
    el('confirmation').close();
    el('confirm-id').textContent = '';
    el('management').hidden = true;
    el('list-empty').hidden = true;
    hideCode();
    note('');
  }

  function renderList() {
    const list = el('promo-list');
    list.replaceChildren();
    el('list-empty').hidden = promos.length > 0;
    for (const promo of promos) {
      const item = document.createElement('li');
      item.className = 'promo-row';
      const heading = document.createElement('div');
      const state = document.createElement('b');
      state.textContent = statuses.get(promo.status);
      const id = document.createElement('code');
      id.textContent = 'ID ' + promo.id;
      heading.append(state, id);
      item.append(heading);
      if (promo.status === 'issued' || promo.status === 'active') {
        const revoke = document.createElement('button');
        revoke.textContent = 'Отозвать';
        revoke.setAttribute('aria-label', 'Отозвать промокод ' + promo.id);
        revoke.onclick = () => {
          selected = promo.id;
          el('confirm-id').textContent = state.textContent + ' · ID ' + selected;
          el('confirmation').showModal();
        };
        item.append(revoke);
      }
      const dates = document.createElement('p');
      dates.textContent = 'Создан ' + dateFormat.format(Date.parse(promo.createdAt)) +
        ' · Дней: ' + promo.days + ' · Действителен до ' + dateFormat.format(Date.parse(promo.expiresAt));
      item.append(dates);
      list.append(item);
    }
  }

  async function run(action, body, onSuccess) {
    if (controller) return;
    const current = new AbortController();
    controller = current;
    buttons();
    note({ list: 'Загружаем промокоды…', create: 'Создаём промокод…', revoke: 'Отзываем промокод…' }[action]);
    const timer = setTimeout(() => current.abort(), 15000);
    try {
      const data = await post(action, body, current.signal);
      if (controller === current) onSuccess(data);
    } catch (error) {
      if (controller !== current) return;
      if (error.message === 'relay_unconfigured') {
        note('Подключение кабинета ещё не настроено. После настройки обновите страницу.', true);
        return;
      }
      if (error.status === 401 && error.code === 'promo_admin_unauthorized') {
        denied();
        return;
      }
      if (error.status === 400 && error.code === 'invalid_request' && action === 'create') {
        pendingCreate = null;
        note('Проверьте срок действия промокода (от 1 до 365 дней) и повторите выдачу.', true);
        return;
      }
      failed(() => refresh(action === 'list' ? body.cursor : null),
        action === 'list' ? 'Повторить запрос' : 'Проверить список');
      if (error.status === 429) {
        note('Слишком много запросов. Подожди минуту и повтори.', true);
      } else if (action === 'create') {
        note('Не удалось получить новый код. Обнови список и проверь выдачу по ID ' + body.requestId +
          '. Если код создан, его можно отозвать и выдать другой.', true);
      } else if (action === 'revoke') {
        note('Нет подтверждения отзыва. Обнови список и проверь статус кода.', true);
      } else {
        note('Список промокодов сейчас недоступен. Повторите загрузку.', true);
      }
    } finally {
      clearTimeout(timer);
      if (controller === current) {
        controller = null;
        buttons();
      }
    }
  }

  function refresh(cursor = null) {
    return run('list', cursor ? { limit: 50, cursor } : { limit: 50 }, data => {
      if (!Array.isArray(data?.promos) || data.promos.length > 50) throw new Error('invalid_reply');
      const list = data.promos.map(readPromo);
      const combined = cursor ? [...promos, ...list] : list;
      if (new Set(combined.map(promo => promo.id)).size !== combined.length ||
          (data.nextCursor != null && (typeof data.nextCursor !== 'string' || !data.nextCursor ||
            data.nextCursor === cursor || !list.length))) throw new Error('invalid_reply');
      promos = combined;
      nextCursor = data.nextCursor ?? null;
      el('list-more').hidden = !nextCursor;
      if (!cursor && receiptId && !list.some(p => p.id === receiptId && p.status === 'issued')) hideCode();
      const recovered = pendingCreate && list.find(p => p.id === pendingCreate.requestId);
      if (recovered) pendingCreate = null;
      const opening = el('management').hidden;
      el('management').hidden = false;
      renderList();
      opened();
      if (opening) el('issue-title').focus();
      note(recovered ? 'Найдена выдача ' + recovered.id + '. Полный код больше недоступен.' : '');
    });
  }

  el('list-refresh').onclick = () => refresh();
  el('list-more').onclick = () => { if (nextCursor) refresh(nextCursor); };
  el('create').onsubmit = event => {
    event.preventDefault();
    if (controller || receiptId) return;
    const days = el('duration').valueAsNumber;
    if (!el('duration').reportValidity()) return;
    // If the previous response was lost, the same ID prevents a second issuance.
    const requestId = pendingCreate?.requestId ?? crypto.randomUUID();
    pendingCreate = { days, requestId };
    run('create', pendingCreate, data => {
      const promo = readPromo(data?.promo);
      if (promo.id !== requestId || promo.status !== 'issued' || promo.days !== days ||
          typeof data.code !== 'string' || !data.code.trim() || data.code.length > 128) throw new Error('invalid_reply');
      pendingCreate = null;
      promos = [promo, ...promos.filter(p => p.id !== promo.id)];
      renderList();
      receiptId = promo.id;
      el('issued-code').textContent = data.code;
      el('receipt').hidden = false;
      el('copy').focus();
      note('Промокод создан.');
    });
  };
  el('copy').onclick = async () => {
    const id = receiptId;
    if (!id) return;
    try {
      await navigator.clipboard.writeText(el('issued-code').textContent);
      if (id === receiptId) note('Код скопирован.');
    } catch {
      if (id === receiptId) note('Не удалось скопировать. Выдели код и скопируй вручную.', true);
    }
  };
  el('dismiss').onclick = () => { hideCode(); note('Код скрыт.'); el('duration').focus(); };
  el('cancel').onclick = () => el('confirmation').close();
  el('confirm-revoke').onclick = () => {
    const id = selected;
    el('confirmation').close();
    if (!id || controller) return;
    run('revoke', { id }, data => {
      const promo = readPromo(data?.promo);
      if (promo.status !== 'revoked' || promo.id !== id) throw new Error('invalid_reply');
      if (receiptId === id) hideCode();
      promos = promos.map(p => p.id === id ? promo : p);
      renderList();
      note('Промокод отозван.');
      el('list-title').focus();
    });
  };
  return { open: refresh, clear };
}
