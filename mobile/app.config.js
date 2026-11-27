// Com a chave do Firebase (google-services.json) o Android recebe avisos com o app fechado. Sem o
// arquivo o build funciona, só sem esses avisos.
//
// Segurança: HTTP sem criptografia (usesCleartextTraffic no Android, NSAllowsArbitraryLoads no iOS)
// só no perfil "development" do EAS. O APK de uso (preview, production ou sem perfil) fala só HTTPS:
// por HTTP o token e as senhas passariam abertos pela rede.
const fs = require('fs');
const path = require('path');

const CLEARTEXT_PLUGIN = './plugins/with-cleartext-traffic';

function withoutCleartext(config) {
  const android = { ...config.android };
  delete android.usesCleartextTraffic;
  const ats = { ...(config.ios?.infoPlist?.NSAppTransportSecurity || {}) };
  delete ats.NSAllowsArbitraryLoads;
  return {
    ...config,
    android,
    ios: config.ios && {
      ...config.ios,
      infoPlist: { ...config.ios.infoPlist, NSAppTransportSecurity: ats },
    },
    plugins: (config.plugins || []).filter((p) => p !== CLEARTEXT_PLUGIN),
  };
}

module.exports = ({ config }) => {
  let result = process.env.EAS_BUILD_PROFILE === 'development' ? config : withoutCleartext(config);
  const key = path.join(__dirname, 'google-services.json');
  if (fs.existsSync(key)) {
    result = { ...result, android: { ...result.android, googleServicesFile: './google-services.json' } };
  }
  return result;
};
