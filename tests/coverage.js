#!/usr/bin/env node
'use strict';

// Показывает, какие места js/app.js ни один тест ни разу не выполнил.
//
// Имена функций в тестах искать бессмысленно: тесты работают через интерфейс,
// а весь код спрятан в IIFE. Поэтому берём точное покрытие у самого движка —
// Profiler из протокола отладчика считает, сколько раз выполнялся каждый участок.
//
//   node tests/coverage.js                       — по всему набору
//   node tests/coverage.js tests/navigation.html — только по указанным страницам

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');

const PORT = Number(process.env.MDEDITOR_TEST_PORT || 8791);
const DEBUG_PORT = Number(process.env.MDEDITOR_DEBUG_PORT || 9341);
const ROOT = path.resolve(__dirname, '..');
const PAGE_TIMEOUT_MS = 180000;
const TARGET = '/js/app.js';

const SUITE = require('./suite.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
};

function findChrome() {
  for (const candidate of [process.env.CHROME_BIN, 'google-chrome', 'chromium', 'chromium-browser'].filter(Boolean)) {
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
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

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
      socket.addEventListener('error', () => reject(new Error('нет связи с браузером')), { once: true });
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

async function collectFromPage(cdp, relativePath) {
  const url = `http://127.0.0.1:${PORT}/${relativePath}`;
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  await cdp.send('Profiler.enable', {}, sessionId);
  await cdp.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true }, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);

  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true }, sessionId);
    return result.exceptionDetails ? null : result.result.value;
  };

  const deadline = Date.now() + PAGE_TIMEOUT_MS;
  let title = '';
  while (Date.now() < deadline) {
    title = (await evaluate('document.title').catch(() => '')) || '';
    if (/^ALL-PASS$|^FAILURES-/.test(title)) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const { result } = await cdp.send('Profiler.takePreciseCoverage', {}, sessionId);
  await cdp.send('Target.closeTarget', { targetId });
  return { title, scripts: result.filter((s) => s.url.endsWith(TARGET)) };
}

// Объединяем покрытие всех страниц: участок считается пройденным, если хотя бы
// на одной странице счётчик больше нуля.
function mergeCoverage(pages) {
  const functions = new Map();
  for (const page of pages) {
    for (const script of page.scripts) {
      for (const fn of script.functions) {
        const root = fn.ranges[0];
        const key = `${root.startOffset}:${root.endOffset}`;
        const previous = functions.get(key);
        const covered = root.count > 0;
        if (!previous) {
          functions.set(key, {
            name: fn.functionName || '(без имени)',
            start: root.startOffset,
            end: root.endOffset,
            covered,
            innerGaps: covered ? fn.ranges.filter((r) => r.count === 0) : [],
          });
        } else {
          previous.covered = previous.covered || covered;
          if (covered && previous.innerGaps.length > 0) {
            const gaps = fn.ranges.filter((r) => r.count === 0);
            previous.innerGaps = previous.innerGaps.filter((old) =>
              gaps.some((g) => g.startOffset === old.startOffset && g.endOffset === old.endOffset));
          }
        }
      }
    }
  }
  return functions;
}

function lineOf(source, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

async function main() {
  const requested = process.argv.slice(2);
  const pages = requested.length > 0 ? requested : SUITE;

  const chromePath = findChrome();
  if (!chromePath) {
    console.error('Не найден Chrome/Chromium. Укажите путь в CHROME_BIN.');
    process.exit(2);
  }

  const source = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  const server = await startServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mdeditor-cov-'));
  const chrome = spawn(chromePath, [
    '--headless', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });

  let cdp = null;
  try {
    let version = null;
    for (let i = 0; i < 100 && !version; i += 1) {
      try { version = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`); }
      catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    cdp = await Cdp.connect(version.webSocketDebuggerUrl);

    const collected = [];
    for (const page of pages) {
      process.stdout.write(`собираю: ${page} … `);
      const result = await collectFromPage(cdp, page);
      process.stdout.write(`${result.title || 'без отчёта'}\n`);
      collected.push(result);
    }

    const functions = mergeCoverage(collected);
    const all = Array.from(functions.values()).sort((a, b) => a.start - b.start);
    const uncovered = all.filter((f) => !f.covered);
    const covered = all.filter((f) => f.covered);

    console.log('\n================ НЕ ВЫПОЛНЯЛОСЬ НИ РАЗУ ================');
    if (uncovered.length === 0) {
      console.log('нет — каждая функция хотя бы раз выполнилась');
    } else {
      for (const fn of uncovered) {
        console.log(`  строка ${String(lineOf(source, fn.start)).padStart(4)}  ${fn.name}`);
      }
    }

    const withGaps = covered.filter((f) => f.innerGaps.length > 0);
    console.log('\n========= ВЕТКИ ВНУТРИ ВЫПОЛНЕННЫХ ФУНКЦИЙ ==========');
    if (withGaps.length === 0) {
      console.log('нет непройденных ветвей');
    } else {
      for (const fn of withGaps.slice(0, 40)) {
        const lines = fn.innerGaps.map((g) => lineOf(source, g.startOffset));
        console.log(`  ${fn.name || '(без имени)'} — строки ${[...new Set(lines)].join(', ')}`);
      }
      if (withGaps.length > 40) console.log(`  … и ещё ${withGaps.length - 40}`);
    }

    console.log('\n================== ИТОГ ==================');
    console.log(`функций всего: ${all.length}`);
    console.log(`выполнялось:   ${covered.length}`);
    console.log(`не тронуто:    ${uncovered.length}`);
    console.log(`покрытие:      ${Math.round((covered.length / all.length) * 100)}%`);
  } finally {
    if (cdp) { try { cdp.socket.close(); } catch { /* уже закрыт */ } }
    chrome.kill('SIGKILL');
    server.close();
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch { /* временный каталог подберёт система */ }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
