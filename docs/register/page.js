import { post, getEndpoint, getSession, getSetAccess, expressSetInterest, startSetCheckout, submitCredentials, logout, emailRecoveryEnabled, emailAction } from './client.js?v=account7';
import { supportsPasskeys, verifyPasskey } from './passkey.js';

const byId = id => document.getElementById(id);
const authButtons = ['reauth', 'logout'].map(byId);
let operation;
let sessionCheck;
let expiryTimer;
let accessTimer;
let accountId = null;
let reauthFor = null;
let offerRequest;
let agentRequest;
let checkoutEnabled = false;
let mode = 'login';
let receiptAction = null;
let receiptNumber = 0;
let mailFlow = null;
const form = byId('credentials');
const nameHelp = 'Введите имя или псевдоним длиной до 80 символов.';
const emailHelp = 'Введите адрес электронной почты, например name@example.com.';
const passwordHelp = 'От 15 символов. Можно придумать фразу из нескольких слов.';
const passwordTooLong = 'Пароль длиннее 256 байт. Сократите его и попробуйте ещё раз.';
let accountHasUsername = false;
let passwordReauth = false;
const siteOrigin = location.origin === 'https://auth.uglovato.ru' ? 'https://uglovato.ru' : location.origin;
const params = new URLSearchParams(location.search);
const next = params.getAll('next'), from = params.getAll('from');
const toSets = next.length === 1 && next[0] === 'sets';
const toAccount = next.length === 1 && next[0] === 'account';
let accountSection = toAccount && ['#agent-tools', '#offers', '#promo-code'].includes(location.hash)
  ? location.hash.slice(1) : null;
const fromEditor = location.origin === 'https://auth.uglovato.ru' && (toSets || toAccount) &&
  from.length === 1 && from[0] === 'editor';
const destinationHelp = toSets ? 'Войдите, чтобы проверить доступ и вернуться к наборам.'
  : 'В кабинете можно проверить доступ к редактору и MCP или активировать промокод.';
function editorDestination(sets) {
  if (fromEditor) return 'https://uglovato.ru/register/?next=' + (sets ? 'sets' : 'account') + '#return-editor';
  return siteOrigin + (sets ? '/editor/#sets' : '/editor/');
}
const editorPath = editorDestination(toSets);

function openEditor() {
  if (toSets && !fromEditor) {
    try {
      const editor = window.opener;
      if (editor && !editor.closed && editor.location.origin === siteOrigin && editor.location.pathname === '/editor/') {
        editor.location.hash = 'sets';
        editor.focus();
        window.close();
        if (window.closed) return;
      }
    } catch {
      // The site-origin bridge can see the editor opener without reloading its in-memory draft.
      if (location.origin !== siteOrigin && window.opener) {
        location.replace(siteOrigin + '/register/?next=sets#resume-sets');
        return;
      }
    }
  }
  location.replace(editorPath);
}

function clearOffers() {
  offerRequest?.abort();
  offerRequest = undefined;
  for (const id of ['want-week', 'want-month', 'offer-terms', 'month-terms', 'export-sets', 'offers-retry']) byId(id).hidden = true;
  byId('offer-state').textContent = '';
}

async function loadOffers(offer) {
  const restoreFocus = Boolean(offer) || document.activeElement === byId('offers-retry');
  clearOffers();
  if (!byId('offers').open || !accountId) return;
  const controller = new AbortController();
  offerRequest = controller;
  const identity = accountId;
  const signal = controller.signal;
  const pay = checkoutEnabled;
  byId('offer-state').textContent = 'Проверяем доступ…';
  try {
    const state = await getSetAccess(signal);
    if (signal.aborted || accountId !== identity) return;
    if (!state.authenticated) { showGuest('Чтобы проверить доступ, войдите снова.'); return; }
    byId('export-sets').hidden = !state.active;
    if (state.active) { byId('offer-state').textContent = ''; return; }
    checkoutEnabled = state.checkoutEnabled === true;
    const changed = offer && pay !== checkoutEnabled;
    if (offer && !changed && (offer !== 'month' || state.returning)) {
      if (pay) {
        byId('offer-state').textContent = 'Открываем оплату…';
        const url = await startSetCheckout(offer, signal);
        if (!signal.aborted && accountId === identity) location.assign(url);
        return;
      }
      const result = await expressSetInterest(offer, signal);
      if (signal.aborted || accountId !== identity) return;
      state.interest = result.interest;
    }
    byId('offer-terms').hidden = false;
    byId('offer-mode-hint').textContent = checkoutEnabled ? 'Разовая оплата редактора и MCP через Робокассу. Без автопродления.'
      : 'Продажи пока закрыты. Можно отметить интерес к тарифу без оплаты и активации доступа.';
    byId('week-price').hidden = !checkoutEnabled;
    byId('month-terms').hidden = !state.returning;
    byId('month-price').hidden = !checkoutEnabled;
    byId('month-interest-hint').hidden = checkoutEnabled;
    byId('want-week').textContent = checkoutEnabled ? 'Оплатить 150 ₽' : 'Интересует неделя';
    byId('want-month').textContent = checkoutEnabled ? 'Оплатить 299 ₽' : 'Интересует месяц';
    byId('want-week').hidden = !checkoutEnabled && state.interest === 'week';
    byId('want-month').hidden = !state.returning || (!checkoutEnabled && state.interest === 'month');
    byId('offer-state').textContent = changed ? 'Предложение изменилось. Выберите действие ещё раз.' : !checkoutEnabled && state.interest
      ? 'Вы отметили интерес к доступу на ' + (state.interest === 'week' ? 'неделю.' : 'месяц.') : '';
  } catch (error) {
    if (signal.aborted) return;
    if (error.code === 'unauthenticated') { showGuest('Чтобы проверить доступ, войдите снова.'); return; }
    if (error.code === 'access_active') {
      byId('offer-state').textContent = 'Доступ к наборам уже активен.';
      byId('export-sets').hidden = false;
      return;
    }
    byId('offer-state').textContent = error.code === 'checkout_unavailable'
      ? 'Оплата сейчас недоступна. Обновите сведения о доступе.'
      : error.code === 'week_purchase_required'
      ? 'Доступ на месяц появится после окончания оплаченной недели.'
      : offer && pay ? 'Не удалось открыть оплату. Обновите предложение и попробуйте ещё раз.'
      : 'Не удалось проверить доступ. Попробуйте ещё раз.';
    byId('offers-retry').hidden = false;
  } finally {
    if (offerRequest === controller) {
      offerRequest = undefined;
      if (restoreFocus && document.activeElement === document.body && byId('offers').open) {
        const target = ['offers-retry', 'export-sets', 'want-week', 'want-month'].map(byId).find(el => !el.hidden);
        (target || byId('offer-state')).focus();
      }
    }
  }
}

