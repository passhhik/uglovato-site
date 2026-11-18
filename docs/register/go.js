const values = new URLSearchParams(location.search).getAll('next');
const next = values.length === 1 && ['account', 'sets'].includes(values[0]) ? values[0] : '';
const toSets = next === 'sets';
const ticketKey = 'uglovato.editor.return';
const ticketPattern = /^#editor-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

async function returnToEditor() {
  let ticket, channel;
  try {
    ticket = sessionStorage.getItem(ticketKey);
    sessionStorage.removeItem(ticketKey);
    if (ticket && ticketPattern.test('#editor-' + ticket)) {
      channel = new BroadcastChannel('uglovato-editor-' + ticket);
      const resumed = await new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), 1200);
        channel.onmessage = ({data}) => {
          if (data === 'resumed') { clearTimeout(timer); resolve(true); }
        };
        channel.postMessage(toSets ? 'resume-sets' : 'resume-editor');
      });
      if (resumed) window.close();
    }
  } catch { /* The editor may have been closed or its storage cleared. */ }
  finally { channel?.close(); }
  if (!window.closed) location.replace('/editor/' + (toSets ? '#sets' : ''));
}

if (next && location.hash === '#return-editor') {
  returnToEditor();
} else if (toSets && location.hash === '#resume-sets') {
  try {
    const editor = window.opener;
    if (editor && !editor.closed && editor.location.origin === location.origin && editor.location.pathname === '/editor/') {
      editor.location.hash = 'sets';
      editor.focus();
      window.close();
    }
  } catch { /* Other openers do not participate. */ }
  if (!window.closed) location.replace('/editor/#sets');
}
