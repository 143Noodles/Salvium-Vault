# Salvium Vault

A secure, non-custodial web wallet for the [Salvium](https://salvium.io) cryptocurrency. Built with React and powered by WebAssembly for native-level performance directly in your browser.

## Overview

Salvium Vault is a fully client-side wallet that lets you create, manage, and transact with SAL without trusting a third party with your keys. All cryptographic operations happen locally in your browser using WebAssembly compiled from Salvium's C++ codebase.

**Live Site:** [https://vault.salvium.tools](https://vault.salvium.tools)

## Features

- **Non-Custodial** - Your keys, your crypto. Private keys never leave your browser
- **Create & Restore Wallets** - Generate new wallets with BIP39 seed phrases or restore existing ones
- **Send & Receive SAL** - Full transaction support with fee estimation
- **Staking** - Stake and unstake SAL directly from the wallet
- **Transaction History** - View complete transaction history with real-time updates
- **Biometric Unlock** - Optional Face ID / Touch ID / Windows Hello support
- **Encrypted Backups** - Export and import encrypted wallet backups
- **WebAssembly Powered** - Native performance for cryptographic operations
- **Responsive Design** - Works on desktop and mobile browsers

## Getting Started

### Prerequisites

- Node.js 20+
- npm or yarn

### Installation

```bash
# Clone the repository
git clone https://github.com/salvium/salvium-vault.git
cd salvium-vault

# Install dependencies
npm install
```

### Development

```bash
# Start the development server
npm run dev

# Open http://localhost:3000/vault
```

### Production Build

```bash
# Build the React frontend
npm run build

# Start the production server
npm start
```

## Docker Deployment

```bash
# Build the Docker image
docker build -t salvium-vault .

# Run the container
docker run -p 3000:3000 salvium-vault
```

### Docker Compose

```yaml
version: '3.8'
services:
  salvium-vault:
    build: .
    ports:
      - "3000:3000"
    environment:
      - SALVIUM_RPC_URL=http://your-daemon:19081
    restart: unless-stopped
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `SALVIUM_RPC_URL` | Salvium daemon RPC endpoint | `http://salvium:19081` |
| `SALVIUM_RPC_USER` | RPC username (if authentication enabled) | - |
| `SALVIUM_RPC_PASS` | RPC password (if authentication enabled) | - |

## Architecture

```
salvium-vault/
├── components/        # React UI components
├── services/          # Business logic & API services
├── wallet/            # WebAssembly wallet core
├── server.cjs         # Express.js backend (RPC proxy)
└── wasm-build/        # WASM compilation source & tools
```

### Technology Stack

- **Frontend:** React 19, TypeScript, Tailwind CSS
- **Backend:** Express.js (API proxy for daemon RPC)
- **Wallet Core:** WebAssembly (compiled from Salvium C++ source)
- **Cryptography:** libsodium, OpenSSL (via WASM)

## WASM Build

The wallet's cryptographic core is compiled to WebAssembly from the Salvium C++ source code. Pre-built WASM files are included in the `/wallet` directory.

### Building WASM from Source

The WASM build requires Docker. Full build instructions and source code are available in the dedicated repository:

**WASM Build Repository:** [https://github.com/143Noodles/Salvium-WASM](https://github.com/143Noodles/Salvium-WASM)

To build locally:

```bash
cd wasm-build

# Windows (PowerShell)
.\build.ps1

# Linux/macOS
./build.sh

# Output files will be in wasm-build/output/
```

## Security

- **Client-Side Only** - All wallet operations happen in your browser
- **No Key Transmission** - Private keys and seed phrases are never sent to any server
- **Encrypted Storage** - Wallet data is encrypted with AES-256-GCM before storage
- **Memory Protection** - Sensitive data is wiped from memory after use
- **Open Source** - Full source code available for audit

### Security Considerations

- Always verify you're on the official site (https://vault.salvium.tools)
- Never share your seed phrase with anyone
- Use biometric unlock only on trusted devices
- Keep your browser and OS up to date

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Links

- [Salvium Website](https://salvium.io)
- [Salvium GitHub](https://github.com/salvium)
- [Live Wallet](https://vault.salvium.tools)

---

**Disclaimer:** This software is provided "as is" without warranty of any kind. Always backup your seed phrase and use at your own risk.