byId('open-editor').href = editorPath;
byId('guest').href = editorPath;
byId('export-sets').href = siteOrigin + '/editor/#sets';
byId('agent-guide').href = siteOrigin + '/connect/';
byId('tariff-terms').href = siteOrigin + '/terms/';
byId('home').href = siteOrigin + '/';
byId('offers').addEventListener('toggle', () => loadOffers());
byId('offers-retry').addEventListener('click', () => loadOffers());
byId('want-week').addEventListener('click', () => loadOffers('week'));
byId('want-month').addEventListener('click', () => loadOffers('month'));

function getAccountSession(signal) {
  return getSession(signal, { profile: true });
}

function status(message) {
  byId('status').textContent = message;
}

function clearAgentKey() {
  byId('agent-key').value = '';
  byId('agent-key-field').hidden = true;
  byId('agent-expiry').textContent = '';
}

function resetAgentTools() {
  agentRequest?.abort();
  agentRequest = null;
  clearAgentKey();
  byId('agent-status').textContent = '';
  byId('agent-download').disabled = byId('agent-issue').disabled = false;
}

function closeAgentTools() {
  resetAgentTools();
  byId('agent-tools').open = false;
  byId('agent-tools').hidden = true;
}

async function downloadAgentPackage(signal) {
  const endpoint = getEndpoint();
  if (!endpoint) throw new Error();
  const url = new URL(endpoint);
  url.search = '?op=editor/agent-package';
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    credentials: 'include', redirect: 'error', cache: 'no-store', referrerPolicy: 'strict-origin', signal
  });
  if (response.status !== 200 || response.redirected || response.url !== url.href) {
    throw Object.assign(new Error(), { status: response.status });
  }
  const blob = await response.blob();
  const magic = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  if (magic[0] !== 0x1f || magic[1] !== 0x8b) throw new Error();
  if (signal.aborted) return;
  const file = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = file;
  link.download = 'uglovato-mcp.tgz';
  link.click();
  setTimeout(() => URL.revokeObjectURL(file), 1000);
}

async function useAgentTool(issueKey) {
  const details = byId('agent-tools');
  if (!accountId || details.hidden || !details.open || agentRequest || operation) return;
  const controller = new AbortController();
  agentRequest = controller;
  const timeout = setTimeout(() => controller.abort(), 30000);
  const message = byId('agent-status');
  byId('agent-download').disabled = byId('agent-issue').disabled = true;
  message.textContent = issueKey ? 'Создаём ключ…' : 'Загружаем пакет…';
  try {
    if (issueKey) {
      clearAgentKey();
      const result = await post('agent/issue', {}, controller.signal);
      if (controller.signal.aborted || agentRequest !== controller) return;
      if (typeof result.token !== 'string' || !result.token.trim() || !(Date.parse(result.expiresAt) > Date.now())) throw new Error();
      byId('agent-key').value = result.token;
      byId('agent-expiry').textContent = 'Действует до ' + new Intl.DateTimeFormat('ru-RU', {
        dateStyle: 'long', timeStyle: 'short'
      }).format(new Date(result.expiresAt)) + '. Скопируйте ключ сейчас.';
      byId('agent-key-field').hidden = false;
      message.textContent = 'Ключ создан.';
      byId('agent-copy').focus();
    } else {
      await downloadAgentPackage(controller.signal);
      if (!controller.signal.aborted && agentRequest === controller) message.textContent = 'Пакет готов к скачиванию.';
    }
  } catch (error) {
    if (agentRequest !== controller) return;
    if (error.code === 'reauth_required') message.textContent = 'Для создания ключа войдите в кабинет повторно и нажмите кнопку ещё раз.';
    else if (error.status === 401) showGuest('Сеанс завершён. Войдите снова.');
    else if ([402, 403].includes(error.status)) {
      closeAgentTools();
      status('Проверьте доступ к редактору и MCP в кабинете.');
      check({ background: true });
    } else message.textContent = error.status === 429 ? messageFor(error)
      : issueKey ? 'Не удалось создать ключ. Попробуйте ещё раз.' : 'Не удалось скачать пакет. Попробуйте ещё раз.';
  } finally {
    clearTimeout(timeout);
    if (agentRequest === controller) {
      agentRequest = null;
      byId('agent-download').disabled = byId('agent-issue').disabled = false;
    }
  }
}

byId('agent-tools').addEventListener('toggle', () => { if (!byId('agent-tools').open) resetAgentTools(); });
byId('agent-issue').addEventListener('click', () => useAgentTool(true));
byId('agent-download').addEventListener('click', () => useAgentTool(false));
byId('agent-copy').addEventListener('click', async () => {
  const key = byId('agent-key');
  if (!key.value) return;
  try {
    await navigator.clipboard.writeText(key.value);
    if (key.value) byId('agent-status').textContent = 'Ключ скопирован.';
  } catch {
    if (!key.value) return;
    key.focus();
    key.select();
    byId('agent-status').textContent = 'Ключ выделен. Скопируйте его через меню.';
  }
});

