// Endereço do servidor que o app aceita. No APK só HTTPS: por HTTP o token e as senhas passam
// abertos pela rede (Wi-Fi da empresa, por exemplo). HTTP só no desenvolvimento (Expo Go, __DEV__),
// para testar com o servidor do computador na rede local.
export function devBuild() {
  return typeof __DEV__ !== 'undefined' && __DEV__ === true;
}

export function serverUrlAllowed(url, { allowHttp = devBuild() } = {}) {
  if (typeof url !== 'string') return false;
  if (/^https:\/\/[^/\s]+/i.test(url)) return true;
  return allowHttp && /^http:\/\/[^/\s]+/i.test(url);
}
