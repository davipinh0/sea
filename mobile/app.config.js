// Com a chave do Firebase (google-services.json) o Android recebe avisos com o app fechado. Sem o
// arquivo o build funciona, só sem esses avisos.
const fs = require('fs');
const path = require('path');

module.exports = ({ config }) => {
  const key = path.join(__dirname, 'google-services.json');
  if (fs.existsSync(key)) {
    return { ...config, android: { ...config.android, googleServicesFile: './google-services.json' } };
  }
  return config;
};
