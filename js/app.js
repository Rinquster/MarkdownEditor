(() => {
  'use strict';

  // ---------- Константы ----------

  const DB_NAME = 'mdeditor';
  const DB_VERSION = 2;
  const STORE_FILES = 'files';     // одна запись на файл
  const STORE_META = 'meta';       // дерево папок, текущий файл, справка
  const META_KEY = 'meta';
  const LEGACY_STORE = 'workspace'; // монолит схемы v1/v2 — только чтение при миграции
  const LEGACY_STATE_KEY = 'state';
  const SCHEMA_VERSION = 3;
  const SETTINGS_KEY = 'mdeditor-settings';
  const EMERGENCY_KEY = 'mdeditor-emergency';
  const SYNC_CHANNEL = 'mdeditor-sync';
  const AUTOSAVE_DELAY_MS = 450;
  const UNDO_WINDOW_MS = 12000;   // сколько висит предложение отменить удаление
  const ROOT_ID = null;            // parentId корневых узлов
  const READ_BATCH = 12;           // сколько файлов читаем с диска одновременно
  const BULK_DROP_ASK = 400;       // выше этого числа файлов спрашиваем подтверждение
  const DND_TYPE = 'application/x-mdeditor-node';

  const WELCOME_ID = '__welcome__';
  const WELCOME_NAME = 'добро-пожаловать.md';

  const PREVIEW_SIZE_MIN = 12;
  const PREVIEW_SIZE_MAX = 28;
  const EDITOR_SIZE_MIN = 10;
  const EDITOR_SIZE_MAX = 24;
  const SIDEBAR_MIN = 210;
  const SIDEBAR_MAX = 520;

  const FONT_STACKS = {
    'Lato': "'Lato', 'Segoe UI', system-ui, sans-serif",
    'Inter': "'Inter', 'Segoe UI', system-ui, sans-serif",
    'Roboto': "'Roboto', 'Segoe UI', system-ui, sans-serif",
    'Whitney': "'Whitney', 'Segoe UI', system-ui, sans-serif",
    'Antiqua': "'Antiqua', Georgia, serif",
    'Liberation Sans': "'Liberation Sans', Arial, sans-serif",
    'Liberation Serif': "'Liberation Serif', 'Times New Roman', serif",
  };

  const DEFAULT_SETTINGS = {
    mode: 'preview',
    previewFont: 'Lato',
    previewSize: 17,
    editorSize: 14,
    sidebarWidth: 280,
  };

  // ---------- Элементы ----------

  const el = (id) => document.getElementById(id);

  const modePreviewButton = el('mode-preview-button');
  const modeEditorButton = el('mode-editor-button');
  const previewFontSelect = el('preview-font-select');
  const previewSizeDec = el('preview-size-dec');
  const previewSizeInc = el('preview-size-inc');
  const previewSizeValue = el('preview-size-value');
  const editorSizeDec = el('editor-size-dec');
  const editorSizeInc = el('editor-size-inc');
  const editorSizeValue = el('editor-size-value');
  const copyDocButton = el('copy-doc-button');
  const downloadZipButton = el('download-zip-button');
  const newFileButton = el('new-file-button');
  const newFolderButton = el('new-folder-button');
  const deleteAllButton = el('delete-all-button');
  const uploadButton = el('upload-button');
  const uploadInput = el('upload-input');
  const sidebar = el('sidebar');
  const sidebarResizer = el('sidebar-resizer');
  const fileListEl = el('file-list');
  const statusLine = el('status-line');
  const previewPane = el('preview-pane');
  const previewBody = el('preview-body');
  const editorPane = el('editor-pane');
  const editorEl = el('editor');
  const welcomePane = el('welcome-pane');
  const contextMenu = el('file-context-menu');
  const dialogOverlay = el('dialog-overlay');
  const dialogMessage = el('dialog-message');
  const dialogButtons = el('dialog-buttons');

  // ---------- Состояние ----------

  // Дерево хранится узлами с parentId, а не путями-строками. Переименование папки и
  // перенос файла — это смена одного поля; путь вычисляется обходом вверх только там,
  // где он действительно нужен (ZIP, подсказки). В модели «путь строкой» каждое
  // переименование папки означало бы перезапись путей всех вложенных файлов.
  let files = [];   // [{id, type:'file', name, parentId, content, updatedAt}]
  let folders = []; // [{id, type:'folder', name, parentId}]
  let welcomeFile = null; // призрачный файл-справка; null — удалён и больше не появится
  let currentId = null;
  let expandedFolders = new Set(); // id раскрытых папок
  let activeParentId = ROOT_ID;    // куда попадут новые файл и папка
  let draggedNodeId = null;        // узел, который сейчас тащат внутри списка
  let dropHighlightRow = null;
  let lastDeletion = null;         // снимок последнего удаления для отмены
  let undoTimer = null;
  let settings = { ...DEFAULT_SETTINGS };
  let renameState = null; // {id, initial} — узел, чьё имя сейчас редактируется inline
  let autosaveTimer = null;
  let statusTimer = null;
  let writeQueue = Promise.resolve();

  // что именно нужно дописать в хранилище — вместо перезаписи всего воркспейса
  let dirtyFileIds = new Set();
  let removedFileIds = new Set();
  let metaDirty = false;

  // отличает записи этой вкладки от чужих в BroadcastChannel
  const TAB_ID = Math.random().toString(36).slice(2, 10);

  // ---------- Утилиты ----------

  function uid() {
    return (crypto.randomUUID && crypto.randomUUID()) ||
      'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function fileById(id) {
    if (welcomeFile && id === WELCOME_ID) return welcomeFile;
    return files.find((f) => f.id === id) || null;
  }

  function folderById(id) {
    return folders.find((f) => f.id === id) || null;
  }

  function nodeById(id) {
    return fileById(id) || folderById(id);
  }

  // «заметка.md» → {stem: 'заметка', ext: '.md'}; имя без точки целиком уходит в stem
  function splitName(name) {
    const dot = name.lastIndexOf('.');
    return dot > 0
      ? { stem: name.slice(0, dot), ext: name.slice(dot) }
      : { stem: name, ext: '' };
  }

  function compareNames(a, b) {
    return a.localeCompare(b, 'ru', { numeric: true, sensitivity: 'base' });
  }

  // содержимое одного узла: папки выше файлов, внутри группы — по имени
  function childrenOf(parentId) {
    const result = [];
    for (const folder of folders) if (folder.parentId === parentId) result.push(folder);
    for (const file of files) if (file.parentId === parentId) result.push(file);
    return result.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return compareNames(a.name, b.name);
    });
  }

  // все файлы в порядке обхода дерева — для ZIP и для выбора «первого» файла
  function flattenFiles(parentId = ROOT_ID, out = []) {
    for (const node of childrenOf(parentId)) {
      if (node.type === 'folder') flattenFiles(node.id, out);
      else out.push(node);
    }
    return out;
  }

  function nodeByNameIn(parentId, name, type) {
    const pool = type === 'folder' ? folders : files;
    return pool.find((n) => n.parentId === parentId && n.name === name) || null;
  }

  // Имена уникальны в пределах одной папки, а не всего воркспейса: два «index.md»
  // в разных главах — это норма, а не конфликт.
  function uniqueNameIn(parentId, base, type) {
    if (!nodeByNameIn(parentId, base, type)) return base;
    const { stem, ext } = type === 'folder' ? { stem: base, ext: '' } : splitName(base);
    let n = 2;
    while (nodeByNameIn(parentId, `${stem}-${n}${ext}`, type)) n += 1;
    return `${stem}-${n}${ext}`;
  }

  function pathOf(node) {
    const parts = [node.name];
    let parentId = node.parentId;
    // счётчик на случай испорченного дерева с петлёй — лучше обрезать, чем зависнуть
    for (let guard = 0; parentId && guard < 200; guard += 1) {
      const folder = folderById(parentId);
      if (!folder) break;
      parts.unshift(folder.name);
      parentId = folder.parentId;
    }
    return parts.join('/');
  }

  // лежит ли узел внутри папки (на любой глубине) — запрещает уронить папку в себя
  function isInsideFolder(nodeId, folderId) {
    let cursor = nodeById(nodeId);
    for (let guard = 0; cursor && guard < 200; guard += 1) {
      if (cursor.parentId === folderId) return true;
      cursor = cursor.parentId ? folderById(cursor.parentId) : null;
    }
    return false;
  }

  function collectSubtree(folderId, acc) {
    const out = acc || { files: [], folders: [] };
    for (const child of childrenOf(folderId)) {
      if (child.type === 'folder') {
        out.folders.push(child);
        collectSubtree(child.id, out);
      } else {
        out.files.push(child);
      }
    }
    return out;
  }

  function nowStamp() {
    return new Date().toISOString();
  }

  // Статусная строка умеет нести кнопку действия — на ней держится отмена удаления.
  function renderStatus(text, action) {
    statusLine.replaceChildren();
    const label = document.createElement('span');
    label.className = 'status-text';
    label.textContent = text;
    statusLine.appendChild(label);
    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'status-action';
      button.textContent = action.label;
      button.addEventListener('click', action.run);
      statusLine.appendChild(button);
    }
  }

  function setStatus(text, sticky = false) {
    renderStatus(text);
    window.clearTimeout(statusTimer);
    if (!sticky) {
      statusTimer = window.setTimeout(() => {
        renderStatus('Файлы хранятся в вашем браузере');
      }, 4000);
    }
  }

  function setStatusWithUndo(text) {
    renderStatus(text, { label: 'Отменить', run: undoLastDeletion });
    window.clearTimeout(statusTimer);
    statusTimer = window.setTimeout(() => {
      renderStatus('Файлы хранятся в вашем браузере');
    }, UNDO_WINDOW_MS);
  }

  // ---------- Буфер обмена ----------

  // navigator.clipboard живёт только в защищённом контексте: при открытии страницы
  // как file:// его в части браузеров нет, и при отказе в разрешении он тоже бросает.
  // Запасной путь — скрытая textarea: execCommand устарел, но замены для этого случая нет.
  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch { /* отказано или недоступно — пробуем запасной путь */ }
    }
    return copyViaTextarea(text);
  }

  function copyViaTextarea(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.appendChild(area);
    area.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { copied = false; }
    area.remove();
    return copied;
  }

  // ---------- Настройки (localStorage) ----------

  function loadSettings() {
    try {
      const raw = window.localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        settings = { ...DEFAULT_SETTINGS, ...parsed };
      }
    } catch { /* повреждённые настройки — остаёмся на дефолтах */ }
    if (!FONT_STACKS[settings.previewFont]) settings.previewFont = DEFAULT_SETTINGS.previewFont;
    settings.previewSize = clamp(settings.previewSize, PREVIEW_SIZE_MIN, PREVIEW_SIZE_MAX);
    settings.editorSize = clamp(settings.editorSize, EDITOR_SIZE_MIN, EDITOR_SIZE_MAX);
    settings.sidebarWidth = clamp(settings.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX);
    if (settings.mode !== 'editor') settings.mode = 'preview';
  }

  function saveSettings() {
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch { /* private mode и т.п. — работаем без сохранения */ }
  }

  function clamp(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  function applySettings() {
    const root = document.documentElement;
    root.style.setProperty('--preview-font', FONT_STACKS[settings.previewFont]);
    root.style.setProperty('--preview-size', settings.previewSize + 'px');
    root.style.setProperty('--editor-size', settings.editorSize + 'px');
    root.style.setProperty('--sidebar-width', settings.sidebarWidth + 'px');
    previewSizeValue.textContent = String(settings.previewSize);
    editorSizeValue.textContent = String(settings.editorSize);
    previewFontSelect.value = settings.previewFont;
    modePreviewButton.setAttribute('aria-pressed', String(settings.mode === 'preview'));
    modeEditorButton.setAttribute('aria-pressed', String(settings.mode === 'editor'));
    renderMain();
  }

  // ---------- Хранилище (IndexedDB) ----------

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('IndexedDB недоступен')); return; }
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);
      request.addEventListener('upgradeneeded', () => {
        const db = request.result;
        // старый монолитный store не удаляем: из него читает миграция на схему v3
        if (!db.objectStoreNames.contains(LEGACY_STORE)) db.createObjectStore(LEGACY_STORE);
        if (!db.objectStoreNames.contains(STORE_FILES)) db.createObjectStore(STORE_FILES, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
      });
      request.addEventListener('success', () => resolve(request.result));
      request.addEventListener('error', () => reject(request.error || new Error('IndexedDB open failed')));
    });
  }

  function idbRequest(request) {
    return new Promise((resolve, reject) => {
      request.addEventListener('success', () => resolve(request.result));
      request.addEventListener('error', () => reject(request.error || new Error('IndexedDB request failed')));
    });
  }

  function txDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.addEventListener('complete', () => resolve());
      transaction.addEventListener('abort', () => reject(transaction.error || new Error('IndexedDB tx aborted')));
      transaction.addEventListener('error', () => reject(transaction.error || new Error('IndexedDB tx failed')));
    });
  }

  // Соединение держим открытым всё время жизни страницы: так запись на
  // pagehide успевает создать транзакцию до выгрузки (браузер дописывает
  // уже начатые транзакции, но не ждёт незавершённого open()).
  let dbPromise = null;

  function getDb() {
    if (!dbPromise) {
      dbPromise = openDb().catch((error) => {
        dbPromise = null;
        throw error;
      });
    }
    return dbPromise;
  }

  async function readMeta() {
    const db = await getDb();
    return idbRequest(db.transaction(STORE_META, 'readonly').objectStore(STORE_META).get(META_KEY));
  }

  async function readAllFiles() {
    const db = await getDb();
    return idbRequest(db.transaction(STORE_FILES, 'readonly').objectStore(STORE_FILES).getAll());
  }

  async function readLegacyState() {
    const db = await getDb();
    if (!db.objectStoreNames.contains(LEGACY_STORE)) return null;
    return idbRequest(db.transaction(LEGACY_STORE, 'readonly').objectStore(LEGACY_STORE).get(LEGACY_STATE_KEY));
  }

  async function dropLegacyState() {
    const db = await getDb();
    if (!db.objectStoreNames.contains(LEGACY_STORE)) return;
    const transaction = db.transaction(LEGACY_STORE, 'readwrite');
    const done = txDone(transaction);
    transaction.objectStore(LEGACY_STORE).delete(LEGACY_STATE_KEY);
    await done;
  }

  function serializeFile(file) {
    return {
      id: file.id,
      name: file.name,
      parentId: file.parentId,
      content: file.content,
      updatedAt: file.updatedAt,
    };
  }

  function serializeMeta() {
    return {
      version: SCHEMA_VERSION,
      currentId,
      folders: folders.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId })),
      expanded: Array.from(expandedFolders),
      welcome: welcomeFile
        ? { content: welcomeFile.content, updatedAt: welcomeFile.updatedAt }
        : null,
      savedAt: nowStamp(),
      writer: TAB_ID,
    };
  }

  // Пишем только изменившееся. Прежняя схема укладывала весь воркспейс одной записью:
  // при сотне файлов это были мегабайты на каждое срабатывание дебаунса, причём даже
  // от простого клика по файлу в списке.
  async function writeChanges(fileIds, removedIds, withMeta) {
    const db = await getDb();
    const stores = [];
    const touchesFiles = fileIds.length > 0 || removedIds.length > 0;
    if (touchesFiles) stores.push(STORE_FILES);
    if (withMeta) stores.push(STORE_META);
    if (stores.length === 0) return;

    const transaction = db.transaction(stores, 'readwrite');
    const done = txDone(transaction);
    if (touchesFiles) {
      const store = transaction.objectStore(STORE_FILES);
      for (const id of removedIds) store.delete(id);
      for (const id of fileIds) {
        const file = files.find((f) => f.id === id);
        if (file) store.put(serializeFile(file));
      }
    }
    if (withMeta) transaction.objectStore(STORE_META).put(serializeMeta(), META_KEY);
    await done;
  }

  function enqueueWrite(task) {
    const result = writeQueue.then(task, task);
    writeQueue = result.catch(() => {});
    return result;
  }

  // Справка живёт в метаданных, а не в store файлов — её правки помечают meta.
  function markDirty(id) {
    if (id === WELCOME_ID) { metaDirty = true; return; }
    removedFileIds.delete(id); // возвращённый отменой файл больше не удаляется
    dirtyFileIds.add(id);
  }

  function markMetaDirty() {
    metaDirty = true;
  }

  function markRemoved(id) {
    dirtyFileIds.delete(id);
    if (id !== WELCOME_ID) removedFileIds.add(id);
    metaDirty = true;
  }

  function scheduleAutosave() {
    window.clearTimeout(autosaveTimer);
    autosaveTimer = window.setTimeout(() => { void persistNow(); }, AUTOSAVE_DELAY_MS);
  }

  function persistNow() {
    window.clearTimeout(autosaveTimer);
    const fileIds = Array.from(dirtyFileIds);
    const removed = Array.from(removedFileIds);
    const withMeta = metaDirty;
    dirtyFileIds = new Set();
    removedFileIds = new Set();
    metaDirty = false;
    if (fileIds.length === 0 && removed.length === 0 && !withMeta) return Promise.resolve();

    return enqueueWrite(() => writeChanges(fileIds, removed, withMeta))
      .then(() => { announceChange(); })
      .catch((error) => {
        console.error(error);
        // запись не удалась — возвращаем пометки, чтобы не потерять правки
        for (const id of fileIds) dirtyFileIds.add(id);
        for (const id of removed) removedFileIds.add(id);
        if (withMeta) metaDirty = true;
        setStatus('Не удалось сохранить в браузере', true);
      });
  }

  // ---------- Рендер списка файлов ----------

  const ICON_PATHS = {
    file: ['M4 1.75C4 1.34 4.34 1 4.75 1h5.09c.2 0 .39.08.53.22l2.41 2.41c.14.14.22.33.22.53v10.09c0 .41-.34.75-.75.75h-7.5A.75.75 0 0 1 4 14.25V1.75Zm1.5.75v11h6v-8.5H9.75A.75.75 0 0 1 9 4.25V2.5H5.5Z'],
    menu: ['M8 4.6a1.1 1.1 0 1 1 0-2.2 1.1 1.1 0 0 1 0 2.2Zm0 4.5a1.1 1.1 0 1 1 0-2.2 1.1 1.1 0 0 1 0 2.2Zm0 4.5a1.1 1.1 0 1 1 0-2.2 1.1 1.1 0 0 1 0 2.2Z'],
    info: ['M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13Zm0 1.5a5 5 0 1 0 0 10A5 5 0 0 0 8 3Zm0 3.7c.41 0 .75.34.75.75v3.05a.75.75 0 0 1-1.5 0V7.95c0-.41.34-.75.75-.75Zm0-2.3a.95.95 0 1 1 0 1.9.95.95 0 0 1 0-1.9Z'],
    copy: [
      'M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z',
      'M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z',
    ],
    check: ['M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 1 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z'],
    folder: ['M2 4.75C2 4.34 2.34 4 2.75 4h3.5l1.5 1.5h5.5c.41 0 .75.34.75.75v6.5c0 .41-.34.75-.75.75H2.75a.75.75 0 0 1-.75-.75V4.75Z'],
    chevron: ['M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 1 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z'],
  };

  function createIcon(name, size = 15) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ICON_PATHS[name] || ICON_PATHS.file) {
      const path = document.createElementNS(svgNS, 'path');
      path.setAttribute('fill', 'currentColor');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  }

  // Отступ вложенности задаём паддингом на плоском списке строк, а не вложенными
  // контейнерами: так строка остаётся цельной мишенью для клика и для дропа.
  function indentFor(depth) {
    return (10 + depth * 14) + 'px';
  }

  function createNodeRow(node, depth, ghost) {
    const isDir = node.type === 'folder';
    const open = isDir && expandedFolders.has(node.id);

    const row = document.createElement('div');
    row.className = 'file-row'
      + (ghost ? ' ghost' : '')
      + (isDir ? ' folder' : '')
      + (node.id === currentId ? ' active' : '');
    row.dataset.nodeId = node.id;
    row.dataset.nodeType = ghost ? 'ghost' : node.type;

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'file-main-button';
    main.title = ghost ? node.name : pathOf(node);
    main.style.paddingLeft = indentFor(depth);

    // Стрелку рисуем только у папок, но место под неё занимают и файлы:
    // иначе на одной глубине иконки файлов и папок не совпадают по вертикали.
    const twisty = document.createElement('span');
    twisty.className = 'file-twisty' + (isDir ? (open ? ' open' : '') : ' empty');
    if (isDir) twisty.appendChild(createIcon('chevron', 11));
    main.appendChild(twisty);

    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.appendChild(createIcon(ghost ? 'info' : (isDir ? 'folder' : 'file')));

    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = node.name;

    main.append(icon, name);
    main.addEventListener('click', () => {
      if (isDir) toggleFolder(node.id);
      else openFile(node.id);
    });

    const menu = document.createElement('button');
    menu.type = 'button';
    menu.className = 'file-menu-button';
    menu.title = isDir ? 'Действия с папкой' : 'Действия с файлом';
    menu.appendChild(createIcon('menu'));
    menu.addEventListener('click', (event) => {
      event.stopPropagation();
      const rect = menu.getBoundingClientRect();
      openNodeContextMenu(node, ghost, rect.right + 4, rect.top);
    });

    row.append(main, menu);
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      openNodeContextMenu(node, ghost, event.clientX, event.clientY);
    });
    if (!ghost) makeRowDraggable(row, node);
    return row;
  }

  function createRenameRow(node, depth) {
    const row = document.createElement('div');
    row.className = 'file-row'
      + (node.type === 'folder' ? ' folder' : '')
      + (node.id === currentId ? ' active' : '');
    const holder = document.createElement('div');
    holder.className = 'file-rename-holder';
    holder.style.paddingLeft = indentFor(depth);
    holder.appendChild(createInlineNameEditor(node));
    row.appendChild(holder);
    return row;
  }

  function renderBranch(parentId, depth, host) {
    for (const node of childrenOf(parentId)) {
      if (renameState && renameState.id === node.id) {
        host.appendChild(createRenameRow(node, depth));
      } else {
        host.appendChild(createNodeRow(node, depth, false));
      }
      if (node.type === 'folder' && expandedFolders.has(node.id)) {
        renderBranch(node.id, depth + 1, host);
      }
    }
  }

  function renderFiles() {
    closeContextMenu();
    fileListEl.replaceChildren();

    // раздел справки: единственный призрачный файл над основным списком
    if (welcomeFile) {
      fileListEl.appendChild(createNodeRow(welcomeFile, 0, true));
      const separator = document.createElement('hr');
      separator.className = 'file-section-sep';
      fileListEl.appendChild(separator);
    }

    if (files.length === 0 && folders.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'drop-hint';
      hint.innerHTML = 'Перетащите сюда<br><strong>.md-файлы или папки</strong><br>или нажмите, чтобы выбрать';
      hint.addEventListener('click', () => uploadInput.click());
      fileListEl.appendChild(hint);
      return;
    }

    renderBranch(ROOT_ID, 0, fileListEl);
  }

  function createInlineNameEditor(node) {
    const input = document.createElement('input');
    input.className = 'file-name-input';
    input.value = renameState.initial;
    input.spellcheck = false;

    const isValid = (value) => {
      const trimmed = value.trim();
      if (!trimmed) return false;
      // слэш превратил бы имя в подобие пути, которого в этой модели нет
      if (trimmed.includes('/') || trimmed.includes('\\')) return false;
      const existing = nodeByNameIn(node.parentId, trimmed, node.type);
      return !existing || existing.id === node.id;
    };

    let finished = false;
    const commit = () => {
      if (finished) return;
      const trimmed = input.value.trim();
      if (!isValid(trimmed)) { cancel(); return; }
      finished = true;
      renameState = null;
      if (trimmed !== node.name) {
        node.name = trimmed;
        if (node.type === 'file') {
          node.updatedAt = nowStamp();
          markDirty(node.id);
        }
        markMetaDirty();
        void persistNow();
      }
      renderFiles();
    };
    const cancel = () => {
      if (finished) return;
      finished = true;
      renameState = null;
      renderFiles();
    };

    input.addEventListener('input', () => {
      input.classList.toggle('invalid', !isValid(input.value));
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); commit(); }
      if (event.key === 'Escape') { event.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', commit);

    window.setTimeout(() => {
      input.focus();
      const dot = node.type === 'folder' ? -1 : input.value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
    }, 0);

    return input;
  }

  function startRename(id) {
    const node = nodeById(id);
    if (!node || id === WELCOME_ID) return;
    renameState = { id, initial: node.name };
    renderFiles();
  }

  function toggleFolder(id) {
    if (expandedFolders.has(id)) expandedFolders.delete(id);
    else expandedFolders.add(id);
    activeParentId = id;
    markMetaDirty();
    renderFiles();
    scheduleAutosave();
  }

  // ---------- Контекстное меню ----------

  function openNodeContextMenu(node, ghost, left, top) {
    let actions;
    if (ghost) {
      actions = [
        ['Скачать', () => downloadFile(node.id), ''],
        ['—', null, ''],
        ['Удалить', () => confirmDelete(node.id), 'danger'],
      ];
    } else if (node.type === 'folder') {
      actions = [
        ['Новый файл здесь', () => createFile(node.id), ''],
        ['Новая папка здесь', () => createFolder(node.id), ''],
        ['—', null, ''],
        ['Переименовать', () => startRename(node.id), ''],
        ['Скачать папку в ZIP', () => { void downloadFolderZip(node.id); }, ''],
        ['—', null, ''],
        ['Удалить папку', () => confirmDelete(node.id), 'danger'],
      ];
    } else {
      actions = [
        ['Переименовать', () => startRename(node.id), ''],
        ['Дублировать', () => duplicateFile(node.id), ''],
        ['Скачать', () => downloadFile(node.id), ''],
        ['—', null, ''],
        ['Удалить', () => confirmDelete(node.id), 'danger'],
      ];
    }

    contextMenu.replaceChildren();
    for (const [label, handler, kind] of actions) {
      if (label === '—') {
        contextMenu.appendChild(document.createElement('hr'));
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      if (kind) button.className = kind;
      button.addEventListener('click', () => {
        closeContextMenu();
        handler();
      });
      contextMenu.appendChild(button);
    }
    contextMenu.hidden = false;
    const rect = contextMenu.getBoundingClientRect();
    const clampedLeft = Math.min(left, window.innerWidth - rect.width - 8);
    const clampedTop = Math.min(top, window.innerHeight - rect.height - 8);
    contextMenu.style.left = Math.max(8, clampedLeft) + 'px';
    contextMenu.style.top = Math.max(8, clampedTop) + 'px';
  }

  function closeContextMenu() {
    contextMenu.hidden = true;
  }

  document.addEventListener('pointerdown', (event) => {
    if (!contextMenu.hidden && !contextMenu.contains(event.target)) closeContextMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeContextMenu();
  });
  window.addEventListener('resize', closeContextMenu);

  // ---------- Диалог ----------

  let dialogDismiss = null;

  function showDialog(message, buttons) {
    return new Promise((resolve) => {
      dialogMessage.textContent = message;
      dialogButtons.replaceChildren();
      const finish = (value) => {
        dialogOverlay.hidden = true;
        dialogDismiss = null;
        document.removeEventListener('keydown', onKey);
        resolve(value);
      };
      dialogDismiss = () => finish(null);
      const onKey = (event) => {
        if (event.key === 'Escape') { event.preventDefault(); finish(null); }
      };
      for (const spec of buttons) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = spec.label;
        button.className = spec.kind || 'secondary';
        button.addEventListener('click', () => finish(spec.value));
        dialogButtons.appendChild(button);
      }
      document.addEventListener('keydown', onKey);
      dialogOverlay.hidden = false;
      const first = dialogButtons.querySelector('button');
      if (first) first.focus();
    });
  }

  dialogOverlay.addEventListener('pointerdown', (event) => {
    if (event.target === dialogOverlay && dialogDismiss) dialogDismiss();
  });

  // ---------- Санитизация HTML превью ----------

  // marked пропускает сырой HTML из документа как есть: <img onerror>, javascript:-ссылки
  // и подобное доезжают до innerHTML нетронутыми. Чистим по белому списку и по разобранному
  // DOM, а не регулярками по строке. DOMParser создаёт инертный документ: картинки в нём не
  // грузятся, обработчики не срабатывают — дерево можно спокойно осмотреть до вставки.

  const ALLOWED_TAGS = new Set([
    'p', 'br', 'hr', 'div', 'span',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'blockquote', 'pre', 'code', 'kbd', 'samp', 'var',
    'em', 'strong', 'i', 'b', 'u', 's', 'del', 'ins', 'mark', 'small',
    'sub', 'sup', 'abbr', 'cite', 'q',
    'a', 'img', 'input',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  ]);

  // эти удаляем вместе с содержимым; остальные незнакомые теги разворачиваем,
  // сохраняя текст внутри
  const DROPPED_TAGS = new Set([
    'script', 'style', 'iframe', 'object', 'embed', 'applet', 'link', 'meta', 'base',
    'form', 'button', 'select', 'option', 'textarea', 'label', 'fieldset',
    'noscript', 'template', 'slot', 'svg', 'math',
    'frame', 'frameset', 'audio', 'video', 'source', 'track', 'canvas', 'map', 'area',
  ]);

  // атрибуты разрешаются поимённо для каждого тега, поэтому любые on*-обработчики,
  // а также style и id отсеиваются самим фактом отсутствия в списке
  const ALLOWED_ATTRS = {
    a: ['href', 'title'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    input: ['type', 'checked', 'disabled'],
    ol: ['start'],
    code: ['class'],
    pre: ['class'],
    th: ['colspan', 'rowspan', 'align'],
    td: ['colspan', 'rowspan', 'align'],
  };

  const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);
  const DATA_IMAGE_URL = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=]+$/i;
  const LANGUAGE_CLASS = /^language-[\w.+#-]+$/;

  function isSafeUrl(value, allowDataImage) {
    // браузер выбрасывает управляющие символы и пробелы при разборе адреса, поэтому
    // «java{tab}script:» для него обычная javascript-схема — проверяем ровно так же
    const url = String(value).replace(/[\u0000-\u0020\u00a0]/g, '');
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url);
    if (!scheme) return true; // относительный путь или якорь
    if (allowDataImage && DATA_IMAGE_URL.test(url)) return true;
    return SAFE_SCHEMES.has(scheme[1].toLowerCase());
  }

  function isAttrValueSafe(tag, name, value) {
    if (name === 'href') return isSafeUrl(value, false);
    if (name === 'src') return isSafeUrl(value, true);
    if (name === 'class') return LANGUAGE_CLASS.test(value.trim());
    if (tag === 'input' && name === 'type') return value.toLowerCase() === 'checkbox';
    return true;
  }

  function sanitizeElement(root) {
    // список детей снимаем заранее: дерево меняется прямо в цикле
    for (const node of Array.from(root.childNodes)) {
      if (node.nodeType === Node.COMMENT_NODE) { node.remove(); continue; }
      if (node.nodeType !== Node.ELEMENT_NODE) continue; // текст оставляем как есть

      const tag = node.localName;
      if (DROPPED_TAGS.has(tag)) { node.remove(); continue; }

      if (!ALLOWED_TAGS.has(tag)) {
        sanitizeElement(node);
        node.replaceWith(...Array.from(node.childNodes));
        continue;
      }

      const allowed = ALLOWED_ATTRS[tag] || [];
      for (const attr of Array.from(node.attributes)) {
        const name = attr.name.toLowerCase();
        if (!allowed.includes(name) || !isAttrValueSafe(tag, name, attr.value)) {
          node.removeAttribute(attr.name);
        }
      }
      sanitizeElement(node);
    }
  }

  function parseSafeDocument(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    sanitizeElement(doc.body);
    return doc;
  }

  // ---------- Копирование блоков кода ----------

  function setCopyButtonLabel(button, label) {
    button.title = label;
    button.setAttribute('aria-label', label);
  }

  function createCopyButton(getText, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'code-copy';
    button.appendChild(createIcon('copy', 14));
    setCopyButtonLabel(button, label);

    let revertTimer = null;
    button.addEventListener('click', async () => {
      const copied = await copyText(getText());
      window.clearTimeout(revertTimer);
      button.classList.toggle('copied', copied);
      button.classList.toggle('failed', !copied);
      button.replaceChildren(createIcon(copied ? 'check' : 'copy', 14));
      setCopyButtonLabel(button, copied ? 'Скопировано' : 'Не удалось скопировать');
      revertTimer = window.setTimeout(() => {
        button.classList.remove('copied', 'failed');
        button.replaceChildren(createIcon('copy', 14));
        setCopyButtonLabel(button, label);
      }, 1600);
    });
    return button;
  }

  // <pre> прокручивается по горизонтали, поэтому кнопку вешаем не внутрь него,
  // а на обёртку — иначе она уезжает вместе с длинной строкой кода
  function decorateCodeBlocks(root) {
    for (const pre of Array.from(root.querySelectorAll('pre'))) {
      const wrapper = document.createElement('div');
      wrapper.className = 'code-block';
      pre.replaceWith(wrapper);
      wrapper.appendChild(pre);
      wrapper.appendChild(createCopyButton(
        () => (pre.querySelector('code') || pre).textContent || '',
        'Скопировать код',
      ));
    }
  }

  // ---------- Документ голым текстом ----------

  // Текст собираем обходом разобранного DOM, а не через innerText: innerText требует
  // отрисовки и в скрытой ветке теряет переносы строк, а копировать документ нужно и
  // из режима редактора. Побочная выгода: кнопки из decorateCodeBlocks сюда не попадают —
  // в этом дереве их просто нет.

  const PLAIN_BLOCK_TAGS = new Set([
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'div', 'dt', 'dd', 'caption',
  ]);
  const PLAIN_CONTAINER_TAGS = new Set([
    'table', 'thead', 'tbody', 'tfoot', 'colgroup', 'dl',
  ]);

  function documentToPlainText(markdown) {
    let html = '';
    try {
      html = window.marked.parse(markdown || '');
    } catch {
      return String(markdown || '');
    }
    const doc = parseSafeDocument(html);
    const text = nodeToPlainText(doc.body, 0);
    return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function childNodesToPlainText(node, depth) {
    let out = '';
    for (const child of Array.from(node.childNodes)) out += nodeToPlainText(child, depth);
    return out;
  }

  function childElementsToPlainText(node, depth, only) {
    let out = '';
    for (const child of Array.from(node.children)) {
      if (!only || child.localName === only) out += nodeToPlainText(child, depth);
    }
    return out;
  }

  function nodeToPlainText(node, depth) {
    if (node.nodeType === Node.TEXT_NODE) return (node.nodeValue || '').replace(/\s+/g, ' ');
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.localName;
    if (tag === 'br') return '\n';
    if (tag === 'hr') return '\n———\n';
    if (tag === 'pre') return '\n' + (node.textContent || '').replace(/\s+$/, '') + '\n';
    if (tag === 'input') return node.hasAttribute('checked') ? '[x]' : '[ ]';

    if (tag === 'ul' || tag === 'ol') {
      // перебираем только элементы: переводы строк между <li> иначе станут пробелами
      return '\n' + childElementsToPlainText(node, depth, 'li') + '\n';
    }
    if (tag === 'li') {
      const parent = node.parentElement;
      let marker = '• ';
      if (parent && parent.localName === 'ol') {
        const start = Number(parent.getAttribute('start')) || 1;
        marker = (start + Array.prototype.indexOf.call(parent.children, node)) + '. ';
      }
      const body = childNodesToPlainText(node, depth + 1).trim();
      return '  '.repeat(depth) + marker + body + '\n';
    }
    if (tag === 'tr') {
      return Array.from(node.children)
        .map((cell) => childNodesToPlainText(cell, depth).trim())
        .join('\t') + '\n';
    }
    if (PLAIN_CONTAINER_TAGS.has(tag)) return '\n' + childElementsToPlainText(node, depth, null) + '\n';
    if (PLAIN_BLOCK_TAGS.has(tag)) return '\n' + childNodesToPlainText(node, depth).trim() + '\n';

    return childNodesToPlainText(node, depth);
  }

  // ---------- Основная область ----------

  // Позицию чтения храним как долю прокрутки: после смены размера/гарнитуры
  // шрифта или режима восстанавливаем «процент прочитанного», а не пиксели.
  let previewScrollRatio = 0;
  let lastPreviewFileId = null;
  let editorScrollRatio = 0;
  let lastEditorFileId = null;

  function scrollMax(el) {
    return el.scrollHeight - el.clientHeight;
  }

  previewPane.addEventListener('scroll', () => {
    if (previewPane.hidden) return;
    const max = scrollMax(previewPane);
    if (max > 0) previewScrollRatio = previewPane.scrollTop / max;
  });

  editorEl.addEventListener('scroll', () => {
    if (editorPane.hidden) return;
    const max = scrollMax(editorEl);
    if (max > 0) editorScrollRatio = editorEl.scrollTop / max;
  });

  function renderMain() {
    const file = fileById(currentId);
    const hasFile = Boolean(file);
    welcomePane.hidden = hasFile;
    previewPane.hidden = !hasFile || settings.mode !== 'preview';
    editorPane.hidden = !hasFile || settings.mode !== 'editor';
    if (!hasFile) return;

    if (settings.mode === 'editor') {
      if (lastEditorFileId !== file.id) {
        editorScrollRatio = 0;
        lastEditorFileId = file.id;
      }
      if (editorEl.value !== file.content) editorEl.value = file.content;
      editorEl.scrollTop = editorScrollRatio * Math.max(0, scrollMax(editorEl));
    } else {
      renderPreview(file);
    }
  }

  function renderPreview(file) {
    let html = '';
    try {
      html = window.marked.parse(file.content || '');
    } catch (error) {
      console.error(error);
      html = '<p>Не удалось отрендерить Markdown.</p>';
    }
    const doc = parseSafeDocument(html);
    previewBody.replaceChildren(...Array.from(doc.body.childNodes));
    for (const link of previewBody.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href') || '';
      if (/^https?:/i.test(href)) {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
    }
    decorateCodeBlocks(previewBody);
    if (lastPreviewFileId !== file.id) {
      previewScrollRatio = 0;
      lastPreviewFileId = file.id;
    }
    previewPane.scrollTop = previewScrollRatio * Math.max(0, scrollMax(previewPane));
  }

  function openFile(id) {
    if (currentId === id) return;
    currentId = id;
    const file = fileById(id);
    activeParentId = file && id !== WELCOME_ID ? file.parentId : ROOT_ID;
    renameState = null;
    markMetaDirty();
    renderFiles();
    renderMain();
    scheduleAutosave();
  }

  // ---------- Операции с файлами и папками ----------

  // Куда попадёт новый узел: в выбранную папку, иначе в папку открытого файла,
  // иначе в корень. Пересчитываем перед каждой вставкой — папку могли удалить.
  function resolveParent(explicit) {
    const candidate = explicit !== undefined ? explicit : activeParentId;
    if (candidate === ROOT_ID) return ROOT_ID;
    return folderById(candidate) ? candidate : ROOT_ID;
  }

  function createFile(explicitParent) {
    const parentId = resolveParent(explicitParent);
    const name = uniqueNameIn(parentId, 'новый-файл.md', 'file');
    const file = { id: uid(), type: 'file', name, parentId, content: '', updatedAt: nowStamp() };
    files.push(file);
    currentId = file.id;
    activeParentId = parentId;
    if (parentId) expandedFolders.add(parentId);
    renameState = { id: file.id, initial: name };
    markDirty(file.id);
    markMetaDirty();
    renderFiles();
    renderMain();
    void persistNow();
  }

  function createFolder(explicitParent) {
    const parentId = resolveParent(explicitParent);
    const name = uniqueNameIn(parentId, 'новая-папка', 'folder');
    const folder = { id: uid(), type: 'folder', name, parentId };
    folders.push(folder);
    if (parentId) expandedFolders.add(parentId);
    expandedFolders.add(folder.id);
    activeParentId = folder.id;
    renameState = { id: folder.id, initial: name };
    markMetaDirty();
    renderFiles();
    void persistNow();
  }

  function duplicateFile(id) {
    const source = fileById(id);
    if (!source || id === WELCOME_ID) return;
    const { stem, ext } = splitName(source.name);
    const copy = {
      id: uid(),
      type: 'file',
      name: uniqueNameIn(source.parentId, `${stem} (копия)${ext}`, 'file'),
      parentId: source.parentId,
      content: source.content,
      updatedAt: nowStamp(),
    };
    files.push(copy);
    currentId = copy.id;
    markDirty(copy.id);
    markMetaDirty();
    renderFiles();
    renderMain();
    void persistNow();
    setStatus(`Создана копия: ${copy.name}`);
  }

  function removeFile(id) {
    files = files.filter((f) => f.id !== id);
    markRemoved(id);
  }

  // Возвращает всё, что исчезло, — включая саму папку: на этом держится отмена.
  function removeFolderTree(folderId) {
    const folder = folderById(folderId);
    if (!folder) return { files: [], folders: [] };
    const subtree = collectSubtree(folderId);
    const removedFolders = [folder, ...subtree.folders];
    for (const file of subtree.files) removeFile(file.id);
    const doomed = new Set(removedFolders.map((f) => f.id));
    folders = folders.filter((f) => !doomed.has(f.id));
    for (const id of doomed) expandedFolders.delete(id);
    if (doomed.has(activeParentId)) activeParentId = ROOT_ID;
    markMetaDirty();
    return { files: subtree.files, folders: removedFolders };
  }

  // ---------- Отмена удаления ----------

  function rememberDeletion(removed) {
    window.clearTimeout(undoTimer);
    lastDeletion = {
      files: removed.files || [],
      folders: removed.folders || [],
      welcome: removed.welcome || null,
      previousCurrentId: removed.previousCurrentId,
      expanded: removed.expanded || [],
    };
    undoTimer = window.setTimeout(() => { lastDeletion = null; }, UNDO_WINDOW_MS);
  }

  // Пока предложение висит, имя в той же папке могли занять — подбираем свободное.
  function resolveNameCollision(node) {
    const pool = node.type === 'folder' ? folders : files;
    const taken = pool.some((n) =>
      n.id !== node.id && n.parentId === node.parentId && n.name === node.name);
    if (!taken) return;
    const { stem, ext } = node.type === 'folder'
      ? { stem: node.name, ext: '' }
      : splitName(node.name);
    let n = 2;
    let candidate = `${stem}-${n}${ext}`;
    while (nodeByNameIn(node.parentId, candidate, node.type)) {
      n += 1;
      candidate = `${stem}-${n}${ext}`;
    }
    node.name = candidate;
  }

  function undoLastDeletion() {
    const snapshot = lastDeletion;
    if (!snapshot) return;
    lastDeletion = null;
    window.clearTimeout(undoTimer);

    for (const folder of snapshot.folders) {
      if (!folderById(folder.id)) folders.push(folder);
    }
    for (const file of snapshot.files) {
      if (!fileById(file.id)) files.push(file);
    }
    if (snapshot.welcome && !welcomeFile) welcomeFile = snapshot.welcome;

    // Родительскую папку могли удалить отдельно, пока предложение висело:
    // такие узлы поднимаем в корень, иначе они просто не покажутся в дереве.
    const restored = [...snapshot.folders, ...snapshot.files];
    const known = new Set(folders.map((f) => f.id));
    for (const node of restored) {
      if (node.parentId !== ROOT_ID && !known.has(node.parentId)) node.parentId = ROOT_ID;
    }
    for (const node of restored) resolveNameCollision(node);

    for (const file of snapshot.files) markDirty(file.id);
    for (const id of snapshot.expanded) if (folderById(id)) expandedFolders.add(id);
    if (snapshot.previousCurrentId && (fileById(snapshot.previousCurrentId)
        || (welcomeFile && snapshot.previousCurrentId === WELCOME_ID))) {
      currentId = snapshot.previousCurrentId;
    }
    markMetaDirty();

    renderFiles();
    renderMain();
    void persistNow();
    const count = snapshot.files.length + snapshot.folders.length + (snapshot.welcome ? 1 : 0);
    setStatus(`Удаление отменено, возвращено: ${count}`);
  }

  function deleteMessageFor(node, ghost) {
    if (ghost) return `Удалить справку «${node.name}»? Её раздел исчезнет и больше не появится.`;
    if (node.type !== 'folder') return `Удалить файл «${node.name}»? Это действие нельзя отменить.`;
    const subtree = collectSubtree(node.id);
    if (subtree.files.length === 0 && subtree.folders.length === 0) {
      return `Удалить пустую папку «${node.name}»?`;
    }
    const parts = [`файлов: ${subtree.files.length}`];
    if (subtree.folders.length > 0) parts.push(`вложенных папок: ${subtree.folders.length}`);
    return `Удалить папку «${node.name}» вместе с содержимым (${parts.join(', ')})? `
      + 'Это действие нельзя отменить.';
  }

  async function confirmDelete(id) {
    const node = nodeById(id);
    if (!node) return;
    const ghost = id === WELCOME_ID;

    const answer = await showDialog(deleteMessageFor(node, ghost), [
      { label: 'Удалить', value: 'delete', kind: 'danger' },
      { label: 'Отмена', value: null, kind: 'secondary' },
    ]);
    if (answer !== 'delete') return;

    const previousCurrentId = currentId;
    const expanded = Array.from(expandedFolders);
    let removed;

    if (ghost) {
      removed = { files: [], folders: [], welcome: welcomeFile };
      welcomeFile = null;
      markMetaDirty();
    } else if (node.type === 'folder') {
      removed = removeFolderTree(node.id);
    } else {
      removed = { files: [node], folders: [] };
      removeFile(node.id);
    }
    rememberDeletion({ ...removed, previousCurrentId, expanded });

    // текущий файл мог исчезнуть вместе с папкой, а не только напрямую
    if (!fileById(currentId)) {
      const rest = flattenFiles();
      currentId = rest.length > 0 ? rest[0].id : (welcomeFile ? WELCOME_ID : null);
      markMetaDirty();
    }
    renderFiles();
    renderMain();
    void persistNow();
    setStatusWithUndo(`Удалён: ${node.name}`);
  }

  // Массовое удаление. Справка живёт отдельно от списка файлов, поэтому она
  // не попадает под эту кнопку — у неё остаётся личное удаление через «⋯».
  async function confirmDeleteAll() {
    if (files.length === 0 && folders.length === 0) {
      setStatus('Нечего удалять');
      return;
    }

    const parts = [`файлов: ${files.length}`];
    if (folders.length > 0) parts.push(`папок: ${folders.length}`);
    const answer = await showDialog(
      `Удалить всё содержимое панели (${parts.join(', ')})? `
      + (welcomeFile ? 'Справка останется на месте. ' : '')
      + 'Сразу после удаления можно будет отменить.',
      [
        { label: 'Удалить всё', value: 'delete', kind: 'danger' },
        { label: 'Отмена', value: null, kind: 'secondary' },
      ],
    );
    if (answer !== 'delete') return;

    const removed = { files, folders };
    const previousCurrentId = currentId;
    const expanded = Array.from(expandedFolders);
    for (const file of files) markRemoved(file.id);

    files = [];
    folders = [];
    expandedFolders = new Set();
    activeParentId = ROOT_ID;
    currentId = welcomeFile ? WELCOME_ID : null;
    markMetaDirty();
    rememberDeletion({ ...removed, previousCurrentId, expanded });

    renderFiles();
    renderMain();
    void persistNow();
    setStatusWithUndo(`Удалено: ${removed.files.length + removed.folders.length}`);
  }

  // Перенос узла — смена одного поля parentId.  // Перенос узла — смена одного поля parentId. Возвращает false, если перенос
  // запрещён: папку нельзя уронить в себя или в собственного потомка.
  function moveNode(nodeId, newParentId) {
    if (!canMoveInto(nodeId, newParentId)) return false;
    const node = nodeById(nodeId);
    node.name = uniqueNameIn(newParentId, node.name, node.type);
    node.parentId = newParentId;
    if (node.type === 'file') {
      node.updatedAt = nowStamp();
      markDirty(node.id);
    }
    if (newParentId !== ROOT_ID) expandedFolders.add(newParentId);
    markMetaDirty();
    return true;
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function downloadFile(id) {
    const file = fileById(id);
    if (!file) return;
    downloadBlob(new Blob([file.content], { type: 'text/markdown;charset=utf-8' }), file.name);
  }

  // JSZip сам раскладывает по каталогам, если складывать во вложенные scope.
  // folder() заодно создаёт запись каталога — без неё пустые папки в архив не попадут.
  function addTreeToZip(scope, parentId) {
    for (const node of childrenOf(parentId)) {
      if (node.type === 'folder') addTreeToZip(scope.folder(node.name), node.id);
      else scope.file(node.name, node.content);
    }
  }

  async function downloadAllZip() {
    if (files.length === 0 && folders.length === 0) {
      setStatus('Нет файлов для скачивания');
      return;
    }
    flushEditor();
    const zip = new window.JSZip();
    addTreeToZip(zip, ROOT_ID);
    const stamp = nowStamp().slice(0, 10);
    const blob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(blob, `markdown-${stamp}.zip`);
    setStatus(`В архиве файлов: ${files.length}`);
  }

  async function downloadFolderZip(folderId) {
    const folder = folderById(folderId);
    if (!folder) return;
    flushEditor();
    const zip = new window.JSZip();
    addTreeToZip(zip.folder(folder.name), folderId);
    const blob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(blob, `${folder.name}.zip`);
    setStatus(`В архиве файлов: ${collectSubtree(folderId).files.length}`);
  }

  async function copyDocumentAsText() {
    const file = fileById(currentId);
    if (!file) { setStatus('Нечего копировать: файл не открыт'); return; }
    flushEditor(); // правки из редактора должны попасть в копию
    const text = documentToPlainText(file.content);
    if (!text) { setStatus('Документ пуст'); return; }
    const copied = await copyText(text);
    setStatus(copied ? `Скопировано символов: ${text.length}` : 'Не удалось скопировать');
  }

  // ---------- Загрузка файлов ----------

  function isMarkdownLike(file) {
    const name = file.name.toLowerCase();
    if (/\.(md|markdown|txt|mdown|mkd)$/.test(name)) return true;
    // раньше сюда проходил любой text/*, включая .csv, .json и .js
    return (file.type || '') === 'text/markdown' || (file.type || '') === 'text/plain';
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(String(reader.result || '')));
      reader.addEventListener('error', () => reject(reader.error || new Error('file read failed')));
      reader.readAsText(file, 'utf-8');
    });
  }

  // Создаёт недостающие звенья цепочки папок и возвращает id последнего.
  function ensureFolderPath(segments, startParentId) {
    let parentId = startParentId;
    for (const segment of segments || []) {
      if (!segment || segment === '.' || segment === '..') continue;
      let folder = nodeByNameIn(parentId, segment, 'folder');
      if (!folder) {
        folder = { id: uid(), type: 'folder', name: segment, parentId };
        folders.push(folder);
        expandedFolders.add(folder.id);
        markMetaDirty();
      }
      parentId = folder.id;
    }
    return parentId;
  }

  async function askConflict(name, many) {
    const buttons = [{ label: 'Заменить', value: 'replace', kind: 'primary' }];
    if (many) buttons.push({ label: 'Заменить все', value: 'replace-all', kind: 'primary' });
    buttons.push({ label: 'Пропустить', value: 'skip', kind: 'secondary' });
    if (many) buttons.push({ label: 'Пропустить все', value: 'skip-all', kind: 'secondary' });
    return showDialog(`Файл «${name}» уже есть в этой папке. Заменить его содержимое?`, buttons);
  }

  // items: [{file, segments}] — segments это путь папок относительно точки вставки
  async function loadExternalFiles(items, baseParentId) {
    const list = Array.from(items || []);
    if (list.length === 0) return;
    flushEditor();

    const rootParentId = resolveParent(baseParentId);
    let skipped = 0;

    // Читаем пачками параллельно: сотня последовательных FileReader — заметная пауза.
    const prepared = [];
    for (let i = 0; i < list.length; i += READ_BATCH) {
      const batch = list.slice(i, i + READ_BATCH);
      const contents = await Promise.all(batch.map(async (item) => {
        if (!isMarkdownLike(item.file)) return null;
        try { return await readFileAsText(item.file); } catch { return null; }
      }));
      contents.forEach((content, k) => {
        if (content === null) skipped += 1;
        else prepared.push({ file: batch[k].file, segments: batch[k].segments, content });
      });
      if (list.length > READ_BATCH) {
        setStatus(`Чтение: ${Math.min(i + READ_BATCH, list.length)} из ${list.length}`, true);
      }
    }

    let loaded = 0;
    let lastId = null;
    let bulkAnswer = null; // 'replace-all' | 'skip-all' — ответ «для всех остальных»
    const many = prepared.length > 1;

    for (const item of prepared) {
      const parentId = ensureFolderPath(item.segments, rootParentId);
      const existing = nodeByNameIn(parentId, item.file.name, 'file');

      if (existing) {
        let answer = bulkAnswer;
        if (!answer) {
          answer = await askConflict(pathOf(existing), many);
          if (answer === 'replace-all' || answer === 'skip-all') bulkAnswer = answer;
        }
        if (answer !== 'replace' && answer !== 'replace-all') { skipped += 1; continue; }
        existing.content = item.content;
        existing.updatedAt = nowStamp();
        markDirty(existing.id);
        lastId = existing.id;
      } else {
        const file = {
          id: uid(),
          type: 'file',
          name: item.file.name,
          parentId,
          content: item.content,
          updatedAt: nowStamp(),
        };
        files.push(file);
        markDirty(file.id);
        lastId = file.id;
      }
      loaded += 1;
    }

    if (lastId) {
      currentId = lastId;
      const opened = fileById(lastId);
      activeParentId = opened ? opened.parentId : ROOT_ID;
    }
    markMetaDirty();
    renderFiles();
    renderMain();
    void persistNow();
    const skippedText = skipped > 0 ? `, пропущено: ${skipped}` : '';
    setStatus(`Загружено файлов: ${loaded}${skippedText}`);
  }

  // ---------- Drag-n-drop ----------

  // '/глава-1/раздел/файл.md' → ['глава-1', 'раздел']
  function pathSegments(fullPath, dropName) {
    const parts = String(fullPath || '').split('/').filter(Boolean);
    if (dropName && parts.length > 0 && parts[parts.length - 1] === dropName) parts.pop();
    return parts;
  }

  // Разворачивает брошенные файлы и папки, сохраняя структуру каталогов.
  // Пустые каталоги собираются отдельно — иначе они не дожили бы до дерева.
  async function loadDroppedEntries(entries, baseParentId) {
    const collected = [];
    const directories = [];

    async function walk(entry) {
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        collected.push({ file, segments: pathSegments(entry.fullPath, file.name) });
        return;
      }
      if (!entry.isDirectory) return;
      directories.push(pathSegments(entry.fullPath, null));
      const reader = entry.createReader();
      // readEntries отдаёт порциями (обычно по 100) — читаем до пустой порции
      let batch;
      do {
        batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        for (const child of batch) await walk(child);
      } while (batch.length > 0);
    }

    for (const entry of entries) {
      try {
        await walk(entry);
      } catch { /* недоступная запись — пропускаем */ }
    }

    if (collected.length > BULK_DROP_ASK) {
      const answer = await showDialog(
        `В брошенных папках ${collected.length} файлов. Загрузить их все? Это может занять время.`,
        [
          { label: 'Загрузить', value: 'go', kind: 'primary' },
          { label: 'Отмена', value: null, kind: 'secondary' },
        ],
      );
      if (answer !== 'go') { setStatus('Загрузка отменена'); return; }
    }

    const rootParentId = resolveParent(baseParentId);
    for (const segments of directories) ensureFolderPath(segments, rootParentId);
    if (collected.length === 0) {
      markMetaDirty();
      renderFiles();
      void persistNow();
      setStatus(directories.length > 0 ? `Создано папок: ${directories.length}` : 'Не найдено подходящих файлов');
      return;
    }
    await loadExternalFiles(collected, rootParentId);
  }

  function isFileTransfer(dataTransfer) {
    if (!dataTransfer) return false;
    const types = Array.from(dataTransfer.types || []);
    if (types.includes(DND_TYPE)) return false; // это наш внутренний перенос
    return types.length === 0 || types.includes('Files');
  }

  function isNodeTransfer(dataTransfer) {
    if (!dataTransfer) return false;
    return Array.from(dataTransfer.types || []).includes(DND_TYPE);
  }

  // Единственное место, где решается «куда пришёлся дроп». Им пользуются и внешняя
  // загрузка, и внутренний перенос — размазать эту логику по обработчикам значило бы
  // написать её дважды.
  function resolveDropTarget(target) {
    const row = target && target.closest ? target.closest('.file-row') : null;
    if (!row || !row.dataset.nodeId) return { parentId: ROOT_ID, rowEl: null };
    if (row.dataset.nodeType === 'ghost') return { parentId: ROOT_ID, rowEl: null };
    if (row.dataset.nodeType === 'folder') return { parentId: row.dataset.nodeId, rowEl: row };
    const file = fileById(row.dataset.nodeId);
    return { parentId: file ? file.parentId : ROOT_ID, rowEl: null };
  }

  function canMoveInto(nodeId, parentId) {
    const node = nodeById(nodeId);
    if (!node || nodeId === WELCOME_ID) return false;
    if (node.parentId === parentId) return false;
    if (parentId !== ROOT_ID && !folderById(parentId)) return false;
    if (node.type === 'folder') {
      if (parentId === node.id) return false;
      // папку нельзя уронить внутрь собственного потомка — дерево бы распалось
      if (parentId !== ROOT_ID && isInsideFolder(parentId, node.id)) return false;
    }
    return true;
  }

  function clearDropHighlight() {
    if (dropHighlightRow) dropHighlightRow.classList.remove('drop-target');
    dropHighlightRow = null;
    fileListEl.classList.remove('drag-over');
  }

  function showDropHighlight(target, movingId) {
    clearDropHighlight();
    if (movingId && !canMoveInto(movingId, target.parentId)) return;
    if (target.rowEl) {
      target.rowEl.classList.add('drop-target');
      dropHighlightRow = target.rowEl;
    } else {
      fileListEl.classList.add('drag-over');
    }
  }

  function makeRowDraggable(row, node) {
    row.draggable = true;
    row.addEventListener('dragstart', (event) => {
      draggedNodeId = node.id;
      row.classList.add('dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        // свой тип переноса: обработчик внешних файлов его пропускает мимо
        event.dataTransfer.setData(DND_TYPE, node.id);
        event.dataTransfer.setData('text/plain', node.name);
      }
    });
    row.addEventListener('dragend', () => {
      draggedNodeId = null;
      row.classList.remove('dragging');
      clearDropHighlight();
    });
  }

  function installDropArea() {
    let dragDepth = 0;

    sidebar.addEventListener('dragenter', (event) => {
      if (isNodeTransfer(event.dataTransfer)) { event.preventDefault(); return; }
      if (!isFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      dragDepth += 1;
      showDropHighlight(resolveDropTarget(event.target), null);
    });

    sidebar.addEventListener('dragover', (event) => {
      if (isNodeTransfer(event.dataTransfer)) {
        event.preventDefault();
        const target = resolveDropTarget(event.target);
        const allowed = !draggedNodeId || canMoveInto(draggedNodeId, target.parentId);
        event.dataTransfer.dropEffect = allowed ? 'move' : 'none';
        showDropHighlight(target, draggedNodeId);
        return;
      }
      if (!isFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      showDropHighlight(resolveDropTarget(event.target), null);
    });

    sidebar.addEventListener('dragleave', (event) => {
      if (isNodeTransfer(event.dataTransfer)) return;
      if (!isFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) clearDropHighlight();
    });

    sidebar.addEventListener('drop', (event) => {
      if (isNodeTransfer(event.dataTransfer)) {
        event.preventDefault();
        const target = resolveDropTarget(event.target);
        const nodeId = draggedNodeId || event.dataTransfer.getData(DND_TYPE);
        clearDropHighlight();
        const node = nodeById(nodeId);
        if (node && moveNode(nodeId, target.parentId)) {
          renderFiles();
          void persistNow();
          const where = target.parentId ? `«${pathOf(folderById(target.parentId))}»` : 'корень';
          setStatus(`Перенесено в ${where}: ${node.name}`);
        }
        return;
      }
      if (!isFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      dragDepth = 0;
      const target = resolveDropTarget(event.target);
      clearDropHighlight();
      // webkitGetAsEntry обязан вызываться синхронно внутри drop —
      // после первого await элементы dataTransfer уже мертвы
      const entries = [];
      for (const item of Array.from((event.dataTransfer && event.dataTransfer.items) || [])) {
        const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
        if (entry) entries.push(entry);
      }
      if (entries.length > 0) {
        void loadDroppedEntries(entries, target.parentId);
      } else {
        const plain = Array.from((event.dataTransfer && event.dataTransfer.files) || [])
          .map((file) => ({ file, segments: [] }));
        void loadExternalFiles(plain, target.parentId);
      }
    });

    // случайный drop мимо панели не должен уводить со страницы
    window.addEventListener('dragover', (event) => event.preventDefault());
    window.addEventListener('drop', (event) => event.preventDefault());
  }

  // ---------- Синхронизация вкладок ----------

  // Раньше две вкладки перезаписывали воркспейс целиком и последняя побеждала.
  // Теперь каждая запись объявляется в канале, а соседи перечитывают хранилище.
  const syncChannel = ('BroadcastChannel' in window) ? new BroadcastChannel(SYNC_CHANNEL) : null;
  let reloadingFromStorage = false;

  function announceChange() {
    if (!syncChannel) return;
    try { syncChannel.postMessage({ tab: TAB_ID }); } catch { /* канал закрыт */ }
  }

  async function reloadFromStorage() {
    if (reloadingFromStorage) return;
    reloadingFromStorage = true;
    try {
      const meta = await readMeta();
      if (!meta) return;
      const stored = (await readAllFiles()) || [];

      // Файл, который правят прямо сейчас, и всё ещё не дописанное на диск не
      // подменяем: иначе текст сменился бы под курсором.
      const editing = document.activeElement === editorEl ? currentId : null;
      const protectedIds = new Set(dirtyFileIds);
      if (editing) protectedIds.add(editing);

      const next = [];
      for (const record of stored) {
        const local = files.find((f) => f.id === record.id);
        if (local && protectedIds.has(record.id)) { next.push(local); continue; }
        next.push({
          id: record.id,
          type: 'file',
          name: record.name,
          parentId: record.parentId === undefined ? ROOT_ID : record.parentId,
          content: record.content,
          updatedAt: record.updatedAt,
        });
      }
      for (const local of files) {
        if (protectedIds.has(local.id) && !next.some((f) => f.id === local.id)) next.push(local);
      }
      files = next;
      folders = (meta.folders || []).map((f) => ({
        id: f.id, type: 'folder', name: f.name, parentId: f.parentId === undefined ? ROOT_ID : f.parentId,
      }));
      welcomeFile = meta.welcome && typeof meta.welcome.content === 'string'
        ? makeWelcome(meta.welcome.content, meta.welcome.updatedAt)
        : null;
      if (!fileById(currentId)) {
        const rest = flattenFiles();
        currentId = rest.length > 0 ? rest[0].id : (welcomeFile ? WELCOME_ID : null);
      }
      if (activeParentId !== ROOT_ID && !folderById(activeParentId)) activeParentId = ROOT_ID;
      renderFiles();
      renderMain();
      setStatus('Подхвачены изменения из другой вкладки');
    } catch (error) {
      console.error(error);
    } finally {
      reloadingFromStorage = false;
    }
  }

  if (syncChannel) {
    syncChannel.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || data.tab === TAB_ID) return;
      void reloadFromStorage();
    });
  }

  // ---------- Ширина сайдбара ----------  // ---------- Ширина сайдбара ----------

  sidebarResizer.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    sidebarResizer.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing');
    const onMove = (ev) => {
      settings.sidebarWidth = clamp(ev.clientX, SIDEBAR_MIN, SIDEBAR_MAX);
      document.documentElement.style.setProperty('--sidebar-width', settings.sidebarWidth + 'px');
    };
    const onUp = () => {
      sidebarResizer.removeEventListener('pointermove', onMove);
      sidebarResizer.removeEventListener('pointerup', onUp);
      sidebarResizer.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('resizing');
      saveSettings();
    };
    sidebarResizer.addEventListener('pointermove', onMove);
    sidebarResizer.addEventListener('pointerup', onUp);
    sidebarResizer.addEventListener('pointercancel', onUp);
  });

  sidebarResizer.addEventListener('dblclick', () => {
    settings.sidebarWidth = DEFAULT_SETTINGS.sidebarWidth;
    saveSettings();
    applySettings();
  });

  // ---------- Редактор ----------

  function flushEditor() {
    const file = fileById(currentId);
    if (!file || settings.mode !== 'editor') return;
    if (file.content !== editorEl.value) {
      file.content = editorEl.value;
      file.updatedAt = nowStamp();
      markDirty(file.id);
      scheduleAutosave();
    }
  }

  editorEl.addEventListener('input', () => {
    const file = fileById(currentId);
    if (!file) return;
    file.content = editorEl.value;
    file.updatedAt = nowStamp();
    markDirty(file.id);
    scheduleAutosave();
  });

  editorEl.addEventListener('keydown', (event) => {
    if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      document.execCommand('insertText', false, '  ');
    }
  });

  // ---------- Шапка ----------

  function setMode(mode) {
    if (settings.mode === mode) return;
    if (settings.mode === 'editor') flushEditor();
    settings.mode = mode;
    saveSettings();
    applySettings();
  }

  modePreviewButton.addEventListener('click', () => setMode('preview'));
  modeEditorButton.addEventListener('click', () => setMode('editor'));

  previewFontSelect.addEventListener('change', () => {
    settings.previewFont = previewFontSelect.value;
    saveSettings();
    applySettings();
  });

  function bumpSetting(key, delta, min, max) {
    settings[key] = clamp(settings[key] + delta, min, max);
    saveSettings();
    applySettings();
  }

  previewSizeDec.addEventListener('click', () => bumpSetting('previewSize', -1, PREVIEW_SIZE_MIN, PREVIEW_SIZE_MAX));
  previewSizeInc.addEventListener('click', () => bumpSetting('previewSize', 1, PREVIEW_SIZE_MIN, PREVIEW_SIZE_MAX));
  editorSizeDec.addEventListener('click', () => bumpSetting('editorSize', -1, EDITOR_SIZE_MIN, EDITOR_SIZE_MAX));
  editorSizeInc.addEventListener('click', () => bumpSetting('editorSize', 1, EDITOR_SIZE_MIN, EDITOR_SIZE_MAX));

  copyDocButton.addEventListener('click', () => { void copyDocumentAsText(); });
  downloadZipButton.addEventListener('click', () => { void downloadAllZip(); });
  newFileButton.addEventListener('click', () => createFile());
  newFolderButton.addEventListener('click', () => createFolder());
  deleteAllButton.addEventListener('click', () => { void confirmDeleteAll(); });
  uploadButton.addEventListener('click', () => uploadInput.click());
  uploadInput.addEventListener('change', () => {
    void loadExternalFiles(uploadInput.files);
    uploadInput.value = '';
  });

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      flushEditor();
      void persistNow().then(() => setStatus('Сохранено'));
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushEditor();
      void persistNow();
    }
  });

  // При перезагрузке/закрытии не даём пропасть несохранённому дебаунсу. Писать в
  // IndexedDB из pagehide ненадёжно — Chrome закрывает соединение при выгрузке,
  // поэтому кладём синхронный снимок в localStorage.
  //
  // В снимок идёт ТОЛЬКО открытый файл, а не весь воркспейс. Раньше туда уезжала
  // вся база, и закрытие давно открытой вкладки откатывало работу, сделанную в
  // соседней: снимок был «свежее» по метке времени, хотя содержал устаревшие данные.
  window.addEventListener('pagehide', () => {
    flushEditor();
    window.clearTimeout(autosaveTimer);
    const file = fileById(currentId);
    if (!file) return;
    try {
      window.localStorage.setItem(EMERGENCY_KEY, JSON.stringify({
        version: SCHEMA_VERSION,
        file: { id: file.id, content: file.content, updatedAt: file.updatedAt },
        savedAt: nowStamp(),
      }));
    } catch { /* переполнение квоты — остаёмся на последнем автосохранении */ }
  });

  // ---------- Инициализация ----------

  const WELCOME_DOC = `# Добро пожаловать в MDEditor

Это локальный редактор и просмотрщик Markdown-файлов. Всё хранится **в вашем браузере** — никакие данные никуда не отправляются.

## Как пользоваться

- Перетащите свои \`.md\`-файлы в панель слева — можно сразу несколько или целую папку.
- Режим **Просмотр / Редактор** переключается в шапке и действует на все файлы, пока вы его не смените.
- Там же настраиваются гарнитура и размер шрифта просмотра и размер шрифта редактора.
- Кнопка **ZIP** скачивает все файлы одним архивом; отдельный файл можно скачать через меню «⋯» напротив его имени.
- Ширина панели файлов меняется перетаскиванием её правого края; двойной клик по краю возвращает ширину по умолчанию.

## Что умеет просмотр

> Цитаты, **жирный**, *курсив*, \`код\`…

\`\`\`js
function hello() {
  console.log('…и блоки кода');
}
\`\`\`

| Таблицы | Тоже |
| ------- | ---- |
| да      | ✓    |

- [x] и списки задач

---

Эта справка живёт в отдельном разделе над списком файлов и не попадает в ZIP-архив. Когда она станет не нужна — удалите её через меню «⋯», и раздел исчезнет насовсем.

Приятной работы!
`;

  function makeWelcome(content, updatedAt) {
    return {
      id: WELCOME_ID,
      type: 'file',
      name: WELCOME_NAME,
      parentId: ROOT_ID,
      content,
      updatedAt: updatedAt || nowStamp(),
    };
  }

  function pickCurrentId(preferred) {
    if (preferred === WELCOME_ID && welcomeFile) return WELCOME_ID;
    if (files.some((f) => f.id === preferred)) return preferred;
    const rest = flattenFiles();
    if (rest.length > 0) return rest[0].id;
    return welcomeFile ? WELCOME_ID : null;
  }

  // Схема v3: файлы лежат по записи на файл, дерево папок и справка — в метаданных.
  function applyStoredWorkspace(meta, stored) {
    files = (stored || [])
      .filter((record) => record && typeof record.name === 'string')
      .map((record) => ({
        id: record.id,
        type: 'file',
        name: record.name,
        parentId: record.parentId === undefined ? ROOT_ID : record.parentId,
        content: typeof record.content === 'string' ? record.content : '',
        updatedAt: record.updatedAt || nowStamp(),
      }));
    folders = (meta.folders || [])
      .filter((f) => f && typeof f.name === 'string' && f.id)
      .map((f) => ({
        id: f.id,
        type: 'folder',
        name: f.name,
        parentId: f.parentId === undefined ? ROOT_ID : f.parentId,
      }));

    // осиротевшие узлы (папка исчезла, ссылка осталась) поднимаем в корень,
    // иначе они просто не покажутся в дереве
    const known = new Set(folders.map((f) => f.id));
    for (const node of [...folders, ...files]) {
      if (node.parentId !== ROOT_ID && !known.has(node.parentId)) node.parentId = ROOT_ID;
    }

    welcomeFile = meta.welcome && typeof meta.welcome.content === 'string'
      ? makeWelcome(meta.welcome.content, meta.welcome.updatedAt)
      : null;
    expandedFolders = new Set((meta.expanded || []).filter((id) => known.has(id)));
    currentId = pickCurrentId(meta.currentId);
    const opened = fileById(currentId);
    activeParentId = opened && currentId !== WELCOME_ID ? opened.parentId : ROOT_ID;
  }

  // Схема v1/v2: один монолит со списком файлов. Всё уезжает в корень — папок там не было.
  function migrateLegacyState(state) {
    files = (state.files || [])
      .filter((f) => f && typeof f.name === 'string')
      .map((f) => ({
        id: f.id || uid(),
        type: 'file',
        name: f.name,
        parentId: ROOT_ID,
        content: typeof f.content === 'string' ? f.content : '',
        updatedAt: f.updatedAt || nowStamp(),
      }));
    folders = [];
    expandedFolders = new Set();

    let preferred = state.currentId;
    if ((state.version || 1) >= 2) {
      welcomeFile = state.welcome && typeof state.welcome.content === 'string'
        ? makeWelcome(state.welcome.content, state.welcome.updatedAt)
        : null;
    } else {
      // v1: приветственный файл переезжает из общего списка в призрачный раздел
      const index = files.findIndex((f) =>
        f.name === WELCOME_NAME && f.content.startsWith('# Добро пожаловать в MDEditor'));
      if (index !== -1) {
        const moved = files.splice(index, 1)[0];
        welcomeFile = makeWelcome(moved.content, moved.updatedAt);
        if (preferred === moved.id) preferred = WELCOME_ID;
      }
    }

    currentId = pickCurrentId(preferred);
    activeParentId = ROOT_ID;
    for (const file of files) markDirty(file.id);
    markMetaDirty();
  }

  // Аварийный снимок несёт один файл, поэтому подменить может только его — и только
  // если он строго свежее записи в базе.
  function applyEmergencySnapshot() {
    let raw = null;
    try {
      raw = window.localStorage.getItem(EMERGENCY_KEY);
      window.localStorage.removeItem(EMERGENCY_KEY);
    } catch { return false; }
    if (!raw) return false;

    try {
      const snapshot = JSON.parse(raw);
      const saved = snapshot && snapshot.file;
      if (!saved || typeof saved.content !== 'string') return false;

      const target = saved.id === WELCOME_ID ? welcomeFile : files.find((f) => f.id === saved.id);
      if (!target) return false;
      if (String(saved.updatedAt || '') <= String(target.updatedAt || '')) return false;

      target.content = saved.content;
      target.updatedAt = saved.updatedAt;
      markDirty(target.id);
      return true;
    } catch {
      return false;
    }
  }

  async function init() {
    loadSettings();
    if (window.marked && window.marked.setOptions) {
      window.marked.setOptions({ gfm: true, breaks: false });
    }

    let needsSave = false;
    try {
      const meta = await readMeta();
      if (meta) {
        applyStoredWorkspace(meta, await readAllFiles());
      } else {
        const legacy = await readLegacyState().catch(() => null);
        if (legacy && Array.isArray(legacy.files)) {
          migrateLegacyState(legacy);
          needsSave = true;
          setStatus('Файлы перенесены на новую схему хранения');
        } else {
          welcomeFile = makeWelcome(WELCOME_DOC);
          currentId = WELCOME_ID;
          markMetaDirty();
          needsSave = true;
        }
      }
    } catch (error) {
      console.error(error);
      setStatus('IndexedDB недоступен — файлы не сохранятся', true);
      if (!welcomeFile) {
        welcomeFile = makeWelcome(WELCOME_DOC);
        currentId = WELCOME_ID;
      }
    }

    if (applyEmergencySnapshot()) needsSave = true;

    installDropArea();
    applySettings();
    renderFiles();
    renderMain();

    if (needsSave) {
      await persistNow();
      // монолит больше не нужен: новая схема уже на диске
      await dropLegacyState().catch(() => {});
    }
  }

  void init();
})();
