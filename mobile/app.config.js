// Extends app.json. The Firebase key (google-services.json) is what lets
// Android deliver notifications while the app is closed; the build uses
// it when the file is present in this folder and works without it.
const fs = require('fs');
const path = require('path');

module.exports = ({ config }) => {
  const key = path.join(__dirname, 'google-services.json');
  if (fs.existsSync(key)) {
    return { ...config, android: { ...config.android, googleServicesFile: './google-services.json' } };
  }
  return config;
};
