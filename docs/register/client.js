// Load config.js before importing this module, also on the editor page.
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);

const site = 'https://uglovato.ru';
const account = 'https://auth.uglovato.ru';
const browserEndpoint = 'https://functions.yandexcloud.net/d4ervn55pqa3ehtihll1';

export function browserMode() { return location.origin === site; }

export function getEndpoint() {
  if (browserMode()) return window.uglovatoAuth?.endpoint === 'browser-v1' ? browserEndpoint : null;
  const setting = window.uglovatoAuth?.endpoint;
  if (location.origin === account) return setting === account + '/auth' ? setting : null;
  if (!loopback.has(location.hostname) || typeof setting !== 'string') return null;
  try {
    const url = new URL(setting, location.origin);
    return ['/auth', '/api/account'].some(path => url.href === location.origin + path) ? url.href : null;
  } catch { return null; }
}

export class AuthError extends Error {
  constructor(code, status = 0, retryAfter = null) {
    super(code);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function emailRecoveryEnabled() {
  const endpoint = getEndpoint();
  if (window.uglovatoAuth?.emailRecovery !== true || !endpoint) return false;
  return browserMode() ||
    location.origin === 'https://auth.uglovato.ru' ||
    (loopback.has(location.hostname) && new URL(endpoint).origin === location.origin);
}

const issuing = new Set(['username/login', 'username/register', 'username/recover', 'username/link', 'login/verify']);

async function request(op, body, signal, binary) {
  if (op.startsWith('email/') && !emailRecoveryEnabled()) throw new AuthError('email_unavailable');
  const endpoint = getEndpoint();
  if (!endpoint) throw new AuthError('not_configured');
  const url = new URL(endpoint);
  if (!/^[a-z]+(?:\/[a-z-]+)?$/.test(op)) throw new AuthError('invalid_operation');
  url.search = '?op=' + op;
  const signed = browserMode();
  const transport = signed ? await import('./browser-identity.js') : null;
  const exactBody = JSON.stringify(body);
  const auth = signed ? await transport.prepare(op, exactBody) : null;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  signal?.addEventListener('abort', cancel, { once:true });
  const timer = setTimeout(cancel, binary ? 20000 : 15000);
  try {
    const response = await fetch(url, {
      method:'POST', credentials:signed ? 'omit' : 'include', redirect:'error', cache:'no-store',
      keepalive:op === 'email/send-verification', referrerPolicy:'strict-origin',
      headers:{'Content-Type':'application/json', ...auth?.headers}, body:exactBody, signal:controller.signal
    });
    if (response.redirected || response.url !== url.href) throw new AuthError('invalid_reply');
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      const code = data?.error?.code || 'unavailable';
      if (auth?.identity.sid && op !== 'logout' && response.status === 401 && code === 'unauthenticated') {
        await transport.replaceSession(auth.identity, null);
      }
      throw new AuthError(code, response.status, response.headers.get('Retry-After'));
    }
    if (binary === 'html') {
      if (response.status !== 200 || response.headers.get('Content-Type')?.split(';')[0].trim() !== 'text/html')
        throw new AuthError('invalid_reply');
      return await response.text();
    }
    if (binary === 'archive') {
      if (response.status !== 200) throw new AuthError('invalid_reply');
      return await response.blob();
    }
    const json = await response.json().catch(() => null);
    if (!json || typeof json !== 'object') throw new AuthError('invalid_reply');
    if (signed && issuing.has(op)) {
      if ((op === 'login/verify' ? json.verified : json.authenticated) !== true ||
          typeof json.browserSessionId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(json.browserSessionId) ||
          json.browserSessionId === auth.identity.sid)
        throw new AuthError('invalid_reply');
      if (!await transport.replaceSession(auth.identity,json.browserSessionId)) throw new AuthError('session_changed');
    }
    return json;
  } catch (error) {
    if (signed && op === 'logout') throw new AuthError('local_logout');
    if (controller.signal.aborted && !signal?.aborted) throw new AuthError('network_timeout');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    if (signed && op === 'logout' && !await transport.replaceSession(auth.identity, null))
      throw new AuthError('session_changed');
  }
}

export function post(op, body = {}, signal) { return request(op, body, signal); }
export function getEditorHTML(signal) { return request('editor/open', {}, signal, 'html'); }
export function getAgentArchive(signal) { return request('editor/agent-package', {}, signal, 'archive'); }

export async function emailAction(action, fields, signal) {
  const results = { 'request-reset': 'accepted', reset: 'reset', 'send-verification': 'accepted', verify: 'verified' };
  if (!Object.hasOwn(results, action)) throw new AuthError('invalid_operation');
  const reply = await post('email/' + action, fields, signal);
  if (reply[results[action]] !== true) throw new AuthError('invalid_reply');
}

export async function getSession(signal, { profile = false } = {}) {
  if (!getEndpoint()) return { authenticated: false };
  try {
    if (browserMode() && !(await (await import('./browser-identity.js')).existingIdentity())?.sid)
      return { authenticated:false };
    const session = await post('session', profile ? { profile: true } : {}, signal);
    if (session.authenticated !== true || typeof session.accountId !== 'string' || !session.accountId ||
        !Number.isFinite(Date.parse(session.expiresAt)) || !['free', 'plus'].includes(session.access?.plan) ||
        !(session.access.validUntil === null || Number.isFinite(Date.parse(session.access.validUntil)))) {
      throw new AuthError('invalid_reply');
    }
    if (profile && session.profile !== null &&
        (typeof session.profile?.name !== 'string' || typeof session.profile?.email !== 'string')) {
      throw new AuthError('invalid_reply');
    }
    return session;
  } catch (error) {
    if (error.status === 401) return { authenticated: false };
    throw error;
  }
}

export async function logout(signal) {
  const result = await post('logout', {}, signal);
  if (result.loggedOut !== true) throw new AuthError('invalid_reply');
  return result;
}

export async function submitCredentials(mode, fields, signal) {
  if (!['login', 'register', 'recover', 'link'].includes(mode)) throw new AuthError('invalid_operation');
  const body = mode === 'register' || mode === 'link'
    ? { name: fields.name, email: fields.email, password: fields.password }
    : { username: fields.username, password: fields.password };
  if (mode === 'recover') body.recoveryCode = fields.recoveryCode;
  const reply = await post('username/' + mode, body, signal);
  if (reply.authenticated !== true || (mode !== 'login' &&
      (typeof reply.recoveryCode !== 'string' || !reply.recoveryCode))) throw new AuthError('invalid_reply');
  return reply;
}

export async function getSetAccess(signal) {
  try {
    const state = await post('sets/access', {}, signal);
    if (state.authenticated !== true || typeof state.active !== 'boolean' || typeof state.returning !== 'boolean' ||
        (state.checkoutEnabled !== undefined && typeof state.checkoutEnabled !== 'boolean') ||
        (state.active && state.returning) || (state.interest !== undefined && !['week', 'month'].includes(state.interest))) throw new AuthError('invalid_reply');
    return state;
  } catch (error) {
    if (error.status === 401 && error.code === 'unauthenticated')
      return { active: false, returning: false, authenticated: false };
    throw error;
  }
}

export async function startSetCheckout(offer, signal) {
  if (!['week', 'month'].includes(offer)) throw new AuthError('invalid_offer');
  const result = await post('sets/checkout', { offer }, signal);
  let url;
  try { url = new URL(result.paymentUrl); } catch { throw new AuthError('invalid_reply'); }
  if (url.origin !== 'https://auth.robokassa.ru' || url.username || url.password || url.hash ||
      !['/Merchant/Index', '/Merchant/Index.aspx'].includes(url.pathname)) throw new AuthError('invalid_reply');
  return url.href;
}

export async function expressSetInterest(offer, signal) {
  if (!['week', 'month'].includes(offer)) throw new AuthError('invalid_offer');
  const result = await post('sets/interest', { offer }, signal);
  if (result.interest !== offer) throw new AuthError('invalid_reply');
  return result;
}
