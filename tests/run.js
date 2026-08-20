#!/usr/bin/env node
'use strict';

// Запускает тестовые страницы в headless-браузере и печатает их отчёт.
//
// Почему не «--dump-dom --virtual-time-budget»: виртуальное время Chrome
// перематывает таймеры, но не ждёт IndexedDB. Тест, который упирается в запись
// в базу без единого висящего таймера, обрывается на середине — страница просто
// не успевает доработать до дампа. Здесь вместо этого настоящее ожидание через
// протокол отладчика: ждём, пока страница сама объявит результат в <title>.
//
//   node tests/run.js                      — все страницы из СПИСКА ниже
//   node tests/run.js tests/tree-and-storage.html   — только указанные

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');

const PORT = Number(process.env.MDEDITOR_TEST_PORT || 8799);
const DEBUG_PORT = Number(process.env.MDEDITOR_DEBUG_PORT || 9333);
const ROOT = path.resolve(__dirname, '..');
const PAGE_TIMEOUT_MS = 120000;

const SUITE = [
  'tests/preview-sanitize-and-copy.html',
  'tests/preview-url-obfuscation.html',
  'tests/tree-and-storage.html',
  'tests/drop-folders.html',
  'tests/delete-and-undo.html',
  'tests/migration-legacy.html',
  'tests/multitab-sync.html',
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
};

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    'google-chrome', 'chromium', 'chromium-browser', 'google-chrome-stable',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const found = spawnSync('which', [candidate], { encoding: 'utf8' });
    if (found.status === 0) return found.stdout.trim();
  }
  return null;
}

function startServer() {
  const server = http.createServer((request, response) => {
    const url = decodeURIComponent((request.url || '/').split('?')[0]);
    const target = path.join(ROOT, url === '/' ? 'index.html' : url);
    if (!target.startsWith(ROOT) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': MIME[path.extname(target)] || 'application/octet-stream' });
    fs.createReadStream(target).pipe(response);
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

async function waitForDebugger() {
  for (let i = 0; i < 100; i += 1) {
    try {
      return await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('браузер не поднял порт отладки');
}

// Минимальный клиент протокола: нам хватает createTarget/attach/evaluate.
class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('не удалось подключиться к браузеру')), { once: true });
    });
    return new Cdp(socket);
  }

  send(method, params, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    this.socket.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

async function runPage(cdp, relativePath) {
  const url = `http://127.0.0.1:${PORT}/${relativePath}`;
  const { targetId } = await cdp.send('Target.createTarget', { url });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception
        ? result.exceptionDetails.exception.description
        : 'ошибка в странице');
    }
    return result.result.value;
  };

  const deadline = Date.now() + PAGE_TIMEOUT_MS;
  let title = '';
  while (Date.now() < deadline) {
    try {
      title = await evaluate('document.title');
      if (/^ALL-PASS$|^FAILURES-/.test(title)) break;
    } catch { /* страница ещё грузится */ }
    await new Promise((r) => setTimeout(r, 250));
  }

  let report = '';
  try {
    report = await evaluate("(document.getElementById('results')||{}).textContent || ''");
  } catch { /* страница умерла — отчёта не будет */ }

  await cdp.send('Target.closeTarget', { targetId });
  return { title, report, timedOut: !/^ALL-PASS$|^FAILURES-/.test(title) };
}

async function main() {
  const requested = process.argv.slice(2);
  const pages = requested.length > 0 ? requested : SUITE;

  const chromePath = findChrome();
  if (!chromePath) {
    console.error('Не найден Chrome/Chromium. Укажите путь в переменной CHROME_BIN.');
    process.exit(2);
  }

  const server = await startServer();
  const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mdeditor-test-'));
  const chrome = spawn(chromePath, [
    '--headless', '--disable-gpu', '--no-sandbox',
    '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let failures = 0;
  let cdp = null;
  try {
    const version = await waitForDebugger();
    cdp = await Cdp.connect(version.webSocketDebuggerUrl);

    for (const page of pages) {
      process.stdout.write(`\n=== ${page} ===\n`);
      const { title, report, timedOut } = await runPage(cdp, page);
      if (report) process.stdout.write(report.trimEnd() + '\n');
      if (timedOut) {
        console.log(`РЕЗУЛЬТАТ: не дождались отчёта за ${PAGE_TIMEOUT_MS / 1000} с (title: ${title || '—'})`);
        failures += 1;
      } else if (title === 'ALL-PASS') {
        console.log('РЕЗУЛЬТАТ: ALL-PASS');
      } else {
        console.log('РЕЗУЛЬТАТ: ' + title);
        failures += 1;
      }
    }
  } finally {
    if (cdp) { try { cdp.socket.close(); } catch { /* уже закрыт */ } }
    chrome.kill('SIGKILL');
    server.close();
    // Chrome может ещё дописывать профиль — уборка не должна ронять прогон
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch { /* временный каталог подберёт система */ }
  }

  console.log(`\n${failures === 0 ? 'ВСЕ СТРАНИЦЫ ПРОЙДЕНЫ' : 'ПРОВАЛЕНО СТРАНИЦ: ' + failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
