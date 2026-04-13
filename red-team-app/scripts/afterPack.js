const { execSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  // Only sign the final universal build, not per-arch temp builds
  if (context.appOutDir.includes('-temp')) {
    console.log(`[sign] Skipping temp build: ${context.appOutDir}`);
    return;
  }

  if (process.platform !== 'darwin') return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  console.log(`[sign] Signing ${appPath} with "Hinty Developer" identity...`);
  try {
    execSync(`codesign --force --deep --sign "Hinty Developer" "${appPath}"`, { stdio: 'inherit' });
    execSync(`codesign --verify --verbose "${appPath}"`, { stdio: 'inherit' });
    console.log('[sign] Done');
  } catch (err) {
    console.warn('[sign] Signing failed, falling back to ad-hoc:', err.message);
    try {
      execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
    } catch (e) {
      console.warn('[sign] Ad-hoc signing also failed:', e.message);
    }
  }
};
