#!/bin/bash

# Symlink into PATH (mirrors electron-builder default template)
if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/salvium-vault-desktop' -a -e '/usr/bin/salvium-vault-desktop' -a "`readlink '/usr/bin/salvium-vault-desktop'`" != '/etc/alternatives/salvium-vault-desktop' ]; then
        rm -f '/usr/bin/salvium-vault-desktop'
    fi
    update-alternatives --install '/usr/bin/salvium-vault-desktop' 'salvium-vault-desktop' '/opt/Salvium Vault/salvium-vault-desktop' 100 || ln -sf '/opt/Salvium Vault/salvium-vault-desktop' '/usr/bin/salvium-vault-desktop'
else
    ln -sf '/opt/Salvium Vault/salvium-vault-desktop' '/usr/bin/salvium-vault-desktop'
fi

# SUID chrome-sandbox for Electron 5+
chmod 4755 '/opt/Salvium Vault/chrome-sandbox' || true

# Load the AppArmor profile so the Chromium user-namespace sandbox works on
# Ubuntu 23.10+ / 24.04+ (kernel.apparmor_restrict_unprivileged_userns=1).
# Older parsers that reject the profile are systems that do not restrict
# user namespaces, so failure here is harmless.
if [ -d /sys/kernel/security/apparmor ] && command -v apparmor_parser >/dev/null 2>&1; then
    apparmor_parser -r /etc/apparmor.d/salvium-vault-desktop 2>/dev/null || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
