import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

const screens = [
  'register',
  'login',
  'home-dashboard',
  'plan-create-chat',
  'plan-list',
  'plan-detail',
  'tasks-today',
  'checkin',
  'checkin-success',
  'reminder-settings',
  'reminder-popup',
  'weekly-report',
  'profile',
]

export default defineConfig({
  base: './',
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  plugins: [react(), emitManualHtml()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, '../docs/screenshots'),
    emptyOutDir: false,
    cssCodeSplit: false,
    lib: {
      entry: path.resolve(__dirname, './src/manual/main.tsx'),
      formats: ['iife'],
      name: 'StudyBuddyManualScreenshots',
      fileName: () => 'assets/manual-screenshots.js',
    },
    rollupOptions: {
      output: {
        assetFileNames: (assetInfo) =>
          assetInfo.name?.endsWith('.css')
            ? 'assets/manual-screenshots.css'
            : 'assets/[name][extname]',
      },
    },
  },
})

function emitManualHtml() {
  return {
    name: 'emit-manual-screenshot-html',
    generateBundle(this: { emitFile: (file: { type: 'asset'; fileName: string; source: string }) => void }) {
      for (const name of screens) {
        this.emitFile({
          type: 'asset',
          fileName: `manual-screenshots/${name}.html`,
          source: `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${titleFor(name)} - 小搭</title>
    <link rel="stylesheet" href="../assets/manual-screenshots.css" />
  </head>
  <body data-scene="${name}">
    <div id="root"></div>
    <script src="../assets/manual-screenshots.js"></script>
  </body>
</html>
`,
        })
      }
    },
  }
}

function titleFor(name: string) {
  const titles: Record<string, string> = {
    register: '注册页面',
    login: '登录页面',
    'home-dashboard': '首页概览',
    'plan-create-chat': '创建备考计划',
    'plan-list': '备考计划列表',
    'plan-detail': '备考计划详情',
    'tasks-today': '今日任务',
    checkin: '每日打卡',
    'checkin-success': '打卡成功',
    'reminder-settings': '提醒设置',
    'reminder-popup': '实时提醒弹窗',
    'weekly-report': '学习周报',
    profile: '个人中心',
  }
  return titles[name] || '页面截图'
}