const mailViews = {
  request: ['Восстановить по почте', 'Введите подтверждённую почту аккаунта. Мы отправим ссылку для смены пароля.', 'Отправить ссылку'],
  sent: ['Проверьте почту', 'Если адрес подтверждён в аккаунте, на него придёт письмо. Проверьте также папку «Спам».'],
  verify: ['Подтвердить почту', 'Нажмите кнопку, войдя в тот аккаунт, для которого пришло письмо.', 'Подтвердить почту'],
  verified: ['Почта подтверждена', 'Теперь вы можете восстановить пароль по письму.'],
  reset: ['Новый пароль', 'Задайте новый пароль, затем войдите с ним в аккаунт.', 'Сохранить новый пароль'],
  invalid: ['Ссылка недействительна', 'Откройте последнюю ссылку целиком или запросите новое письмо.'],
  unavailable: ['Подтверждение по почте недоступно', 'Вы можете войти с паролем или восстановить доступ по сохранённому коду.']
};

function showMail(kind, token = null) {
  sessionCheck?.abort();
  clearReceipt();
  showGuest();
  form.reset();
  mailFlow = { kind, token };
  byId('mail-form').reset();
  byId('mail-address').setCustomValidity('');
  byId('mail-password').setCustomValidity('');
  showPassword(false, 'mail-password', 'mail-show-password');
  byId('entry').hidden = true;
  byId('mail-view').hidden = false;
  byId('guest').hidden = kind === 'verified';
  const [title, help, submit] = mailViews[kind];
  byId('mail-title').textContent = title;
  byId('mail-help').textContent = help;
  byId('mail-form').hidden = !submit;
  byId('mail-submit').textContent = submit || '';
  byId('mail-address-field').hidden = byId('mail-address').disabled = kind !== 'request';
  byId('mail-password-field').hidden = byId('mail-password').disabled = kind !== 'reset';
  byId('mail-signin').hidden = kind !== 'verify';
  byId('mail-request').hidden = !['sent', 'reset'].includes(kind);
  byId('mail-code').hidden = !['request', 'sent', 'reset', 'invalid', 'unavailable'].includes(kind);
  byId('mail-back').hidden = kind === 'verified';
  byId('mail-continue').hidden = kind !== 'verified';
  byId('mail-continue').textContent = toAccount ? 'В личный кабинет' : toSets ? 'К набору' : 'Открыть редактор';
  byId('mail-title').focus();
}

