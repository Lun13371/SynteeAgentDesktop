<h1 align="center">electron-app</h1>

<p align="center">An Electron application with Vue3 and TypeScript</p>

<p align="center">
<img src="https://img.shields.io/github/package-json/dependency-version/alex8088/electron-vite-boilerplate/dev/electron" alt="electron-version">
<img src="https://img.shields.io/github/package-json/dependency-version/alex8088/electron-vite-boilerplate/dev/electron-vite" alt="electron-vite-version" />
<img src="https://img.shields.io/github/package-json/dependency-version/alex8088/electron-vite-boilerplate/dev/electron-builder" alt="electron-builder-version" />
<img src="https://img.shields.io/github/package-json/dependency-version/alex8088/electron-vite-boilerplate/dev/vite" alt="vite-version" />
<img src="https://img.shields.io/github/package-json/dependency-version/alex8088/electron-vite-boilerplate/dev/vue" alt="vue-version" />
<img src="https://img.shields.io/github/package-json/dependency-version/alex8088/electron-vite-boilerplate/dev/typescript" alt="typescript-version" />
</p>

<p align='center'>
<img src='./build/electron-vite-vue-ts.png'/>
</p>

## Features

- 💡 Optimize asset handling
- 🚀 Fast HMR for renderer processes
- 🔥 Hot reloading for main process and preload scripts
- 🔌 Easy to debug
- 🔒 Compile to v8 bytecode to protect source code

## Getting Started

Read [documentation](https://electron-vite.org/) for more details.

- [Configuring](https://electron-vite.org/config/)
- [Development](https://electron-vite.org/guide/dev.html)
- [Asset Handling](https://electron-vite.org/guide/assets.html)
- [HMR](https://electron-vite.org/guide/hmr.html) & [Hot Reloading](https://electron-vite.org/guide/hot-reloading.html)
- [Debugging](https://electron-vite.org/guide/debugging.html)
- [Source code protection](https://electron-vite.org/guide/source-code-protection.html)
- [Distribution](https://electron-vite.org/guide/distribution.html)
- [Troubleshooting](https://electron-vite.org/guide/troubleshooting.html)

You can also use the [create-electron](https://github.com/alex8088/quick-start/tree/master/packages/create-electron) tool to scaffold your project for other frameworks (e.g. `React`, `Svelte` or `Solid`).

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode) + [Volar](https://marketplace.visualstudio.com/items?itemName=Vue.volar) + [TypeScript Vue Plugin (Volar)](https://marketplace.visualstudio.com/items?itemName=Vue.vscode-typescript-vue-plugin)

## Project Setup

### Install

```bash
$ npm install
```

### Development

```bash
$ npm run dev
```

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux x86_64 (unpacked Electron app in dist/linux-unpacked)
$ npm run build:linux
```

### Arch Linux x86_64 package

From the checkout, install the dependencies listed in `packaging/arch/PKGBUILD`
and `base-devel`. Build as a regular user on Arch Linux.

```bash
npm ci
mkdir -p dist
(cd packaging/arch && PKGDEST="$PWD/../../dist" makepkg)
sudo pacman -U dist/syntee-helper-1.1.6-1-x86_64.pkg.tar.zst
```

The Linux port review, measured memory usage and remaining runtime checks are in
[docs/arch-review.md](docs/arch-review.md).
The 1.1.6 mini-agent, context and cost accounting fixes are described in
[docs/mini-agent-review.md](docs/mini-agent-review.md).

### Windows x64

Download and run the `Syntee-Helper-Setup-<version>-x64.exe` asset from a
`windows-v<version>` release in the [GitHub fork](https://github.com/zaxdevv/SynteeAgentDesktop/releases).
For future updates, open **Настройки → Обновления → Проверить обновления**.
Click **Скачать**, then run the downloaded installer over the existing
standalone installation. Chats and settings use `%APPDATA%\SynteeHelper`.
The standalone install has its own Start menu entry, **Syntee Helper Desktop**.
Exit any running Syntee instance before installing.

To build the standalone installer on Windows, install Node.js, Rust with the
MSVC toolchain and Visual Studio C++ Build Tools, then run:

```powershell
npm ci --ignore-scripts
npm run build:win:installer
```

Publish the generated installer from `dist/windows` using a
`windows-v<version>` tag matching the version in `package.json`. The app only
discovers Windows releases with the matching installer asset. The launcher
ZIP remains available through `npm run build:win` and uses the Syntee Gateway.

## Examples

- [electron-vite-bytecode-example](https://github.com/alex8088/electron-vite-bytecode-example), source code protection
- [electron-vite-decorator-example](https://github.com/alex8088/electron-vite-decorator-example), typescipt decorator
- [electron-vite-worker-example](https://github.com/alex8088/electron-vite-worker-example), worker and fork
