import { getEndpoint, getSession } from '../register/client.js';

const link = document.getElementById('editorAccount');
// Only the editor tab that started sign-in should resume its draft.
function enableDraftReturn() {
  if (location.origin !== 'https://uglovato.ru' || !window.BroadcastChannel || !crypto.randomUUID) return;
  const ticket = crypto.randomUUID();
  let channel;
  function attachTicket(event) {
    const anchor = event.target.closest('a');
    if (!anchor || !['editorAccount', 'setRegister', 'setPaymentLogin'].includes(anchor.id)) return;
    const url = new URL(anchor.href);
    if (url.origin !== location.origin || url.pathname !== '/register/' || anchor.target !== '_blank') return;
    try {
      if (!channel) {
        channel = new BroadcastChannel('uglovato-editor-' + ticket);
        channel.onmessage = ({data}) => {
          if (data !== 'resume-sets' && data !== 'resume-editor') return;
          if (data === 'resume-sets' && location.hash !== '#sets') location.hash = 'sets';
          channel.postMessage('resumed');
        };
      }
      anchor.hash = 'editor-' + ticket;
    } catch { /* Ordinary sign-in still works if the browser isolates tabs. */ }
  }
  document.addEventListener('click', attachTicket, true);
  document.addEventListener('auxclick', attachTicket, true);
  window.addEventListener('pagehide', () => { channel?.close(); channel = null; });
}
if (getEndpoint()) {
  link.hidden = false;
  enableDraftReturn();
  let checking = false;
  async function refresh() {
    if (checking || document.hidden) return;
    checking = true;
    try {
      const session = await getSession();
      link.textContent = session.authenticated
        ? (session.access.plan === 'plus' ? 'Мой аккаунт · Наборы' : 'Мой аккаунт')
        : 'Войти';
    } catch {
      link.textContent = 'Аккаунт';
    } finally {
      checking = false;
    }
  }
  window.addEventListener('pageshow', refresh);
  document.addEventListener('visibilitychange', refresh);
  refresh();
}
