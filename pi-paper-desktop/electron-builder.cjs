const nsisUninstallDiagnostics = process.env.VIBEPAPER_NSIS_UNINSTALL_DIAGNOSTICS_TEST_ONLY === '1'
const nsisUninstallInclude = nsisUninstallDiagnostics ? 'uninstall-diagnostics.nsh' : 'uninstall-cleanup.nsh'

module.exports = {
  appId: 'com.vibepaper.desktop',
  productName: 'Pi-Paper',
  directories: { app: 'dist/app', output: 'release', buildResources: 'assets' },
  // Utility processes load the same standalone CJS modules as the development host.
  asar: false,
  npmRebuild: false,
  // MCP clients and packaged smoke checks start this binary in Node mode.
  electronFuses: { runAsNode: true },
  files: [
    'package.json', 'src/**/*.cjs',
    'dist/agent-worker.cjs', 'dist/pi-official-media.cjs',
    'dist/mcp-launcher.cjs', 'dist/mcp-stdio.cjs',
    'renderer/**/*', 'assets/app-icon.*',
  ],
  artifactName: 'Pi-Paper-${version}-${os}-${arch}.${ext}',
  publish: null,
  toolsets: { appimage: '1.0.3' },
  win: {
    icon: 'assets/app-icon.ico',
    target: [{ target: 'nsis', arch: ['x64'] }],
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Pi-Paper',
    deleteAppDataOnUninstall: false,
    include: nsisUninstallInclude,
  },
  mac: {
    icon: 'assets/app-icon.icns',
    category: 'public.app-category.productivity',
    target: ['dmg', 'zip'],
    identity: '-',
  },
  linux: {
    icon: 'assets/app-icon.png',
    category: 'Graphics',
    executableName: 'pi-paper',
    target: [{ target: 'AppImage', arch: ['x64'] }, { target: 'deb', arch: ['x64'] }],
    maintainer: 'Pi-Paper Contributors',
  },
}
