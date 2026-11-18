// The legacy form is also packaged with these assets on the account subdomain.
window.uglovatoAuth = Object.freeze(location.origin === 'https://uglovato.ru'
  ? {endpoint:'browser-v1', emailRecovery:true}
  : {endpoint:'https://auth.uglovato.ru/auth'});
