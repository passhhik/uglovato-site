import { createAdminReport } from './report.js';
import { createAdminPromos } from './promo.js';
import { createAdminUsers } from './users.js';

// Keep the manual key form out of password-extension scanning while preserving
// the browser's native masking, paste, validation and Enter-to-submit.
const entry = document.getElementById('manual-entry');
const loginRoot = entry?.attachShadow({ mode: 'closed', delegatesFocus: true });
if (loginRoot) {
  const style = document.querySelector('link[href="./style.css"]').cloneNode();
  loginRoot.append(style, ...entry.childNodes);
}
const el = id => document.getElementById(id) || loginRoot?.getElementById(id);
// Set by the released cabinet document. A missing endpoint disables owner requests.
const relayEndpoint = document.querySelector('meta[name="uglovato-admin-relay"]')?.content;
const tabs = { report: el('tab-report'), promo: el('tab-promo'), users: el('tab-users') };
const secure = window.isSecureContext && !!window.crypto?.subtle;
let session = null, section, pendingLogin;

function digestHex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = crypto.subtle.digest('SHA-256', bytes);
  bytes.fill(0);
  return digest.then(buffer => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join(''));
}

function message(text, error = false) {
  const status = el(section === 'report' ? 'status' : section + '-status');
  status.classList.toggle('is-error', error);
  status.textContent = text;
}

function logout() {
  pendingLogin = null;
  resetRetry();
  if (session) session.raw = session.proof = '';
  session = null;
  report.clear();
  promos.clear({ logout: true });
  users.clear();
  el('login').reset();
  el('key').value = '';
  el('end-date').value = '';
  el('period').value = '7';
  el('session-actions').hidden = el('retry').hidden = el('readonly-hint').hidden = true;
  el('access').hidden = !secure;
}

function resetRetry() {
  el('retry').hidden = true;
  el('retry').onclick = null;
}

function failed(read = openSection, label = 'Повторить запрос') {
  el('retry').textContent = label;
  el('retry').onclick = () => { resetRetry(); read(); };
  el('retry').hidden = false;
}
function sectionOpened() {
  resetRetry();
  // This analytics exclusion flag carries no credentials or access rights.
  try { localStorage.setItem('uglovato.owner', '1'); } catch {}
}
const report = createAdminReport({
  getProof: () => section === 'report' ? session?.proof : '',
  setAccess,
  opened: sectionOpened,
  denied() {
    if (session.managementVerified) {
      report.clear();
      failed();
      message('Статистика не приняла ключ. Вы можете вернуться в раздел управления.', true);
    } else {
      logout();
      message('Ключ не принят. Проверьте его и повторите вход.', true);
      el('key').focus();
    }
  },
  failed,
});
function setAccess(access) {
  session.role = access;
  if (access === 'report') {
    session.raw = '';
    session.managementVerified = false;
  }
  el('readonly-hint').hidden = access !== 'report';
}

function ownerAccess(name, api) {
  return {
    async post(action, body, signal) {
      signal.throwIfAborted();
      // Only the section where the key was entered can verify an unclassified key.
      const explicitLogin = session?.entry === name && session.role === null;
      if (section !== name || !session?.raw || (session.role !== 'owner' && !explicitLogin)) throw new Error('Ключ владельца требуется');
      resetRetry();
      // Reader keys also support Unicode. Only the owner header has this wire format.
      if (!/^[!-~]{32,256}$/.test(session.raw)) {
        throw Object.assign(new Error('invalid_owner_key'), { status: 401, code: 'promo_admin_unauthorized' });
      }
      if (!relayEndpoint) throw new Error('relay_unconfigured');
      const url = new URL(relayEndpoint);
      url.searchParams.set('op', 'admin/' + api + '/' + action);
      const response = await fetch(url, {
        method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
        headers: { 'X-Uglovato-Owner-Key': session.raw, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal,
      });
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw Object.assign(new Error('request_failed'), { status: response.status, code: error?.error?.code });
      }
      const data = await response.json();
      signal.throwIfAborted();
      return data;
    },
    opened() { setAccess('owner'); session.managementVerified = true; sectionOpened(); },
    denied() {
      session.raw = '';
      session.managementVerified = false;
      promos.clear({ logout: true });
      users.clear();
      el('access').hidden = false;
      resetRetry();
      message(name === 'promo' ? 'Сервис промокодов не принял ключ. Введите ключ владельца.' :
        'Сервис пользователей не принял ключ владельца. Повторите вход.', true);
      el('key').focus();
    },
    failed,
  };
}

const promos = createAdminPromos(ownerAccess('promo', 'promos'));
const users = createAdminUsers(ownerAccess('users', 'users'));

function openSection() {
  users.clear();
  report.clear();
  promos.clear();
  resetRetry();
  el('readonly-hint').hidden = session?.role !== 'report';
  el('session-actions').hidden = !session;
  const needsOwnerKey = section !== 'report' && (!session?.raw || (!session.role && session.entry !== section));
  const needsKey = !session || needsOwnerKey;
  el('login-heading').textContent = { report: 'Вход в кабинет', promo: 'Вход для выдачи промокодов', users: 'Вход для управления пользователями' }[section];
  el('key-label').textContent = section !== 'report' ? 'Ключ владельца' : 'Ключ доступа';
  el('access').hidden = !secure || !needsKey;
  if (!secure) return message('Откройте кабинет по HTTPS в браузере с поддержкой Web Crypto.', true);
  if (needsKey || !session.proof) return;
  if (section === 'report') report.open();
  else if (section === 'promo') promos.open();
  else users.open();
}

function route() {
  pendingLogin = null;
  section = { 'promo.html': 'promo', 'users.html': 'users' }[location.pathname.split('/').pop()] || 'report';
  for (const [name, tab] of Object.entries(tabs)) {
    if (name === section) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  el('section-title').textContent = tabs[section].textContent;
  document.title = tabs[section].textContent + ' · Кабинет Угловато';
  openSection();
}
for (const [name, tab] of Object.entries(tabs)) {
  tab.addEventListener('click', event => {
    if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (name === section) return;
    history.pushState(null, '', tab.href);
    route();
  });
}
el('login').onsubmit = async event => {
  event.preventDefault();
  if (!secure) return;
  el('key').value = el('key').value.trim();
  if (!el('key').reportValidity()) return;
  const attempt = {};
  pendingLogin = attempt;
  const raw = el('key').value;
  el('key').value = '';
  message('Проверяем ключ…');
  try {
    const inner = await digestHex(raw);
    if (pendingLogin !== attempt) return;
    const outer = await digestHex('uglovato/admin/report/v1:' + inner);
    if (pendingLogin !== attempt) return;
    const proof = 'v1.' + outer;
    if (section !== 'report' && session?.role === 'report' && session.proof === proof) {
      message('Это тот же ключ чтения. Для управления введите ключ владельца. Статистика по-прежнему доступна.', true);
      el('key').focus();
      return;
    }
    logout();
    session = { raw, proof, role: null, entry: section, managementVerified: false };
    openSection();
  } catch {
    if (pendingLogin !== attempt) return;
    logout();
    message('Не удалось подготовить ключ. Повторите вход.', true);
  } finally {
    if (pendingLogin === attempt) pendingLogin = null;
  }
};
el('logout').onclick = () => { logout(); el('key').focus(); };
document.documentElement.classList.toggle('embedded', window.self !== window.top);
if (location.hash === '#promo' || location.hash === '#users') history.replaceState(null, '', tabs[location.hash.slice(1)].href);
window.addEventListener('popstate', route);
window.addEventListener('pagehide', logout);
route();
if (entry) entry.hidden = false;