function readMailLink() {
  if (!/^#(?:verify|reset)(?:=|$)/.test(location.hash)) return false;
  // 32 bytes, canonical unpadded base64url. Remove even malformed links
  // before any session check, history entry or editor navigation.
  const match = /^#(verify|reset)=([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$/.exec(location.hash);
  history.replaceState(null, '', location.pathname + location.search);
  operation?.abort();
  if (operation) finish(operation);
  if (!emailRecoveryEnabled()) showMail('unavailable');
  else if (!match) showMail('invalid');
  else showMail(match[1], match[2]);
  return true;
}

function leaveMail(nextMode, message = '', keepForSignIn = false) {
  mailFlow = keepForSignIn ? { ...mailFlow, signIn: true } : null;
  byId('mail-form').reset();
  byId('mail-view').hidden = true;
  updateModeURL(nextMode, true);
  editCredentials(nextMode);
  status(message);
}

byId('mail-signin').addEventListener('click', () => leaveMail('login', '', true));
byId('back-to-letter').addEventListener('click', () => {
  if (!operation && mailFlow?.kind === 'verify') showMail('verify', mailFlow.token);
});
byId('mail-code').addEventListener('click', () => leaveMail('recover'));
byId('mail-back').addEventListener('click', () => leaveMail('login'));
byId('mail-request').addEventListener('click', () => showMail('request'));
byId('mail-continue').addEventListener('click', () => {
  if (toAccount) { leaveMail('login'); check(); }
  else openEditor();
});
byId('mail-show-password').addEventListener('click', () =>
  showPassword(byId('mail-password').type === 'password', 'mail-password', 'mail-show-password'));
byId('mail-form').addEventListener('input', event => event.target.setCustomValidity(''));
byId('mail-form').addEventListener('submit', async event => {
  event.preventDefault();
  const flow = mailFlow;
  if (!flow || flow.signIn || !['request', 'verify', 'reset'].includes(flow.kind)) return;
  const input = byId('mail-form').querySelector('input:enabled');
  if (input) {
    validateField(input);
    if (!input.reportValidity()) return;
  }
  const controller = begin();
  if (!controller) return;
  status(flow.kind === 'request' ? 'Запрашиваем письмо…' : 'Проверяем…');
  try {
    const fields = flow.kind === 'request' ? { email: input.value.trim() } : { token: flow.token };
    if (flow.kind === 'reset') fields.password = input.value;
    await emailAction(flow.kind === 'request' ? 'request-reset' : flow.kind, fields, controller.signal);
    if (controller.signal.aborted || mailFlow !== flow) return;
    if (flow.kind === 'reset') {
      mailFlow = { kind: 'reset-done' };
      leaveMail('login', 'Пароль изменён. Войдите с новым паролем.', true);
    } else showMail(flow.kind === 'verify' ? 'verified' : 'sent');
  } catch (error) {
    if (controller.signal.aborted || mailFlow !== flow) return;
    if (flow.kind === 'verify' && (error.status === 401 || error.status === 403 || error.code === 'reauth_required')) {
      leaveMail('login', 'Войдите в аккаунт получателя письма, затем подтвердите почту ещё раз.', true);
    } else if (error.code === 'invalid_email') {
      input.setCustomValidity(emailHelp);
      input.reportValidity();
    } else if (error.code === 'invalid_password') status(passwordHelp);
    else if (flow.kind !== 'request' && [400, 404, 409, 410].includes(error.status)) {
      status(flow.kind === 'verify'
        ? 'Не удалось подтвердить адрес. Проверьте аккаунт или запросите новое письмо в кабинете.'
        : 'Ссылка устарела или уже использована. Запросите новое письмо.');
    } else status(messageFor(error));
  } finally { finish(controller); }
});

async function sendVerification(signal) {
  try {
    await emailAction('send-verification', {}, signal);
    return { accepted: true, message: 'Письмо запрошено. Откройте ссылку и подтвердите почту.' };
  } catch (error) {
    return { accepted: false, message: error.status === 429 ? messageFor(error)
      : 'Не удалось запросить письмо. Отправьте его ещё раз из кабинета.' };
  }
}
byId('send-verification').addEventListener('click', async () => {
  const controller = begin();
  if (!controller) return;
  const owner = accountId;
  status('Запрашиваем письмо…');
  try {
    const { message } = await sendVerification(controller.signal);
    if (!controller.signal.aborted && accountId === owner) status(message);
  } finally { finish(controller); }
});

const formTitles = {
  login: 'Вход в аккаунт', register: 'Создать аккаунт', recover: 'Восстановить доступ', link: 'Добавить почту'
};
const submitLabels = {
  login: 'Войти', register: 'Создать аккаунт', recover: 'Сохранить новый пароль', link: 'Добавить почту'
};

const modeHashes = { login: '', register: '#signup', recover: '#recover' };
function requestedMode() {
  return location.hash === '#signup' ? 'register' : location.hash === '#recover' ? 'recover' : 'login';
}

function updateModeURL(nextMode, replace = false) {
  const url = new URL(location.href);
  url.hash = modeHashes[nextMode];
  if (url.href !== location.href) {
    if (replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
  }
}

function setMode(nextMode) {
  mode = nextMode;
  const recovery = mode === 'recover';
  const profileFields = mode === 'register' || mode === 'link';
  for (const [id, visible] of [['name', profileFields], ['email', profileFields], ['username', !profileFields]]) {
    byId(id + '-field').hidden = !visible;
    byId(id).disabled = !visible;
    byId(id).required = visible;
    byId(id).setCustomValidity('');
  }
  byId('entry-title').textContent = passwordReauth ? 'Подтвердите вход' : formTitles[mode];
  const help = byId('entry-help');
  if (mailFlow?.signIn && mailFlow.kind === 'verify') help.textContent = 'Войдите в аккаунт, для которого пришло письмо. Затем нажмите «Подтвердить почту».';
  else if (passwordReauth) help.textContent = 'Введите прежний логин и пароль этого аккаунта.';
  else if (recovery) help.textContent = 'Возьмите сохранённый код из файла uglovato-recovery.txt или менеджера паролей и задайте новый пароль.';
  else if (mode === 'link') help.textContent = accountHasUsername
    ? 'Задайте пароль для почты и прежнего логина. Новый пароль заменит прежний. Ваш аккаунт и срок доступа сохранятся.'
    : 'Добавьте почту и задайте пароль для входа. Ваш аккаунт и срок доступа сохранятся.';
  else if (mode === 'register') help.textContent = '';
  else help.textContent = destinationHelp;
  help.hidden = !help.textContent;
  byId('credential-submit').textContent = submitLabels[mode];
  byId('password-label').textContent = recovery ? 'Новый пароль' : 'Пароль';
  byId('password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  byId('password-hint').textContent = passwordHelp;
  byId('password-hint').hidden = mode === 'login';
  byId('password').setCustomValidity('');
  byId('recovery-code').setCustomValidity('');
  byId('password').setAttribute('aria-describedby', byId('password-hint').hidden ? '' : 'password-hint');
  byId('recovery-field').hidden = !recovery;
  byId('recovery-code').disabled = !recovery;
  byId('recovery-code').required = recovery;
  const privateForm = passwordReauth || mode === 'link' || Boolean(mailFlow?.signIn && mailFlow.kind === 'verify');
  byId('back-to-letter').hidden = !(mailFlow?.kind === 'verify' && mailFlow.signIn);
  byId('auth-modes').hidden = privateForm;
  for (const button of document.querySelectorAll('[data-mode]')) {
    const target = button.dataset.mode;
    if (target === 'login') button.textContent = recovery ? 'Вернуться ко входу' : 'Вход';
    button.hidden = privateForm || (target === 'recover' && mode !== 'login') || (target === 'register' && recovery);
    if (target !== 'recover') button.setAttribute('aria-pressed', String(target === mode));
  }
  byId('cancel-link').hidden = mode !== 'link' && !passwordReauth;
  byId('cancel-link').textContent = toSets ? 'К набору' : 'Вернуться в аккаунт';
}

function editCredentials(nextMode) {
  closeAgentTools();
  const identifier = byId('username');
  const email = byId('email');
  const username = accountId ? '' : identifier.disabled ? (email.value || identifier.value) : identifier.value;
  clearPromo();
  form.reset();
  setMode(nextMode);
  identifier.value = username;
  if (!email.disabled && username.includes('@')) email.value = username;
  byId('account').hidden = true;
  byId('entry').hidden = byId('credential-view').hidden = false;
  byId('guest').hidden = nextMode === 'link' || passwordReauth;
  status('');
  const nextField = !byId('name').disabled ? 'name'
    : !username ? 'username' : nextMode === 'recover' ? 'recovery-code' : 'password';
  byId(nextField).focus();
}

function clearCredentialError() {
  const error = byId('credential-error');
  for (const input of form.querySelectorAll('[aria-invalid]')) {
    input.removeAttribute('aria-invalid');
    const descriptions = (input.getAttribute('aria-describedby') || '').split(' ').filter(id => id && id !== error.id);
    if (descriptions.length) input.setAttribute('aria-describedby', descriptions.join(' '));
    else input.removeAttribute('aria-describedby');
  }
  error.textContent = '';
}

function credentialFeedback(message, field, focus = true) {
  clearCredentialError();
  const error = byId('credential-error');
  if (field) {
    field.closest('.field').append(error);
    field.setAttribute('aria-invalid', 'true');
    field.setAttribute('aria-describedby', [field.getAttribute('aria-describedby'), error.id].filter(Boolean).join(' '));
  } else {
    byId('credential-submit').before(error);
  }
  error.textContent = message;
  if (focus) (field || error).focus();
}

function validateField(input) {
  let message = '';
  if (input.id === 'name') {
    const value = input.value.normalize('NFC').trim().replace(/\s+/gu, ' ');
    if (!value || [...value].length > 80 || /[\p{Cc}\p{Bidi_Control}\u2028\u2029]/u.test(input.value)) message = nameHelp;
  } else if (input.id === 'email' || input.id === 'mail-address') {
    // The server applies IDNA and checks the length of the resulting ASCII address.
    const parts = input.value.trim().split('@');
    const validEmail = parts.length === 2 && /^[\x21-\x7e]+$/.test(parts[0]) &&
      /^[\p{L}\p{N}\p{M}.\-\u3002\uff0e\uff61]+$/u.test(parts[1]);
    if (!validEmail) message = emailHelp;
  } else if (input.id === 'password' || input.id === 'mail-password') {
    if (new TextEncoder().encode(input.value).length > 256) message = passwordTooLong;
    else if ((mode !== 'login' || input.id === 'mail-password') && [...input.value].length < 15) message = passwordHelp;
  } else if (!input.value.trim()) {
    message = input.id === 'username' ? 'Введите почту или прежний логин.' : 'Введите код восстановления.';
  }
  input.setCustomValidity(message);
}

function validateCredentials() {
  for (const input of form.querySelectorAll('input:enabled')) validateField(input);
  const invalid = form.querySelector('input:invalid');
  if (!invalid) return true;
  const required = { name: 'Введите имя или псевдоним.', email: 'Введите электронную почту.', username: 'Введите почту или прежний логин.', password: 'Введите пароль.', 'recovery-code': 'Введите код восстановления.' };
  credentialFeedback(invalid.validity.valueMissing ? required[invalid.id] : invalid.validationMessage, invalid);
  return false;
}

function clearReceipt() {
  receiptNumber++;
  receiptAction = null;
  byId('issued-code').value = '';
  byId('recovery-receipt').hidden = true;
}

function showReceipt(code, action) {
  clearTimeout(expiryTimer);
  clearTimeout(accessTimer);
  form.reset();
  receiptAction = action;
  // A direct visit to #signup or #recover may have no earlier entry in this
  // document. Keep Back/Forward on the live receipt until it is acknowledged.
  history.pushState(null, '', location.href);
  byId('receipt-title').textContent = action === 'recover' ? 'Пароль изменён'
    : action === 'register' ? 'Аккаунт создан' : 'Почта добавлена';
  const hasMail = action !== 'recover' && emailRecoveryEnabled();
  byId('reserve-code').open = !hasMail;
  byId('reserve-summary').hidden = !hasMail;
  byId('receipt-help').textContent = hasMail
    ? 'Подтвердите адрес для восстановления по почте. Пока адрес не подтверждён, пригодится резервный код. Его можно сохранить только здесь.'
    : (action === 'recover' || action === 'link' && accountHasUsername
    ? 'Новый код заменяет прежний. ' : '') +
    'Сохраните код на случай, если забудете пароль. Он показывается один раз.';
  byId('code-saved').textContent = toAccount || toSets || action === 'link' ? 'В личный кабинет' : 'На страницу редактора';
  byId('issued-code').value = code;
  byId('entry').hidden = byId('account').hidden = byId('guest').hidden = true;
  byId('recovery-receipt').hidden = false;
  status('');
  byId('receipt-title').focus();
}

function clearPromo() {
  byId('promo-form').reset();
  byId('promo-status').textContent = '';
  byId('promo-code').removeAttribute('aria-invalid');
}

function showGuest(message = '') {
  closeAgentTools();
  clearPromo();
  clearTimeout(expiryTimer);
  clearTimeout(accessTimer);
  clearOffers();
  byId('offers').open = false;
  passwordReauth = false;
  if (accountId || mode === 'link') {
    form.reset();
    setMode(requestedMode());
  }
  accountId = null;
  accountHasUsername = false;
  renderProfile(null);
  reauthFor = null;
  byId('entry').hidden = false;
  byId('account').hidden = true;
  byId('guest').hidden = false;
  byId('credential-view').hidden = !getEndpoint();
  byId('retry').hidden = true;
  status(message);
}

function renderProfile(profile) {
  byId('account-profile').hidden = !profile;
  byId('profile-name').textContent = profile?.name || '';
  byId('profile-email').textContent = profile?.email || '';
  const withMail = Boolean(profile && emailRecoveryEnabled());
  byId('email-state').hidden = !withMail;
  byId('email-state').textContent = withMail ? (profile.emailVerified === true ? 'Почта подтверждена' : 'Почта пока не подтверждена') : '';
  byId('send-verification').hidden = !withMail || profile.emailVerified === true;
}

function showLinkActions(session) {
  const hasProfile = Boolean(session.profile);
  renderProfile(session.profile);
  if (hasProfile || reauthFor !== accountId) reauthFor = null;
  byId('link-username').hidden = hasProfile || Boolean(reauthFor);
  byId('reauth').hidden = !reauthFor;
  status(reauthFor ? 'Подтвердите вход ещё раз, чтобы добавить почту.' : '');
}

function showAccount(session) {
  clearTimeout(expiryTimer);
  clearTimeout(accessTimer);
  const newAccount = accountId !== session.accountId;
  if (newAccount) {
    closeAgentTools();
    clearPromo();
    clearOffers();
    byId('offers').open = false;
  }
  accountId = session.accountId;
  if (location.hash === '#signup' || location.hash === '#recover') updateModeURL('login', true);
  accountHasUsername = session.hasUsername === true;
  byId('entry').hidden = true;
  byId('account').hidden = false;
  byId('guest').hidden = true;
  byId('retry').hidden = true;
  const plus = session.access.plan === 'plus' && Date.parse(session.access.validUntil) > Date.now();
  byId('plan').textContent = session.access.source === 'promo' && plus ? 'Редактор и MCP доступны по промокоду'
    : plus ? 'Доступ к редактору и MCP активен' : 'Редактор и MCP пока недоступны';
  const editor = byId('open-editor');
  editor.href = siteOrigin + (toSets ? '/editor/#sets' : '/editor/');
  editor.textContent = toSets ? 'Вернуться к наборам в редакторе' : 'Открыть редактор';
  editor.hidden = !plus;
  if (plus) byId('agent-tools').hidden = false;
  else closeAgentTools();
  const until = plus && session.access.validUntil;
  byId('period').hidden = !until;
  byId('period').textContent = until ? 'Доступ до ' + new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'long', timeStyle: 'long'
  }).format(new Date(until)) : '';
  if (until && Date.parse(until) < Date.parse(session.expiresAt)) {
    accessTimer = setTimeout(() => {
      byId('plan').textContent = 'Срок доступа к редактору и MCP истёк';
      byId('period').hidden = true;
      editor.hidden = true;
      closeAgentTools();
      if (byId('offers').open) loadOffers();
    }, Math.max(0, Date.parse(until) - Date.now()));
  }
  showLinkActions(session);
  const offers = byId('offers');
  if (offers.open) loadOffers();
  else if (newAccount && !plus && accountSection !== 'promo-code') offers.open = true;
  if (accountSection) {
    const section = byId(accountSection === 'agent-tools' && !plus ? 'offers' : accountSection);
    accountSection = null;
    if (section.tagName === 'DETAILS') section.open = true;
    requestAnimationFrame(() => {
      if (accountId === session.accountId && !byId('account').hidden) (section.querySelector('summary') || section).focus();
    });
  }
  expiryTimer = setTimeout(() => {
    operation?.abort();
    showGuest('Время входа истекло. Войдите ещё раз.');
    byId('entry-title').focus();
  }, Math.max(0, Date.parse(session.expiresAt) - Date.now()));
}

function messageFor(error) {
  if (error.name === 'NotAllowedError') return 'Подтверждение не получено. Попробуйте ещё раз или выберите другой ключ.';
  if (error.name === 'AbortError') return 'Действие отменено. Можно попробовать ещё раз.';
  if (error.name === 'SecurityError' || error.name === 'NotSupportedError') return 'Ключ недоступен в этом браузере или на этом устройстве. Попробуйте другой браузер или устройство.';
  if (error.status === 429) {
    const seconds = Number(error.retryAfter);
    return seconds > 0 && seconds <= 3600 ? 'Слишком много попыток. Повторите через ' + seconds + ' с.' : 'Слишком много попыток. Подождите немного и попробуйте снова.';
  }
  if (error.status === 503) return 'Сервис аккаунтов временно недоступен. Попробуйте позже.';
  if (error.code === 'verification_failed' || error.code === 'unverified') return 'Сервер не подтвердил прежний ключ. Попробуйте ещё раз.';
  if (error.status === 401 || error.status === 400 || error.status === 403) return 'Не удалось подтвердить вход. Попробуйте ещё раз.';
  if (error.code === 'invalid_reply') return 'Сервис аккаунтов вернул неожиданный ответ. Попробуйте позже.';
  return 'Не удалось связаться с сервисом аккаунтов. Проверьте соединение и попробуйте снова.';
}

function begin() {
  if (operation) return null;
  sessionCheck?.abort();
  operation = new AbortController();
  for (const button of authButtons) button.disabled = true;
  for (const button of document.querySelectorAll('#promo-submit, #credential-submit, [data-mode], #link-username, #cancel-link, #send-verification, #mail-view button')) button.disabled = true;
  return operation;
}

function finish(controller) {
  if (operation !== controller) return;
  operation = undefined;
  byId('cancel').hidden = true;
  for (const button of authButtons) button.disabled = false;
  for (const button of document.querySelectorAll('#promo-submit, #credential-submit, [data-mode], #link-username, #cancel-link, #send-verification, #mail-view button')) button.disabled = false;
  syncModeFromURL();
}

async function check({ background = false, receipt = null } = {}) {
  if (mailFlow || receiptAction || operation) return;
  if (background && sessionCheck && !sessionCheck.signal.aborted) return;
  if (!getEndpoint()) {
    showGuest(window.uglovatoAuth?.endpoint
      ? 'Не удалось подключиться к сервису аккаунтов.'
      : 'Вход и регистрация пока не подключены.');
    return;
  }
  sessionCheck?.abort();
  const controller = new AbortController();
  sessionCheck = controller;
  if (!background && !accountId) {
    showGuest('Проверяем вход…');
  }
  try {
    const session = await getAccountSession(controller.signal);
    if (controller.signal.aborted) return;
    if (session.authenticated) {
      const editingAccount = !byId('entry').hidden && session.accountId === accountId &&
        (!session.profile && (mode === 'link' || passwordReauth));
      if (!editingAccount) {
        passwordReauth = false;
        if (!byId('entry').hidden) form.reset();
        showAccount(session);
        if (receipt) {
          byId('account-title').focus();
          status(receipt === 'recover' ? 'Пароль изменён. Вы в своём кабинете.'
            : receipt === 'register' ? 'Вы вошли в созданный аккаунт.' : 'Почта добавлена.');
        }
      }
    } else if (!background || accountId || !byId('retry').hidden) {
      showGuest(receipt ? 'Сеанс завершён. Войдите с почтой или прежним логином и паролем.' : '');
      if (receipt) byId('username').focus();
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    // A failed refresh cannot tell us whether the known session expired.
    // Keep the form and its values until an authoritative response or expiry.
    status(receipt ? 'Не удалось проверить сеанс. Проверьте вход ещё раз.' : messageFor(error));
    byId('retry').hidden = false;
  } finally {
    if (sessionCheck === controller) sessionCheck = undefined;
  }
}

// The account destination requires a confirmed cookie session before showing
// account actions. A failed session read can be retried without resubmitting.
async function continueAfterSignIn(signal) {
  if (toAccount || toSets) {
    status('Проверяем сеанс…');
    let session;
    try {
      session = await getAccountSession(signal);
    } catch (error) {
      if (signal.aborted) return;
      status(messageFor(error));
      byId('retry').hidden = false;
      return;
    }
    if (signal.aborted) return;
    if (!session.authenticated) {
      showGuest('Сеанс не подтверждён. Разрешите этому сайту использовать cookie и войдите снова.');
      return;
    }
    form.reset();
    showAccount(session);
    byId('account-title').focus();
    return;
  }
  openEditor();
}

byId('promo-code').addEventListener('input', () => {
  byId('promo-status').textContent = '';
  byId('promo-code').removeAttribute('aria-invalid');
});
byId('promo-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!accountId) return;
  const controller = begin();
  if (!controller) return;
  const input = byId('promo-code'), message = byId('promo-status');
  input.removeAttribute('aria-invalid');
  message.textContent = 'Проверяем промокод…';
  try {
    const result = await post('promos/redeem', { code: input.value.trim() }, controller.signal);
    if (controller.signal.aborted) return;
    if (result.promo?.status !== 'active') throw new Error('invalid_reply');
    const session = await getAccountSession(controller.signal);
    if (controller.signal.aborted) return;
    if (!session.authenticated) { showGuest('Войдите снова, чтобы проверить доступ.'); return; }
    input.value = '';
    const sameAccount = accountId === session.accountId;
    showAccount(session);
    if (sameAccount) message.textContent = session.access.plan === 'plus'
      ? 'Промокод активирован.' : 'Доступ по промокоду завершён.';
    if (document.activeElement === document.body) byId('open-editor').focus();
  } catch (error) {
    if (controller.signal.aborted) return;
    if (error.code === 'unauthenticated') showGuest('Для активации промокода войдите снова.');
    else {
      const invalid = error.code === 'promo_unavailable';
      message.textContent = invalid ? 'Промокод недоступен. Проверьте код и срок действия.'
        : error.status === 429 ? messageFor(error) : 'Не удалось проверить доступ. Попробуйте ещё раз.';
      if (invalid) input.setAttribute('aria-invalid', 'true');
      if (document.activeElement === document.body) input.focus();
    }
  } finally {
    finish(controller);
  }
});

async function act(kind) {
  if (kind === 'reauth' && accountHasUsername) {
    passwordReauth = true;
    editCredentials('login');
    status('Подтвердите вход в аккаунт, к которому добавляете почту.');
    return;
  }
  const controller = begin();
  if (!controller) return;
  let focusTarget = byId(kind);
  const originalAccount = accountId;
  try {
    if (kind === 'logout') {
      resetAgentTools();
      byId('agent-tools').open = false;
      status('Завершаем сеанс…');
      await logout(controller.signal);
      if (controller.signal.aborted) return;
      showGuest('Вы вышли из аккаунта.');
      focusTarget = byId('entry-title');
      return;
    }
    if (!supportsPasskeys()) {
      status('Для подтверждения откройте кабинет в браузере, где доступен ваш ключ.');
      return;
    }
    status('Запрашиваем ключ…');
    byId('cancel').hidden = false;
    await verifyPasskey('login', controller.signal, next => {
      byId('cancel').hidden = next === 'verify';
      status(next === 'prompt' ? 'Подтвердите действие в системном окне.' : 'Проверяем ключ на сервере…');
    });
    if (controller.signal.aborted) return;
    const session = await getAccountSession(controller.signal);
    if (controller.signal.aborted) return;
    if (!session.authenticated) {
      showGuest('Сеанс завершён. Войдите снова.');
      focusTarget = byId('entry-title');
      return;
    }
    reauthFor = null;
    showAccount(session);
    if (session.accountId === originalAccount && !session.profile) {
      editCredentials('link');
    } else {
      status(session.accountId === originalAccount ? 'У этого аккаунта уже есть почта.' : 'Вы подтвердили другой аккаунт.');
      focusTarget = byId('account-title');
    }
  } catch (error) {
    if (operation !== controller) return;
    if (controller.signal.aborted && !accountId && kind === 'reauth') return;
    if (error.code === 'unauthenticated' && accountId) {
      showGuest('Сеанс завершён. Чтобы продолжить, войдите снова.');
      focusTarget = byId('entry-title');
    } else {
      status(messageFor(error));
    }
  } finally {
    if (operation === controller) {
      finish(controller);
      if (!focusTarget.hidden && (document.activeElement === document.body || document.activeElement === byId('cancel'))) {
        focusTarget.focus();
      }
    }
  }
}

function credentialError(error, action) {
  if (error.code === 'email_taken') return 'Этот адрес уже используется. Войдите с ним или укажите другую почту.';
  if (error.code === 'invalid_email') return emailHelp;
  if (error.code === 'invalid_name') return nameHelp;
  if (error.code === 'invalid_password') return passwordHelp;
  if (error.code === 'invalid_credentials') return action === 'recover'
    ? 'Проверьте почту или прежний логин и код восстановления.' : 'Проверьте почту или прежний логин и пароль.';
  if (error.code === 'username_already_linked') return 'У этого аккаунта уже есть почта для входа.';
  if (error.status === 429 || error.status === 503) return messageFor(error);
  return action === 'register' ? 'Не удалось подтвердить регистрацию. Проверьте соединение или попробуйте войти с указанной почтой.'
    : 'Не удалось получить подтверждение сервера. Проверьте соединение и попробуйте ещё раз.';
}

function showPassword(visible, inputId = 'password', buttonId = 'show-password') {
  byId(inputId).type = visible ? 'text' : 'password';
  const button = byId(buttonId);
  button.textContent = visible ? 'Скрыть' : 'Показать';
  button.setAttribute('aria-label', button.textContent + ' пароль');
}
byId('show-password').addEventListener('click', () => showPassword(byId('password').type === 'password'));
form.noValidate = true;
form.addEventListener('reset', () => {
  clearCredentialError();
  showPassword(false);
});
form.addEventListener('input', event => {
  event.target.setCustomValidity('');
  const marked = form.querySelector('[aria-invalid="true"]');
  if (!marked || marked === event.target) clearCredentialError();
});
form.addEventListener('focusout', event => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.value || !(event.relatedTarget instanceof HTMLInputElement)) return;
  validateField(input);
  if (!input.validity.valid) credentialFeedback(input.validationMessage, input, false);
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (operation || receiptAction || byId('entry').hidden) return;
  if (!validateCredentials()) return;
  const controller = begin();
  if (!controller) return;
  const action = mode;
  let focusAfter;
  const oldAccount = accountId;
  const pending = action === 'login' ? 'Проверяем вход…' : 'Сохраняем…';
  byId('credential-submit').textContent = pending;
  status(pending);
  try {
    if (action === 'link') {
      const session = await getAccountSession(controller.signal);
      if (controller.signal.aborted) return;
      if (!session.authenticated) { showGuest('Сеанс завершён. Войдите снова.'); return; }
      if (session.accountId !== oldAccount || session.profile) {
        form.reset();
        showAccount(session);
        status('Данные аккаунта изменились. Проверьте текущий аккаунт.');
        return;
      }
    }
    const result = await submitCredentials(action, {
      username: byId('username').value.trim(), email: byId('email').value.trim(), name: byId('name').value.trim(),
      password: byId('password').value, recoveryCode: byId('recovery-code').value.trim()
    }, controller.signal);
    if (controller.signal.aborted) return;
    if (action !== 'login') {
      showReceipt(result.recoveryCode, action);
      if (emailRecoveryEnabled() && (action === 'register' || action === 'link')) {
        const current = ++receiptNumber;
        status('Запрашиваем письмо для подтверждения почты…');
        // The editor and recovery code stay available even if delivery is slow.
        sendVerification(controller.signal).then(({ accepted, message }) => {
          if (current !== receiptNumber || receiptAction !== action) return;
          if (!accepted) byId('reserve-code').open = true;
          status(message);
        });
      }
    } else if (mailFlow?.kind === 'verify' && mailFlow.signIn) {
      showMail('verify', mailFlow.token);
      status('Вы вошли. Нажмите «Подтвердить почту», чтобы завершить подтверждение.');
    } else if (passwordReauth) {
      const session = await getAccountSession(controller.signal);
      if (controller.signal.aborted) return;
      form.reset();
      passwordReauth = false;
      if (!session.authenticated) { showGuest('Войдите ещё раз.'); return; }
      reauthFor = null;
      showAccount(session);
      if (session.accountId === oldAccount && !session.profile) editCredentials('link');
      else {
        status(session.accountId === oldAccount ? 'У этого аккаунта уже есть почта.' : 'Вы вошли в другой аккаунт.');
        focusAfter = byId('account-title');
      }
    } else {
      mailFlow = null;
      form.reset();
      await continueAfterSignIn(controller.signal);
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    if (action === 'link' && error.code === 'reauth_required') {
      form.reset();
      reauthFor = oldAccount;
      byId('entry').hidden = true;
      byId('account').hidden = false;
      byId('link-username').hidden = true;
      byId('reauth').hidden = false;
      status('Подтвердите вход ещё раз, чтобы добавить почту.');
      focusAfter = byId('reauth');
    } else if (error.code === 'unauthenticated') {
      showGuest('Сеанс завершён. Войдите снова.');
    } else {
      status('');
      const field = { email_taken: 'email', invalid_email: 'email', invalid_name: 'name', invalid_password: 'password',
        invalid_credentials: action === 'recover' ? 'recovery-code' : 'password' }[error.code];
      credentialFeedback(credentialError(error, action), field && byId(field));
    }
  } finally {
    byId('credential-submit').textContent = submitLabels[mode];
    finish(controller);
    if (focusAfter && !focusAfter.hidden) focusAfter.focus();
  }
});

