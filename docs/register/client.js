// Load config.js before importing this module, also on the editor page.
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);

export function getEndpoint() {
  const setting = window.uglovatoAuth?.endpoint;
  if (typeof setting !== 'string' || !setting.trim()) return null;
  try {
    const raw = setting.trim();
    const url = raw.startsWith('/') && !raw.startsWith('//')
      ? new URL(raw, location.origin) : new URL(raw);
    if (url.username || url.password || url.search || url.hash) return null;
    if (['https://auth.uglovato.ru', 'https://uglovato.ru', 'https://www.uglovato.ru'].includes(location.origin)) {
      if (location.origin === 'https://uglovato.ru' && url.href === location.origin + '/api/account') return url.href;
      return url.href === 'https://auth.uglovato.ru/auth' ? url.href : null;
    }
    // The register page's CSP allows a local API through a same-origin proxy.
    const local = loopback.has(location.hostname) && url.origin === location.origin && url.protocol === 'http:';
    return local || (location.protocol === 'https:' && url.origin === location.origin) ? url.href : null;
  } catch {
    return null;
  }
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
  return (location.origin === 'https://uglovato.ru' && endpoint === location.origin + '/api/account') ||
    location.origin === 'https://auth.uglovato.ru' ||
    (loopback.has(location.hostname) && new URL(endpoint).origin === location.origin);
}

export async function post(op, body = {}, signal) {
  if (op.startsWith('email/') && !emailRecoveryEnabled()) throw new AuthError('email_unavailable');
  const endpoint = getEndpoint();
  if (!endpoint) throw new AuthError('not_configured');
  const url = new URL(endpoint);
  url.search = '?op=' + op;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 15000);
  try {
    const result = await fetch(url, {
      method: 'POST', credentials: 'include', redirect: 'error', cache: 'no-store',
      keepalive: op === 'email/send-verification',
      referrerPolicy: 'strict-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: controller.signal
    });
    const json = await result.json().catch(() => null);
    if (!result.ok) {
      throw new AuthError(json?.error?.code || 'unavailable', result.status, result.headers.get('Retry-After'));
    }
    if (!json || typeof json !== 'object') throw new AuthError('invalid_reply');
    return json;
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) throw new AuthError('network_timeout');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

export async function emailAction(action, fields, signal) {
  const results = { 'request-reset': 'accepted', reset: 'reset', 'send-verification': 'accepted', verify: 'verified' };
  if (!Object.hasOwn(results, action)) throw new AuthError('invalid_operation');
  const reply = await post('email/' + action, fields, signal);
  if (reply[results[action]] !== true) throw new AuthError('invalid_reply');
}

export async function getSession(signal, { profile = false } = {}) {
  if (!getEndpoint()) return { authenticated: false };
  try {
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
