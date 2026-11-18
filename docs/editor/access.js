(() => {
  const title = document.getElementById('access-title');
  const message = document.getElementById('access-message');
  const account = document.getElementById('access-account');
  const signup = document.getElementById('access-signup');
  const retry = document.getElementById('access-retry');
  let request;

  // Carry only a local view choice through the account origin. The payment
  // return describes a screen; only editor/open can grant access.
  const intentKey = 'uglovato.editor.accessIntent';
  const payments = new URLSearchParams(location.search).getAll('payment');
  const outcome = payments.length === 1 && ['success', 'fail'].includes(payments[0]) ? payments[0] : null;
  const previousOutcome = history.state?.setPaymentReturn;
  let intent = outcome || (location.hash === '#sets' && ['success', 'fail'].includes(previousOutcome) ? previousOutcome : null) ||
    (location.hash === '#sets' ? 'sets' : null);
  if (!intent) {
    try { intent = sessionStorage.getItem(intentKey); } catch { /* Storage is optional. */ }
  }
  if (!['sets', 'success', 'fail'].includes(intent)) intent = null;
  if (location.search || intent || location.hash) {
    const state = { ...history.state };
    if (outcome || intent === 'success' || intent === 'fail') state.setPaymentReturn = intent;
    history.replaceState(state, '', location.pathname + (intent ? '#sets' : ''));
  }
  function rememberIntent() {
    try {
      if (intent) sessionStorage.setItem(intentKey, intent);
      else sessionStorage.removeItem(intentKey);
    } catch { /* The editor itself remains reachable without storage. */ }
  }
  account.addEventListener('click', rememberIntent);
  signup.addEventListener('click', rememberIntent);

  function show(state) {
    const guest = state === 'guest', denied = state === 'denied', error = state === 'error';
    account.hidden = !(guest || denied);
    document.getElementById('access-rate').hidden = !(guest || denied);
    signup.hidden = !guest;
    retry.hidden = state === 'loading';
    account.textContent = guest ? 'Войти' : 'Тариф и промокод';
    retry.className = error ? 'primary' : 'plain';
    retry.textContent = guest ? 'Я уже вошёл · проверить доступ' : error ? 'Попробовать ещё раз' : 'Проверить доступ';
    if (guest) {
      title.textContent = 'Вход в редактор';
      message.textContent = 'Войдите или создайте аккаунт, чтобы проверить доступ, выбрать тариф или активировать промокод.';
    } else if (denied) {
      title.textContent = 'Нужен доступ к редактору';
      message.textContent = intent === 'success'
        ? 'Вы вернулись из оплаты. Доступ пока не подтверждён. Проверьте его ещё раз.'
        : intent === 'fail' ? 'Оплата не завершена. В кабинете можно проверить условия доступа или активировать промокод.'
        : 'Вы вошли в аккаунт. Выберите тариф или активируйте промокод в кабинете.';
    } else if (error) {
      title.textContent = 'Не удалось открыть редактор';
      message.textContent = 'Проверьте соединение и попробуйте ещё раз.';
    } else {
      title.textContent = 'Доступ к редактору';
      message.textContent = 'Проверяем доступ…';
    }
  }

  async function openEditor() {
    if (request) return;
    show('loading');
    const controller = new AbortController();
    request = controller;
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const { getEditorHTML } = await import('../register/client.js?v=browser1');
      const html = await getEditorHTML(controller.signal);
      if (request !== controller) return;
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      if (!parsed.head.querySelector('meta[name="uglovato-editor"][content="licensed"]')) throw new Error();
      try { sessionStorage.removeItem(intentKey); } catch { /* Optional. */ }
      document.open();
      document.write(html);
      document.close();
    } catch (error) {
      if (request !== controller) return;
      if (error.status === 401) show('guest');
      else if (error.status === 402 || (error.status === 403 && error.code === 'access_required')) show('denied');
      else show('error');
    } finally {
      clearTimeout(timeout);
      if (request === controller) request = null;
    }
  }
  retry.addEventListener('click', async () => {
    await openEditor();
    if (retry.isConnected && !retry.hidden) (account.hidden ? retry : account).focus();
  });
  window.addEventListener('pagehide', () => { request?.abort(); request = null; });
  window.addEventListener('pageshow', event => { if (event.persisted) openEditor(); });
  openEditor();
})();