function syncModeFromURL() {
  if (readMailLink() || mailFlow || receiptAction || operation || accountId || passwordReauth) return;
  const requested = requestedMode();
  if (requested !== mode) editCredentials(requested);
}

for (const button of document.querySelectorAll('[data-mode]')) {
  button.addEventListener('click', event => {
    event.preventDefault();
    if (operation || receiptAction || accountId || mode === button.dataset.mode) return;
    if (button.dataset.mode === 'recover' && emailRecoveryEnabled()) {
      const identifier = byId('username').value.trim();
      showMail('request');
      if (identifier.includes('@')) byId('mail-address').value = identifier;
      byId('mail-address').focus();
      return;
    }
    mailFlow = null;
    updateModeURL(button.dataset.mode);
    syncModeFromURL();
  });
}
window.addEventListener('hashchange', syncModeFromURL);
window.addEventListener('popstate', syncModeFromURL);
byId('link-username').addEventListener('click', () => editCredentials('link'));
byId('cancel-link').addEventListener('click', async () => {
  const target = passwordReauth ? byId('reauth') : byId('link-username');
  passwordReauth = false;
  form.reset();
  setMode('login');
  if (toSets) { openEditor(); return; }
  await check();
  if (!byId('account').hidden) (target.hidden ? byId('account-title') : target).focus();
});
byId('copy-code').addEventListener('click', async () => {
  const field = byId('issued-code');
  try {
    await navigator.clipboard.writeText(field.value);
    if (receiptAction) status('Код скопирован.');
  } catch {
    if (receiptAction) {
      field.focus();
      field.select();
      status('Код выделен. Скопируйте его через меню.');
    }
  }
});
byId('save-code').addEventListener('click', () => {
  if (!receiptAction) return;
  const file = new Blob(['Код восстановления Угловато\n', byId('issued-code').value,
    '\n\nhttps://uglovato.ru/register/?next=account#recover\nВведите свою почту или прежний логин, этот код и новый пароль.\n'], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'uglovato-recovery.txt';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
byId('code-saved').addEventListener('click', () => {
  const action = receiptAction;
  if (!action || operation) return;
  clearReceipt();
  status('');
  if (toAccount || toSets || action === 'link') {
    updateModeURL('login', true);
    showGuest();
    setMode('login');
    check({ receipt: action });
  }
  else openEditor();
});

for (const button of authButtons) button.addEventListener('click', () => act(button.id));
byId('retry').addEventListener('click', check);
byId('cancel').addEventListener('click', () => operation?.abort());
window.addEventListener('pagehide', event => {
  closeAgentTools();
  if (mailFlow) {
    mailFlow = null;
    byId('mail-form').reset();
    byId('mail-view').hidden = true;
    form.reset();
    setMode(requestedMode());
    showGuest();
  }
  renderProfile(null);
  if (!event.persisted) {
    clearPromo();
    form.reset();
    clearReceipt();
  }
  clearOffers();
  clearTimeout(expiryTimer);
  clearTimeout(accessTimer);
  sessionCheck?.abort();
  operation?.abort();
  if (operation) finish(operation);
});
if (emailRecoveryEnabled()) byId('email-hint').textContent = 'На этот адрес придёт письмо для подтверждения.';
setMode(requestedMode());
window.addEventListener('pageshow', event => {
  if (event.persisted) {
    syncModeFromURL();
    check({ background: true });
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') check({ background: true });
});
if (!readMailLink()) check();
