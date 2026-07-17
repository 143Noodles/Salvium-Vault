#!/bin/bash
set -eu

# Symlink into PATH (mirrors electron-builder default template)
if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/salvium-vault-desktop' -a -e '/usr/bin/salvium-vault-desktop' -a "`readlink '/usr/bin/salvium-vault-desktop'`" != '/etc/alternatives/salvium-vault-desktop' ]; then
        rm -f '/usr/bin/salvium-vault-desktop'
    fi
    update-alternatives --install '/usr/bin/salvium-vault-desktop' 'salvium-vault-desktop' '/opt/SalviumVault/salvium-vault-desktop' 100 || ln -sf '/opt/SalviumVault/salvium-vault-desktop' '/usr/bin/salvium-vault-desktop'
else
    ln -sf '/opt/SalviumVault/salvium-vault-desktop' '/usr/bin/salvium-vault-desktop'
fi

# Electron's Chromium renderer must never fall back to --no-sandbox. The
# Debian package installs as root, so make the setuid sandbox helper ownership
# and mode explicit and fail the package installation if either operation fails.
chown root:root '/opt/SalviumVault/chrome-sandbox'
chmod 4755 '/opt/SalviumVault/chrome-sandbox'

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
