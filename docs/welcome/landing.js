// Older cached landing pages loaded this script to choose their entry action.
const guestActions = document.querySelector('.actions[data-when="offline"]');
if (guestActions) {
  const accountEntry = document.createElement('a');
  accountEntry.className = 'primary';
  accountEntry.href = 'register/?next=account';
  accountEntry.textContent = 'Перейти в кабинет';
  guestActions.replaceChildren(accountEntry);
}
