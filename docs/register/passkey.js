import { AuthError, post } from './client.js?v=browser1';

function decode(value) {
  if (typeof value !== 'string' || !/^[\w-]+$/.test(value)) throw new AuthError('invalid_reply');
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(value, { alphabet: 'base64url' });
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}

function encode(value) {
  const bytes = ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value);
  if (bytes.toBase64) return bytes.toBase64({ alphabet: 'base64url', omitPadding: true });
  let data = '';
  for (const byte of bytes) data += String.fromCharCode(byte);
  return btoa(data).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function parseOptions(json) {
  if (PublicKeyCredential.parseRequestOptionsFromJSON) {
    return PublicKeyCredential.parseRequestOptionsFromJSON(json);
  }
  const options = { ...json, challenge: decode(json.challenge) };
  if (json.allowCredentials) {
    options.allowCredentials = json.allowCredentials.map(item => ({ ...item, id: decode(item.id) }));
  }
  return options;
}

function serialize(credential) {
  if (credential.toJSON) return credential.toJSON();
  const data = credential.response;
  const response = {
    clientDataJSON: encode(data.clientDataJSON),
    authenticatorData: encode(data.authenticatorData),
    signature: encode(data.signature),
  };
  if (data.userHandle != null) response.userHandle = encode(data.userHandle);
  return { id: credential.id, type: credential.type, rawId: encode(credential.rawId), response,
    clientExtensionResults: credential.getClientExtensionResults(), authenticatorAttachment: credential.authenticatorAttachment };
}

export function supportsPasskeys() {
  return Boolean(window.isSecureContext && window.PublicKeyCredential && navigator.credentials?.get);
}

export async function verifyPasskey(kind, signal, onStage) {
  if (kind !== 'login') throw new AuthError('unknown_operation');
  const { flowId, options } = await post('login/options', {}, signal);
  if (typeof flowId !== 'string' || !flowId || !options) throw new AuthError('invalid_reply');
  onStage('prompt');
  const credential = await navigator.credentials.get({ publicKey: parseOptions(options), signal });
  if (!credential) throw new DOMException('Cancelled', 'NotAllowedError');
  onStage('verify');
  const result = await post('login/verify', { flowId, response: serialize(credential) }, signal);
  if (result.verified !== true) throw new AuthError('unverified');
}
