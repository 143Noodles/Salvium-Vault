// Ad-hoc code-sign the macOS .app so Apple Silicon doesn't reject it as
// "damaged" (arm64 requires at least an ad-hoc signature). This is NOT
// notarization: users still get a one-time "unidentified developer" prompt
// until a real Apple Developer cert is added.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename + '.app';
  const appPath = path.join(context.appOutDir, appName);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  console.log('[afterPack] ad-hoc signed ' + appPath);
};
