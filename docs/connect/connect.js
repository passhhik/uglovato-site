const clients = document.querySelector('.clients');
const panels = document.querySelectorAll('[data-client]');
const feedback = document.querySelector('.feedback');
let noticeTimer;

function showClient() {
  const choice = clients.querySelector(':checked').value;
  for (const panel of panels) panel.hidden = panel.dataset.client !== choice;
  feedback.textContent = '';
}

clients.addEventListener('change', showClient);
showClient();
clients.hidden = false;
for (const heading of document.querySelectorAll('.no-switch')) heading.hidden = true;

for (const button of document.querySelectorAll('[data-copy]')) {
  button.hidden = false;
  button.addEventListener('click', async () => {
    const source = document.getElementById(button.dataset.copy);
    clearTimeout(noticeTimer);
    try {
      await navigator.clipboard.writeText(source.textContent);
      const messages = { 'desktop-config': 'JSON скопирован', 'claude-add': 'Команды скопированы', 'codex-add': 'Команды скопированы' };
      feedback.textContent = source.tagName === 'BLOCKQUOTE' ? 'Задание скопировано' : messages[source.id] || 'Команда скопирована';
    } catch {
      const selection = window.getSelection();
      selection.selectAllChildren(source);
      feedback.textContent = 'Текст выделен. Выберите «Скопировать» в меню.';
    }
    noticeTimer = setTimeout(() => { feedback.textContent = ''; }, 4500);
  });
}
