import { defineConfig } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const port = 18766
export default defineConfig({
  testDir: './tests',
  outputDir: '../data/e2e-results',
  workers: 1,
  timeout: 90000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1512, height: 1080 },
    headless: true,
    launchOptions: { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  webServer: {
    command: `".venv/Scripts/python.exe" -m uvicorn backend.app:app --host 127.0.0.1 --port ${port} --no-access-log`,
    cwd: root,
    url: `http://127.0.0.1:${port}/api/health`,
    env: { CHARACTER_FORGE_PORT: String(port), CHARACTER_FORGE_DATA: path.join(root, 'data', 'e2e-runtime', Date.now().toString()) },
    reuseExistingServer: false,
    timeout: 20000,
  },
})
