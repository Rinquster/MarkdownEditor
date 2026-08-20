(() => {
  'use strict';

  // Путь к соседним файлам считаем от самого app.js, а не от документа:
  // страница может лежать в подкаталоге, и относительный путь уехал бы вместе с ней.
  const APP_BASE = (document.currentScript && document.currentScript.src)
    ? document.currentScript.src.replace(/js\/app\.js(?:\?.*)?$/, '')
    : './';

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
  const PREVIEW_REFRESH_MS = 160; // задержка живого превью в режиме «Вместе»
  const EDITOR_INDENT = '  ';     // шаг отступа в редакторе
  const HIGHLIGHT_MAX = 20000;    // выше этого размера блок кода не подсвечиваем
  const EDITOR_HIGHLIGHT_MAX = 200000; // выше этого размера документ в редакторе не красим
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
  const SPLIT_MIN = 20;            // доля редактора в режиме «Вместе», проценты
  const SPLIT_MAX = 80;
  const SIDEBAR_MAX = 520;

  const FONT_STACKS = {
    'Lato': "'Lato', 'Segoe UI', system-ui, sans-serif",
    'Inter': "'Inter', 'Segoe UI', system-ui, sans-serif",
    'Roboto': "'Roboto', 'Segoe UI', system-ui, sans-serif",
    'Liberation Sans': "'Liberation Sans', Arial, sans-serif",
    'Liberation Serif': "'Liberation Serif', 'Times New Roman', serif",
  };

  const MODES = ['preview', 'split', 'editor'];
  const THEMES = ['auto', 'light', 'dark'];
  const READING_SPEED = 180; // слов в минуту — для оценки времени чтения

  const DEFAULT_SETTINGS = {
    mode: 'preview',
    splitPercent: 50,
    toolbar: true,
    editorHighlight: true,
    toc: false,
    theme: 'auto',
    previewFont: 'Lato',
    previewSize: 17,
    editorSize: 14,
    sidebarWidth: 280,
  };

  // ---------- Элементы ----------

  const el = (id) => document.getElementById(id);

  const modePreviewButton = el('mode-preview-button');
  const modeSplitButton = el('mode-split-button');
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
  const sidebarToggle = el('sidebar-toggle');
  const sidebarBackdrop = el('sidebar-backdrop');
  const sidebarResizer = el('sidebar-resizer');
  const fileListEl = el('file-list');
  const fileSearchInput = el('file-search-input');
  const statusLine = el('status-line');
  const previewPane = el('preview-pane');
  const previewBody = el('preview-body');
  const editorPane = el('editor-pane');
  const editorEl = el('editor');
  const editorToolbar = el('editor-toolbar');
  const editorHighlightLayer = el('editor-highlight');
  const tocPanel = el('toc-panel');
  const tocList = el('toc-list');
  const tocButton = el('toc-button');
  const themeButton = el('theme-button');
  const docPath = el('doc-path');
  const docSave = el('doc-save');
  const docStats = el('doc-stats');
  const findBar = el('find-bar');
  const findInput = el('find-input');
  const findCount = el('find-count');
  const findPrev = el('find-prev');
  const findNext = el('find-next');
  const findClose = el('find-close');
  const splitResizer = el('split-resizer');
  const contentEl = el('content');
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
  let searchQuery = '';            // фильтр списка файлов, не сохраняется
  let searchView = null;           // {visible: Set, hits: Map} пока фильтр активен
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

  function countOccurrences(haystack, needle) {
    if (!needle) return 0;
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index !== -1) {
      count += 1;
      index = haystack.indexOf(needle, index + needle.length);
    }
    return count;
  }

  // Что остаётся в дереве при активном фильтре: сами совпадения, все их предки
  // (иначе совпадение оказалось бы в невидимой ветке) и, если совпало имя папки,
  // всё её содержимое.
  function computeSearchView(query) {
    const visible = new Set();
    const hits = new Map();

    const markAncestors = (node) => {
      let parentId = node.parentId;
      for (let guard = 0; parentId && guard < 200; guard += 1) {
        visible.add(parentId);
        const folder = folderById(parentId);
        if (!folder) break;
        parentId = folder.parentId;
      }
    };

    for (const folder of folders) {
      if (!folder.name.toLowerCase().includes(query)) continue;
      visible.add(folder.id);
      markAncestors(folder);
      const subtree = collectSubtree(folder.id);
      for (const node of subtree.folders) visible.add(node.id);
      for (const node of subtree.files) visible.add(node.id);
    }

    for (const file of files) {
      const inName = file.name.toLowerCase().includes(query)
        || pathOf(file).toLowerCase().includes(query);
      const inContent = countOccurrences((file.content || '').toLowerCase(), query);
      if (!inName && inContent === 0) continue;
      visible.add(file.id);
      markAncestors(file);
      if (inContent > 0) hits.set(file.id, inContent);
    }

    return { visible, hits };
  }

  function isFolderOpen(id) {
    // при поиске дерево раскрыто целиком, иначе совпадения пришлось бы искать вручную
    return searchView ? true : expandedFolders.has(id);
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
    settings.splitPercent = clamp(settings.splitPercent, SPLIT_MIN, SPLIT_MAX);
    settings.toolbar = settings.toolbar !== false;
    settings.editorHighlight = settings.editorHighlight !== false;
    settings.toc = settings.toc === true;
    if (!THEMES.includes(settings.theme)) settings.theme = 'auto';
    if (!MODES.includes(settings.mode)) settings.mode = 'preview';
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
    sidebarResizer.setAttribute('aria-valuenow', String(settings.sidebarWidth));
    root.style.setProperty('--split-percent', String(settings.splitPercent));
    previewSizeValue.textContent = String(settings.previewSize);
    editorSizeValue.textContent = String(settings.editorSize);
    previewFontSelect.value = settings.previewFont;
    modePreviewButton.setAttribute('aria-pressed', String(settings.mode === 'preview'));
    modeSplitButton.setAttribute('aria-pressed', String(settings.mode === 'split'));
    modeEditorButton.setAttribute('aria-pressed', String(settings.mode === 'editor'));
    document.body.classList.toggle('mode-split', settings.mode === 'split');
    applyTheme();
    renderToolbar();
    renderMain();
    applyTocVisibility();
    updateDocBar();
    if (!findBar.hidden) runFind(true);
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

    updateDocBar();
    return enqueueWrite(() => writeChanges(fileIds, removed, withMeta))
      .then(() => { announceChange(); updateDocBar(); })
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
    sun: ['M8 10.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5Zm0 1.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-11a.75.75 0 0 1 .75.75v1a.75.75 0 0 1-1.5 0v-1A.75.75 0 0 1 8 1Zm0 12a.75.75 0 0 1 .75.75v1a.75.75 0 0 1-1.5 0v-1A.75.75 0 0 1 8 13ZM1 8a.75.75 0 0 1 .75-.75h1a.75.75 0 0 1 0 1.5h-1A.75.75 0 0 1 1 8Zm12 0a.75.75 0 0 1 .75-.75h1a.75.75 0 0 1 0 1.5h-1A.75.75 0 0 1 13 8ZM3.05 3.05a.75.75 0 0 1 1.06 0l.7.7a.75.75 0 0 1-1.06 1.07l-.7-.71a.75.75 0 0 1 0-1.06Zm8.14 8.14a.75.75 0 0 1 1.06 0l.7.7a.75.75 0 1 1-1.06 1.06l-.7-.7a.75.75 0 0 1 0-1.06Zm1.76-8.14a.75.75 0 0 1 0 1.06l-.7.71a.75.75 0 0 1-1.06-1.07l.7-.7a.75.75 0 0 1 1.06 0ZM4.81 11.19a.75.75 0 0 1 0 1.06l-.7.7A.75.75 0 0 1 3.05 11.9l.7-.7a.75.75 0 0 1 1.06 0Z'],
    moon: ['M6.2 2.1a.75.75 0 0 1 .1.9 4.75 4.75 0 0 0 6.5 6.5.75.75 0 0 1 1 1A6.25 6.25 0 1 1 5.3 2a.75.75 0 0 1 .9.1Z'],
    auto: ['M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 1.5v10a5 5 0 0 1 0-10Z'],
    folder: ['M2 4.75C2 4.34 2.34 4 2.75 4h3.5l1.5 1.5h5.5c.41 0 .75.34.75.75v6.5c0 .41-.34.75-.75.75H2.75a.75.75 0 0 1-.75-.75V4.75Z'],
    chevron: ['M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 1 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z'],
    link: ['M7.78 3.28a.75.75 0 0 0 1.06 1.06l1.25-1.25a2 2 0 1 1 2.83 2.83l-2.5 2.5a2 2 0 0 1-2.83 0 .75.75 0 0 0-1.06 1.06 3.5 3.5 0 0 0 4.95 0l2.5-2.5a3.5 3.5 0 0 0-4.95-4.95L7.78 3.28Zm-4.69 9.64a2 2 0 0 1 0-2.83l2.5-2.5a2 2 0 0 1 2.83 0 .75.75 0 0 0 1.06-1.06 3.5 3.5 0 0 0-4.95 0l-2.5 2.5a3.5 3.5 0 0 0 4.95 4.95l1.25-1.25a.75.75 0 1 0-1.06-1.06l-1.25 1.25a2 2 0 0 1-2.83 0Z'],
    palette: ['M8 1.5a6.5 6.5 0 0 0 0 13c.69 0 1.25-.56 1.25-1.25 0-.33-.13-.63-.34-.85a1.24 1.24 0 0 1 .9-2.1h1.44A3.25 3.25 0 0 0 14.5 7C14.5 3.96 11.58 1.5 8 1.5ZM4.75 8.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm1.75-3a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm3 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm2.5 2a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z'],
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
    const open = isDir && isFolderOpen(node.id);

    const row = document.createElement('div');
    row.className = 'file-row'
      + (ghost ? ' ghost' : '')
      + (isDir ? ' folder' : '')
      + (node.id === currentId ? ' active' : '');
    row.dataset.nodeId = node.id;
    row.dataset.nodeType = ghost ? 'ghost' : node.type;
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(depth + 1));
    if (isDir) row.setAttribute('aria-expanded', String(open));
    if (node.id === currentId) row.setAttribute('aria-selected', 'true');

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
    const hitCount = searchView ? searchView.hits.get(node.id) : 0;
    if (hitCount) {
      const badge = document.createElement('span');
      badge.className = 'file-hits';
      badge.textContent = String(hitCount);
      badge.title = `Совпадений в тексте: ${hitCount}`;
      main.appendChild(badge);
    }
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
      if (searchView && !searchView.visible.has(node.id)) continue;
      if (renameState && renameState.id === node.id) {
        host.appendChild(createRenameRow(node, depth));
      } else {
        host.appendChild(createNodeRow(node, depth, false));
      }
      if (node.type === 'folder' && isFolderOpen(node.id)) {
        renderBranch(node.id, depth + 1, host);
      }
    }
  }

  function renderFiles() {
    closeContextMenu();
    fileListEl.setAttribute('role', 'tree');
    fileListEl.setAttribute('aria-label', 'Файлы и папки');
    fileListEl.replaceChildren();

    const query = searchQuery.trim().toLowerCase();
    searchView = query ? computeSearchView(query) : null;

    if (searchView) {
      const found = searchView.visible.size;
      const summary = document.createElement('div');
      summary.className = 'search-summary';
      summary.textContent = found === 0
        ? 'Ничего не найдено'
        : `Найдено узлов: ${found}`;
      fileListEl.appendChild(summary);
      if (found === 0) return;
      renderBranch(ROOT_ID, 0, fileListEl);
      return;
    }

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
        ['Выгрузить в HTML', () => exportFileAsHtml(node.id), ''],
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
        ['Выгрузить в HTML', () => exportFileAsHtml(node.id), ''],
        ['—', null, ''],
        ['Удалить', () => confirmDelete(node.id), 'danger'],
      ];
    }

    contextMenu.replaceChildren();
    for (const [label, handler, kind] of actions) {
      if (label === '—') {
        const separator = document.createElement('hr');
        separator.setAttribute('role', 'separator');
        contextMenu.appendChild(separator);
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.setAttribute('role', 'menuitem');
      if (kind) button.className = kind;
      button.addEventListener('click', () => {
        closeContextMenu();
        handler();
      });
      contextMenu.appendChild(button);
    }
    contextMenu.hidden = false;
    menuOpener = document.activeElement;
    const rect = contextMenu.getBoundingClientRect();
    const clampedLeft = Math.min(left, window.innerWidth - rect.width - 8);
    const clampedTop = Math.min(top, window.innerHeight - rect.height - 8);
    contextMenu.style.left = Math.max(8, clampedLeft) + 'px';
    contextMenu.style.top = Math.max(8, clampedTop) + 'px';
    const first = contextMenu.querySelector('button');
    if (first) first.focus();
  }

  function closeContextMenu() {
    if (!contextMenu.hidden && menuOpener && menuOpener.focus
        && document.activeElement && contextMenu.contains(document.activeElement)) {
      menuOpener.focus();
    }
    menuOpener = null;
    contextMenu.hidden = true;
  }

  // Стрелки внутри меню: без них до пунктов можно добраться только мышью.
  contextMenu.addEventListener('keydown', (event) => {
    const items = Array.from(contextMenu.querySelectorAll('button'));
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(index + 1 + items.length) % items.length].focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length].focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      items[0].focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      items[items.length - 1].focus();
    }
  });

  document.addEventListener('pointerdown', (event) => {
    if (!contextMenu.hidden && !contextMenu.contains(event.target)) closeContextMenu();
  });

  // Стрелки по дереву файлов: раньше между строками можно было ходить только Tab,
  // перебирая по две кнопки на каждую.
  fileListEl.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(event.key)) return;
    const buttons = Array.from(fileListEl.querySelectorAll('.file-main-button'));
    if (buttons.length === 0) return;
    const index = buttons.indexOf(document.activeElement.closest('.file-row')
      ? document.activeElement.closest('.file-row').querySelector('.file-main-button')
      : null);
    if (index === -1) return;

    const row = buttons[index].closest('.file-row');
    const nodeId = row && row.dataset.nodeId;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      buttons[Math.min(index + 1, buttons.length - 1)].focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      buttons[Math.max(index - 1, 0)].focus();
    } else if (event.key === 'ArrowRight' && row.dataset.nodeType === 'folder') {
      event.preventDefault();
      if (!expandedFolders.has(nodeId)) toggleFolder(nodeId);
    } else if (event.key === 'ArrowLeft' && row.dataset.nodeType === 'folder') {
      event.preventDefault();
      if (expandedFolders.has(nodeId)) toggleFolder(nodeId);
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeContextMenu();
  });
  window.addEventListener('resize', closeContextMenu);

  // ---------- Диалог ----------

  let dialogDismiss = null;
  let menuOpener = null; // куда вернуть фокус после закрытия меню

  function showDialog(message, buttons) {
    return new Promise((resolve) => {
      dialogMessage.textContent = message;
      dialogButtons.replaceChildren();
      // фокус вернём туда, откуда диалог позвали
      const previousFocus = document.activeElement;

      const finish = (value) => {
        dialogOverlay.hidden = true;
        dialogDismiss = null;
        document.removeEventListener('keydown', onKey, true);
        if (previousFocus && previousFocus.focus) previousFocus.focus();
        resolve(value);
      };
      dialogDismiss = () => finish(null);

      const onKey = (event) => {
        if (event.key === 'Escape') { event.preventDefault(); finish(null); return; }
        if (event.key !== 'Tab') return;
        // Ловушка фокуса: без неё Tab уводит из модального окна в интерфейс под ним,
        // и с клавиатуры диалог перестаёт быть модальным.
        const focusable = Array.from(dialogButtons.querySelectorAll('button'));
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      };
      for (const spec of buttons) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = spec.label;
        button.className = spec.kind || 'secondary';
        button.addEventListener('click', () => finish(spec.value));
        dialogButtons.appendChild(button);
      }
      document.addEventListener('keydown', onKey, true);
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

  // ---------- Подсветка кода ----------

  // Свой разборщик вместо библиотеки: проект живёт без сборки, а готовые
  // подсветчики весят от 20 КБ в минимальной комплектации. Здесь несколько правил
  // на язык — этого хватает, чтобы код читался, и ничего не нужно тянуть извне.
  //
  // Правила пробуются по порядку и только с текущей позиции (флаг «y»), поэтому
  // порядок задаёт приоритет: комментарии и строки идут раньше всего остального,
  // иначе ключевое слово внутри строки подсветилось бы отдельно.

  const HIGHLIGHT_RULES = {};

  // Границы слова в регулярных выражениях JS считаются по ASCII: `\b` видит границу
  // между «т» и «s», поэтому «set» внутри «приветset» стал бы ключевым словом,
  // а «1» внутри «переменная1» — числом. Считаем границы по буквам любого алфавита.
  const EDGE_BEFORE = '(?<![\\p{L}\\p{N}_$])';
  const EDGE_AFTER = '(?![\\p{L}\\p{N}_$])';
  const word = (body) => EDGE_BEFORE + '(?:' + body + ')' + EDGE_AFTER;
  const IDENT = '[\\p{L}_$][\\p{L}\\p{N}_$]*';

  function rule(type, source, extraFlags) {
    return { type, re: new RegExp(source, 'y' + (extraFlags || '')) };
  }

  function defineLanguage(names, rules) {
    for (const name of names) HIGHLIGHT_RULES[name] = rules;
  }

  defineLanguage(['js', 'javascript', 'jsx', 'mjs', 'ts', 'typescript', 'tsx'], [
    rule('comment', '//[^\\n]*|/\\*[\\s\\S]*?\\*/'),
    rule('string', '`(?:[^`\\\\]|\\\\[\\s\\S])*`|"(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\''),
    rule('number', word('0[xXbBoO][0-9a-fA-F_]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?'), 'u'),
    rule('keyword', word('const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|typeof|instanceof|in|of|import|export|from|default|async|await|try|catch|finally|throw|delete|void|yield|static|get|set'), 'u'),
    rule('builtin', word('true|false|null|undefined|NaN|Infinity|console|document|window|Math|JSON|Object|Array|String|Number|Boolean|Promise|Set|Map|Symbol|RegExp|Error'), 'u'),
    rule('function', IDENT + '(?=\\s*\\()', 'u'),
    rule('operator', '=>|[+\\-*/%=<>!&|^~?:]+'),
  ]);

  defineLanguage(['json'], [
    rule('property', '"(?:[^"\\\\]|\\\\.)*"(?=\\s*:)'),
    rule('string', '"(?:[^"\\\\]|\\\\.)*"'),
    rule('number', '-?' + word('\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?'), 'u'),
    rule('builtin', word('true|false|null'), 'u'),
    rule('operator', '[{}\\[\\],:]'),
  ]);

  defineLanguage(['python', 'py'], [
    rule('comment', '#[^\\n]*'),
    rule('string', '"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|"(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\''),
    rule('number', word('\\d+(?:\\.\\d+)?'), 'u'),
    rule('keyword', word('def|class|return|if|elif|else|for|while|import|from|as|with|try|except|finally|raise|lambda|pass|break|continue|yield|global|nonlocal|assert|del|and|or|not|in|is|async|await'), 'u'),
    rule('builtin', word('None|True|False|self|print|len|range|dict|list|set|tuple|str|int|float|bool|open|enumerate|zip|map|filter|sorted|sum'), 'u'),
    rule('function', IDENT + '(?=\\s*\\()', 'u'),
  ]);

  defineLanguage(['bash', 'sh', 'shell', 'zsh', 'console'], [
    rule('comment', '#[^\\n]*'),
    rule('string', '"(?:[^"\\\\]|\\\\.)*"|\'[^\']*\''),
    rule('variable', '\\$\\{[^}]*\\}|\\$[A-Za-z_]\\w*|\\$[0-9@*?#]'),
    rule('keyword', word('if|then|else|elif|fi|for|while|until|do|done|case|esac|function|return|in|export|local|source|set|unset'), 'u'),
    rule('builtin', word('echo|cd|ls|cat|grep|sed|awk|find|curl|wget|mkdir|rm|cp|mv|chmod|touch|node|npm|npx|python3?|pip3?|git|docker|make'), 'u'),
    rule('number', word('\\d+'), 'u'),
  ]);

  defineLanguage(['html', 'xml', 'svg', 'vue'], [
    rule('comment', '<!--[\\s\\S]*?-->'),
    rule('tag', '</?[\\p{L}][\\p{L}\\p{N}:_-]*|/?>', 'u'),
    rule('string', '"[^"]*"|\'[^\']*\''),
    rule('attr', '[\\p{L}_:][\\p{L}\\p{N}:._-]*(?=\\s*=)', 'u'),
  ]);

  defineLanguage(['css', 'scss', 'less'], [
    rule('comment', '/\\*[\\s\\S]*?\\*/'),
    rule('string', '"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\''),
    rule('keyword', '@[a-zA-Z-]+'),
    rule('attr', '--[\\w-]+'),
    rule('number', '#[0-9a-fA-F]{3,8}' + EDGE_AFTER + '|-?' + word('\\d+(?:\\.\\d+)?(?:px|em|rem|%|vh|vw|ch|s|ms|deg|fr)?'), 'u'),
    rule('property', '[a-z-]+(?=\\s*:)'),
    rule('tag', '\\.[\\p{L}_][\\p{L}\\p{N}_-]*|::?[a-z-]+', 'u'),
  ]);

  defineLanguage(['sql'], [
    rule('comment', '--[^\\n]*|/\\*[\\s\\S]*?\\*/'),
    rule('string', '\'(?:[^\']|\'\')*\''),
    rule('keyword', word('SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|INDEX|VIEW|DROP|ALTER|ADD|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|ON|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|AS|AND|OR|NOT|NULL|IS|IN|BETWEEN|LIKE|PRIMARY|KEY|FOREIGN|REFERENCES|UNIQUE|DEFAULT|DISTINCT|COUNT|SUM|AVG|MIN|MAX|CASE|WHEN|THEN|ELSE|END|UNION|ALL|EXISTS'), 'iu'),
    rule('number', word('\\d+(?:\\.\\d+)?'), 'u'),
  ]);

  function tokenizeCode(code, rules) {
    const tokens = [];
    let index = 0;
    while (index < code.length) {
      let hit = null;
      for (const item of rules) {
        item.re.lastIndex = index;
        const match = item.re.exec(code);
        if (match && match[0].length > 0) { hit = { type: item.type, text: match[0] }; break; }
      }
      if (hit) {
        tokens.push(hit);
        index += hit.text.length;
        continue;
      }
      // обычный текст копим одним куском, чтобы не плодить узлы
      const last = tokens[tokens.length - 1];
      if (last && last.type === null) last.text += code[index];
      else tokens.push({ type: null, text: code[index] });
      index += 1;
    }
    return tokens;
  }

  function highlightCode(codeEl) {
    const match = (codeEl.className || '').match(/language-([\w+#.-]+)/);
    if (!match) return;
    const rules = HIGHLIGHT_RULES[match[1].toLowerCase()];
    if (!rules) return;
    const source = codeEl.textContent || '';
    if (!source || source.length > HIGHLIGHT_MAX) return;

    const fragment = document.createDocumentFragment();
    for (const token of tokenizeCode(source, rules)) {
      if (!token.type) {
        fragment.appendChild(document.createTextNode(token.text));
        continue;
      }
      const span = document.createElement('span');
      span.className = 'tok-' + token.type;
      // только textContent: разметка отсюда взяться не может по построению
      span.textContent = token.text;
      fragment.appendChild(span);
    }
    codeEl.replaceChildren(fragment);
  }

  // <pre> прокручивается по горизонтали, поэтому кнопку вешаем не внутрь него,
  // а на обёртку — иначе она уезжает вместе с длинной строкой кода
  function decorateCodeBlocks(root) {
    for (const pre of Array.from(root.querySelectorAll('pre'))) {
      const code = pre.querySelector('code');
      if (code) highlightCode(code);
      const wrapper = document.createElement('div');
      wrapper.className = 'code-block';
      if (pre.dataset.line) {
        wrapper.dataset.line = pre.dataset.line;
        delete pre.dataset.line;
      }
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

  // Соответствие «строка исходника → пиксели» в обеих панелях. Проценты прокрутки
  // тут не годятся: длинный блок кода занимает много строк исходника и мало высоты
  // в превью, картинка — наоборот, и панели быстро расходятся.
  let scrollMap = [];
  let syncingScroll = false;
  let previewToken = 0; // отменяет отложенные пересчёты при смене файла

  const editorMirror = document.createElement('div');
  editorMirror.className = 'editor-mirror';
  editorMirror.setAttribute('aria-hidden', 'true');
  document.body.appendChild(editorMirror);

  function scrollMax(el) {
    return el.scrollHeight - el.clientHeight;
  }

  function countNewlines(text) {
    let count = 0;
    for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) count += 1;
    return count;
  }

  // Где в превью начинается блок каждой размеченной строки, в координатах прокрутки панели.
  function collectPreviewAnchors() {
    const anchors = [];
    const paneTop = previewPane.getBoundingClientRect().top;
    const offset = previewPane.scrollTop;
    for (const node of previewBody.querySelectorAll('[data-line]')) {
      const line = Number(node.dataset.line);
      if (!Number.isFinite(line)) continue;
      anchors.push({ line, top: node.getBoundingClientRect().top - paneTop + offset });
    }
    return anchors;
  }

  // Где в редакторе начинается строка. Textarea не умеет отвечать на этот вопрос:
  // после мягкого переноса номер строки и номер экранного ряда расходятся. Меряем
  // на скрытой копии с теми же метриками, ставя метки только в нужных строках —
  // их десятки, а не тысячи.
  function measureSourceOffsets(source, lines) {
    const wanted = new Set(lines);
    const style = window.getComputedStyle(editorEl);
    for (const property of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight',
      'letterSpacing', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) {
      editorMirror.style[property] = style[property];
    }
    editorMirror.style.width = editorEl.clientWidth + 'px';

    const sourceLines = source.split('\n');
    const fragment = document.createDocumentFragment();
    const markers = new Map();
    let buffer = '';
    for (let i = 0; i < sourceLines.length; i += 1) {
      if (wanted.has(i)) {
        if (buffer) { fragment.appendChild(document.createTextNode(buffer)); buffer = ''; }
        const marker = document.createElement('span');
        marker.textContent = '​'; // нулевая ширина — перенос строк не меняется
        fragment.appendChild(marker);
        markers.set(i, marker);
      }
      buffer += sourceLines[i] + '\n';
    }
    if (buffer) fragment.appendChild(document.createTextNode(buffer));
    editorMirror.replaceChildren(fragment);

    const base = editorMirror.getBoundingClientRect().top;
    const offsets = new Map();
    for (const [line, marker] of markers) {
      offsets.set(line, marker.getBoundingClientRect().top - base);
    }
    editorMirror.replaceChildren();
    return offsets;
  }

  function rebuildScrollMap(source) {
    scrollMap = [];
    if (settings.mode !== 'split') return;
    const anchors = collectPreviewAnchors();
    if (anchors.length === 0) return;
    const offsets = measureSourceOffsets(source, anchors.map((a) => a.line));
    for (const anchor of anchors) {
      const editorTop = offsets.get(anchor.line);
      if (editorTop === undefined) continue;
      scrollMap.push({ editorTop, previewTop: anchor.top });
    }
    scrollMap.sort((a, b) => a.editorTop - b.editorTop);
    if (scrollMap.length === 0) return;

    // Закрепляем концы диапазона. Без этого нулевая прокрутка редактора
    // отображалась бы в позицию первого блока превью, то есть панель прыгала бы
    // на величину своего верхнего отступа; а низ одной панели не совпадал бы с низом другой.
    if (scrollMap[0].editorTop > 0 || scrollMap[0].previewTop > 0) {
      scrollMap.unshift({ editorTop: 0, previewTop: 0 });
    }
    const editorEnd = Math.max(0, scrollMax(editorEl));
    const previewEnd = Math.max(0, scrollMax(previewPane));
    const last = scrollMap[scrollMap.length - 1];
    if (editorEnd > last.editorTop && previewEnd > last.previewTop) {
      scrollMap.push({ editorTop: editorEnd, previewTop: previewEnd });
    }
  }

  // Линейная интерполяция между соседними якорями; за последним — просто сдвиг.
  function mapScroll(value, fromKey, toKey) {
    if (scrollMap.length === 0) return null;
    if (scrollMap.length === 1 || value <= scrollMap[0][fromKey]) return scrollMap[0][toKey];
    for (let i = 1; i < scrollMap.length; i += 1) {
      if (value <= scrollMap[i][fromKey]) {
        const span = scrollMap[i][fromKey] - scrollMap[i - 1][fromKey];
        const ratio = span > 0 ? (value - scrollMap[i - 1][fromKey]) / span : 0;
        return scrollMap[i - 1][toKey] + (scrollMap[i][toKey] - scrollMap[i - 1][toKey]) * ratio;
      }
    }
    const last = scrollMap[scrollMap.length - 1];
    return last[toKey] + (value - last[fromKey]);
  }

  function syncScroll(sourcePane) {
    if (settings.mode !== 'split' || syncingScroll) return;
    const target = sourcePane === 'editor'
      ? mapScroll(editorEl.scrollTop, 'editorTop', 'previewTop')
      : mapScroll(previewPane.scrollTop, 'previewTop', 'editorTop');
    if (target === null) return;
    syncingScroll = true;
    if (sourcePane === 'editor') {
      previewPane.scrollTop = Math.max(0, Math.min(target, scrollMax(previewPane)));
    } else {
      editorEl.scrollTop = Math.max(0, Math.min(target, scrollMax(editorEl)));
    }
    window.requestAnimationFrame(() => { syncingScroll = false; });
  }

  previewPane.addEventListener('scroll', () => {
    if (previewPane.hidden) return;
    const max = scrollMax(previewPane);
    if (max > 0) previewScrollRatio = previewPane.scrollTop / max;
    syncScroll('preview');
  });

  editorEl.addEventListener('scroll', () => {
    if (editorPane.hidden) return;
    const max = scrollMax(editorEl);
    if (max > 0) editorScrollRatio = editorEl.scrollTop / max;
    editorHighlightLayer.scrollTop = editorEl.scrollTop;
    syncScroll('editor');
  });

  function renderMain() {
    const file = fileById(currentId);
    const hasFile = Boolean(file);
    const split = settings.mode === 'split';
    welcomePane.hidden = hasFile;
    previewPane.hidden = !hasFile || settings.mode === 'editor';
    editorPane.hidden = !hasFile || settings.mode === 'preview';
    splitResizer.hidden = !hasFile || !split;
    if (!hasFile) return;

    if (settings.mode !== 'preview') {
      if (lastEditorFileId !== file.id) {
        editorScrollRatio = 0;
        lastEditorFileId = file.id;
      }
      if (editorEl.value !== file.content) editorEl.value = file.content;
      editorEl.scrollTop = editorScrollRatio * Math.max(0, scrollMax(editorEl));
      updateHighlightLayer();
    }
    if (settings.mode !== 'editor') renderPreview(file);
  }

  // Идентификаторы заголовков нужны и оглавлению, и ссылкам-якорям.
  // Совпадающие названия разводим числовым хвостом.
  function assignHeadingIds(root) {
    const used = new Set();
    for (const heading of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      const base = slugify(heading.textContent || '');
      let id = base;
      let n = 2;
      while (used.has(id)) { id = base + '-' + n; n += 1; }
      used.add(id);
      heading.id = id;
      // запоминаем текст до вставки якоря: иначе его решётка уедет в оглавление
      heading.dataset.tocText = heading.textContent || '';

      const anchor = document.createElement('a');
      anchor.className = 'heading-anchor';
      anchor.href = '#' + id;
      anchor.textContent = '#';
      anchor.setAttribute('aria-label', 'Ссылка на раздел');
      anchor.addEventListener('click', (event) => {
        event.preventDefault();
        const offset = heading.getBoundingClientRect().top
          - previewPane.getBoundingClientRect().top + previewPane.scrollTop;
        previewPane.scrollTop = Math.max(0, offset - 12);
      });
      heading.appendChild(anchor);
    }
  }

  function renderPreview(file) {
    const source = file.content || '';
    const token = ++previewToken;
    previewBody.replaceChildren();

    let tokens = null;
    try {
      tokens = window.marked.lexer(source);
    } catch (error) {
      console.error(error);
      previewBody.textContent = 'Не удалось разобрать Markdown.';
      return;
    }

    // Рендерим блоками верхнего уровня, а не всё разом: только так у каждого
    // элемента появляется строка исходника, на которой держится синхронная прокрутка.
    // Номер строки ищем поиском raw в исходнике, а не сложением длин: определения
    // ссылок в токены не попадают, и простое сложение уехало бы после первого же.
    let cursor = 0;
    let line = 0;
    for (const item of tokens) {
      const found = source.indexOf(item.raw, cursor);
      const start = found >= 0 ? found : cursor;
      line += countNewlines(source.slice(cursor, start));
      cursor = start + item.raw.length;

      if (item.type !== 'space') {
        let html = '';
        try {
          const single = [item];
          single.links = tokens.links;
          html = window.marked.parser(single);
        } catch (error) {
          console.error(error);
        }
        if (html) {
          const doc = parseSafeDocument(html);
          const nodes = Array.from(doc.body.childNodes);
          for (const node of nodes) {
            if (node.nodeType === Node.ELEMENT_NODE) node.dataset.line = String(line);
          }
          previewBody.append(...nodes);
        }
      }
      line += countNewlines(item.raw);
    }

    for (const link of previewBody.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href') || '';
      if (/^https?:/i.test(href)) {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
    }
    decorateCodeBlocks(previewBody);
    assignHeadingIds(previewBody);
    applyTocVisibility();
    if (findQuery && settings.mode === 'preview') {
      findMarks = markMatches(previewBody, findQuery);
      updateFindCount();
    }

    if (lastPreviewFileId !== file.id) {
      previewScrollRatio = 0;
      lastPreviewFileId = file.id;
    }

    const settle = () => {
      if (token !== previewToken) return; // файл уже сменился
      rebuildScrollMap(source);
      previewPane.scrollTop = previewScrollRatio * Math.max(0, scrollMax(previewPane));
    };
    settle();

    // Сразу после вставки высота занижена: шрифты и картинки ещё не загружены,
    // и восстановленная позиция чтения уезжает. Повторяем, когда они доедут.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(settle).catch(() => {});
    }
    for (const image of previewBody.querySelectorAll('img')) {
      if (!image.complete) {
        image.addEventListener('load', settle, { once: true });
        image.addEventListener('error', settle, { once: true });
      }
    }
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
    updateDocBar();
    setSidebarOpen(false); // на узком экране панель выдвижная: выбрали файл — закрыли
    scheduleAutosave();
  }

  // ---------- Тема ----------

  // Автоматический режим разрешаем в JS и кладём на корень уже готовое значение:
  // так в стилях остаётся один набор переопределений вместо двух — под медиа-запрос
  // системного предпочтения и под явный выбор.
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  function resolvedTheme() {
    if (settings.theme === 'light' || settings.theme === 'dark') return settings.theme;
    return darkQuery.matches ? 'dark' : 'light';
  }

  function applyTheme() {
    const theme = resolvedTheme();
    document.documentElement.dataset.theme = theme;
    const icons = { auto: 'auto', light: 'sun', dark: 'moon' };
    const labels = {
      auto: 'Тема: как в системе',
      light: 'Тема: светлая',
      dark: 'Тема: тёмная',
    };
    themeButton.replaceChildren(createIcon(icons[settings.theme], 16));
    themeButton.title = labels[settings.theme] + ' (нажмите, чтобы сменить)';
    themeButton.setAttribute('aria-label', labels[settings.theme]);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#ffffff' : '#07090f');
  }

  darkQuery.addEventListener('change', () => {
    if (settings.theme === 'auto') applyTheme();
  });

  themeButton.addEventListener('click', () => {
    const next = THEMES[(THEMES.indexOf(settings.theme) + 1) % THEMES.length];
    settings.theme = next;
    saveSettings();
    applyTheme();
  });

  // ---------- Сведения о документе ----------

  function countWords(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).length;
  }

  function hasUnsavedChanges() {
    return dirtyFileIds.size > 0 || removedFileIds.size > 0 || metaDirty;
  }

  function updateDocBar() {
    const file = fileById(currentId);
    if (!file) {
      docPath.textContent = '';
      docSave.textContent = '';
      docSave.className = 'doc-save';
      docStats.textContent = '';
      return;
    }
    const path = file.id === WELCOME_ID ? file.name : pathOf(file);
    docPath.textContent = path;
    docPath.title = path;

    const dirty = hasUnsavedChanges();
    docSave.textContent = dirty ? 'есть несохранённые' : 'сохранено';
    docSave.className = 'doc-save' + (dirty ? ' dirty' : '');

    const words = countWords(file.content);
    const minutes = Math.max(1, Math.round(words / READING_SPEED));
    docStats.textContent = words === 0
      ? 'пусто'
      : `${words} ${plural(words, 'слово', 'слова', 'слов')} · ~${minutes} мин чтения`;
  }

  function plural(count, one, few, many) {
    const mod100 = count % 100;
    if (mod100 >= 11 && mod100 <= 14) return many;
    const mod10 = count % 10;
    if (mod10 === 1) return one;
    if (mod10 >= 2 && mod10 <= 4) return few;
    return many;
  }

  // ---------- Поиск внутри документа ----------

  // Отмечать совпадения умеет один и тот же обход: и в превью, и в слое подсветки
  // редактора. Textarea покрасить нельзя, но слой лежит ровно поверх её текста,
  // поэтому метка попадает туда, где буквы и находятся.
  let findQuery = '';
  let findMarks = [];
  let findIndex = 0;

  function clearMarks(root) {
    for (const mark of Array.from(root.querySelectorAll('mark.find-hit'))) {
      const parent = mark.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize();
    }
  }

  function markMatches(root, query) {
    clearMarks(root);
    if (!query) return [];
    const needle = query.toLowerCase();
    const found = [];

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const targets = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      // подписи кнопок копирования — не текст документа
      if (node.parentElement && node.parentElement.closest('.code-copy')) continue;
      if ((node.nodeValue || '').toLowerCase().includes(needle)) targets.push(node);
    }

    for (const node of targets) {
      let current = node;
      let index = (current.nodeValue || '').toLowerCase().indexOf(needle);
      while (index !== -1) {
        const matched = current.splitText(index);
        current = matched.splitText(needle.length);
        const mark = document.createElement('mark');
        mark.className = 'find-hit';
        mark.textContent = matched.nodeValue;
        matched.parentNode.replaceChild(mark, matched);
        found.push(mark);
        index = (current.nodeValue || '').toLowerCase().indexOf(needle);
      }
    }
    return found;
  }

  // В режиме просмотра ищем по превью, иначе по редактору.
  function findRoot() {
    if (settings.mode === 'preview') return previewBody;
    return settings.editorHighlight ? editorHighlightLayer : null;
  }

  function refreshFindMarks() {
    // Снимаем метки в обеих панелях: активная могла смениться вместе с режимом,
    // и в скрытой остался бы мусор.
    clearMarks(previewBody);
    clearMarks(editorHighlightLayer);
    if (!findQuery) { findMarks = []; return; }
    const root = findRoot();
    findMarks = root ? markMatches(root, findQuery) : [];
  }

  function updateFindCount() {
    if (!findQuery) { findCount.textContent = ''; return; }
    if (findMarks.length === 0 && findRoot()) { findCount.textContent = 'нет совпадений'; return; }
    if (!findRoot()) {
      // подсветка редактора выключена — красить негде, работаем выделением
      const total = countOccurrences(editorEl.value.toLowerCase(), findQuery.toLowerCase());
      findCount.textContent = total === 0 ? 'нет совпадений' : `${findIndex + 1} из ${total}`;
      return;
    }
    findCount.textContent = `${findIndex + 1} из ${findMarks.length}`;
  }

  function scrollToCurrentMatch() {
    const root = findRoot();
    if (!root) {
      // запасной путь: выделяем в самом поле и подводим прокрутку к нужной строке
      const value = editorEl.value;
      const needle = findQuery.toLowerCase();
      const positions = [];
      let at = value.toLowerCase().indexOf(needle);
      while (at !== -1) { positions.push(at); at = value.toLowerCase().indexOf(needle, at + needle.length); }
      if (positions.length === 0) return;
      findIndex = ((findIndex % positions.length) + positions.length) % positions.length;
      const start = positions[findIndex];
      editorEl.setSelectionRange(start, start + findQuery.length);
      const line = countNewlines(value.slice(0, start));
      const offsets = measureSourceOffsets(value, [line]);
      const top = offsets.get(line);
      if (top !== undefined) editorEl.scrollTop = Math.max(0, top - editorEl.clientHeight / 3);
      return;
    }

    if (findMarks.length === 0) return;
    findIndex = ((findIndex % findMarks.length) + findMarks.length) % findMarks.length;
    for (const mark of findMarks) mark.classList.remove('current');
    const mark = findMarks[findIndex];
    mark.classList.add('current');

    if (root === previewBody) {
      const top = mark.getBoundingClientRect().top - previewPane.getBoundingClientRect().top
        + previewPane.scrollTop;
      previewPane.scrollTop = Math.max(0, top - previewPane.clientHeight / 3);
      return;
    }
    const top = mark.getBoundingClientRect().top - editorHighlightLayer.getBoundingClientRect().top
      + editorHighlightLayer.scrollTop;
    editorEl.scrollTop = Math.max(0, top - editorEl.clientHeight / 3);
  }

  function runFind(resetIndex) {
    findQuery = findInput.value;
    if (resetIndex) findIndex = 0;
    refreshFindMarks();
    updateFindCount();
    if (findQuery) scrollToCurrentMatch();
    updateFindCount();
  }

  function openFind() {
    findBar.hidden = false;
    findInput.focus();
    findInput.select();
    if (findInput.value) runFind(true);
  }

  function closeFind() {
    findBar.hidden = true;
    findQuery = '';
    findIndex = 0;
    clearMarks(previewBody);
    clearMarks(editorHighlightLayer);
    findMarks = [];
    findCount.textContent = '';
  }

  function stepFind(delta) {
    if (!findQuery) return;
    findIndex += delta;
    scrollToCurrentMatch();
    updateFindCount();
  }

  findInput.addEventListener('input', () => runFind(true));
  findInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); stepFind(event.shiftKey ? -1 : 1); }
    if (event.key === 'Escape') { event.preventDefault(); closeFind(); }
  });
  findPrev.addEventListener('click', () => stepFind(-1));
  findNext.addEventListener('click', () => stepFind(1));
  findClose.addEventListener('click', closeFind);

  // ---------- Оглавление ----------

  function slugify(text) {
    return text.toLowerCase().trim()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'раздел';
  }

  function buildToc() {
    tocList.replaceChildren();
    const headings = Array.from(previewBody.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    if (headings.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'toc-empty';
      empty.textContent = 'В документе нет заголовков';
      tocList.appendChild(empty);
      return;
    }
    const top = Math.min(...headings.map((node) => Number(node.tagName.slice(1))));
    for (const heading of headings) {
      const level = Number(heading.tagName.slice(1));
      const link = document.createElement('a');
      link.className = 'toc-link';
      link.href = '#' + heading.id;
      link.textContent = heading.dataset.tocText || heading.textContent;
      link.style.paddingLeft = (10 + (level - top) * 12) + 'px';
      link.addEventListener('click', (event) => {
        // внутренняя навигация: незачем плодить записи в истории браузера
        event.preventDefault();
        const offset = heading.getBoundingClientRect().top
          - previewPane.getBoundingClientRect().top + previewPane.scrollTop;
        previewPane.scrollTop = Math.max(0, offset - 12);
      });
      tocList.appendChild(link);
    }
  }

  function applyTocVisibility() {
    const visible = settings.toc && settings.mode !== 'editor' && Boolean(fileById(currentId));
    tocPanel.hidden = !visible;
    document.body.classList.toggle('toc-open', visible);
    tocButton.setAttribute('aria-pressed', String(settings.toc));
    tocButton.classList.toggle('active', settings.toc);
    if (visible) buildToc();
  }

  tocButton.addEventListener('click', () => {
    settings.toc = !settings.toc;
    saveSettings();
    applyTocVisibility();
  });

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

  // JSZip нужен ровно на две кнопки, а весит около 98 КБ. Держать его в начальной
  // загрузке ради этого незачем — подтягиваем при первом обращении.
  let jszipPromise = null;
  function loadJsZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    if (!jszipPromise) {
      jszipPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = APP_BASE + 'vendor/jszip.min.js';
        script.onload = () => resolve(window.JSZip);
        script.onerror = () => { jszipPromise = null; reject(new Error('JSZip не загрузился')); };
        document.head.appendChild(script);
      });
    }
    return jszipPromise;
  }

  async function downloadAllZip() {
    if (files.length === 0 && folders.length === 0) {
      setStatus('Нет файлов для скачивания');
      return;
    }
    flushEditor();
    setStatus('Готовим архив…', true);
    let JSZipCtor;
    try {
      JSZipCtor = await loadJsZip();
    } catch (error) {
      console.error(error);
      setStatus('Не удалось загрузить упаковщик архива', true);
      return;
    }
    const zip = new JSZipCtor();
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
    setStatus('Готовим архив…', true);
    let JSZipCtor;
    try {
      JSZipCtor = await loadJsZip();
    } catch (error) {
      console.error(error);
      setStatus('Не удалось загрузить упаковщик архива', true);
      return;
    }
    const zip = new JSZipCtor();
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

  // ---------- Экспорт в HTML ----------

  // Самодостаточный файл: разметка превью плюс небольшой собственный стиль.
  // Тянуть сюда css/style.css целиком незачем — там девять десятых про интерфейс,
  // которого в выгрузке нет.
  const EXPORT_STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 40px 20px 80px;
  background: #ffffff;
  color: #24292f;
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 17px;
  line-height: 1.65;
}
main { max-width: 46em; margin: 0 auto; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.5em 0 .6em; }
h1 { font-size: 1.9em; padding-bottom: .3em; border-bottom: 1px solid #d8dee4; }
h2 { font-size: 1.5em; padding-bottom: .25em; border-bottom: 1px solid #d8dee4; }
p, ul, ol, blockquote, pre, table { margin: 0 0 1em; }
ul, ol { padding-left: 1.7em; }
a { color: #0a58ca; }
blockquote {
  padding: .4em 1.1em; color: #57606a;
  border-left: 3px solid #d0d7de; background: #f6f8fa;
}
code {
  font-family: 'Source Code Pro', Consolas, monospace; font-size: .86em;
  padding: .15em .4em; background: #f0f2f5; border: 1px solid #dfe3e8; border-radius: 4px;
}
pre {
  padding: 1em 1.2em; overflow-x: auto;
  background: #f6f8fa; border: 1px solid #dfe3e8; border-radius: 8px;
}
pre code { padding: 0; background: none; border: 0; }
table { border-collapse: collapse; }
th, td { padding: .4em .9em; border: 1px solid #d0d7de; }
th { background: #f0f2f5; }
img { max-width: 100%; }
hr { border: 0; border-top: 1px solid #d0d7de; margin: 1.8em 0; }
@media (prefers-color-scheme: dark) {
  body { background: #0d1117; color: #c9d1d9; }
  h1, h2 { border-bottom-color: #30363d; }
  a { color: #79c0ff; }
  blockquote { color: #8b949e; border-left-color: #30363d; background: #161b22; }
  code, pre { background: #161b22; border-color: #30363d; }
  th, td { border-color: #30363d; }
  th { background: #161b22; }
  hr { border-top-color: #30363d; }
}
`;

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function exportFileAsHtml(id) {
    const file = fileById(id);
    if (!file) return;
    flushEditor();

    // Рендерим отдельно от экрана и через тот же санитайзер: в выгрузку не должно
    // попасть ничего, чего не пропустили бы в превью.
    let html = '';
    try {
      html = window.marked.parse(file.content || '');
    } catch (error) {
      console.error(error);
      setStatus('Не удалось разобрать Markdown');
      return;
    }
    const doc = parseSafeDocument(html);
    for (const node of doc.body.querySelectorAll('pre > code')) highlightCodeForExport(node);

    const { stem } = splitName(file.name);
    const page = '<!DOCTYPE html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
      + `<title>${escapeHtml(stem)}</title>\n<style>${EXPORT_STYLE}</style>\n`
      + `</head>\n<body>\n<main>\n${doc.body.innerHTML}\n</main>\n</body>\n</html>\n`;

    downloadBlob(new Blob([page], { type: 'text/html;charset=utf-8' }), stem + '.html');
    setStatus(`Выгружено в HTML: ${stem}.html`);
  }

  // В выгрузке подсветка должна быть самодостаточной, поэтому цвета идут
  // инлайновым стилем, а не классами из таблицы приложения.
  const EXPORT_TOKEN_COLORS = {
    comment: '#6a737d', string: '#1a7f37', number: '#a4501a', keyword: '#1f5fd0',
    builtin: '#0f7c8a', function: '#7b3fbf', tag: '#b03028', attr: '#a4501a',
    property: '#175bb5', variable: '#955122', operator: '#4b5563',
  };

  function highlightCodeForExport(codeEl) {
    const match = (codeEl.className || '').match(/language-([\w+#.-]+)/);
    if (!match) return;
    const rules = HIGHLIGHT_RULES[match[1].toLowerCase()];
    if (!rules) return;
    const source = codeEl.textContent || '';
    if (!source || source.length > HIGHLIGHT_MAX) return;

    const fragment = document.createDocumentFragment();
    for (const token of tokenizeCode(source, rules)) {
      if (!token.type) {
        fragment.appendChild(document.createTextNode(token.text));
        continue;
      }
      const span = document.createElement('span');
      const color = EXPORT_TOKEN_COLORS[token.type];
      if (color) span.style.color = color;
      if (token.type === 'comment') span.style.fontStyle = 'italic';
      span.textContent = token.text;
      fragment.appendChild(span);
    }
    codeEl.replaceChildren(fragment);
  }

  // ---------- Печать ----------

  // Печатается только превью, поэтому в режиме редактора его сперва надо отрисовать.
  function printDocument() {
    const file = fileById(currentId);
    if (!file) { setStatus('Нечего печатать: файл не открыт'); return; }
    flushEditor();
    if (settings.mode === 'editor') renderPreview(file);
    window.setTimeout(() => window.print(), 60);
  }

  // ---------- Сайдбар на узком экране ----------

  function setSidebarOpen(open) {
    document.body.classList.toggle('sidebar-open', open);
    sidebarToggle.setAttribute('aria-expanded', String(open));
    sidebarBackdrop.hidden = !open;
  }

  sidebarToggle.addEventListener('click', () => {
    setSidebarOpen(!document.body.classList.contains('sidebar-open'));
  });
  sidebarBackdrop.addEventListener('click', () => setSidebarOpen(false));

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
      const failed = (error) => {
        console.error(error);
        setStatus('Не удалось загрузить файлы', true);
      };
      if (entries.length > 0) {
        loadDroppedEntries(entries, target.parentId).catch(failed);
      } else {
        const plain = Array.from((event.dataTransfer && event.dataTransfer.files) || [])
          .map((file) => ({ file, segments: [] }));
        loadExternalFiles(plain, target.parentId).catch(failed);
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

  // С клавиатуры ширина панели раньше не менялась вовсе: узел не получал фокус.
  sidebarResizer.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 40 : 10;
    let next = settings.sidebarWidth;
    if (event.key === 'ArrowLeft') next -= step;
    else if (event.key === 'ArrowRight') next += step;
    else if (event.key === 'Home') next = SIDEBAR_MIN;
    else if (event.key === 'End') next = SIDEBAR_MAX;
    else if (event.key === 'Enter') next = DEFAULT_SETTINGS.sidebarWidth;
    else return;
    event.preventDefault();
    settings.sidebarWidth = clamp(next, SIDEBAR_MIN, SIDEBAR_MAX);
    document.documentElement.style.setProperty('--sidebar-width', settings.sidebarWidth + 'px');
    sidebarResizer.setAttribute('aria-valuenow', String(settings.sidebarWidth));
    saveSettings();
  });

  sidebarResizer.addEventListener('dblclick', () => {
    settings.sidebarWidth = DEFAULT_SETTINGS.sidebarWidth;
    saveSettings();
    applySettings();
  });

  // ---------- Редактор ----------

  function flushEditor() {
    const file = fileById(currentId);
    if (!file || settings.mode === 'preview') return;
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
    scheduleHighlight();
    updateDocBar();
    if (settings.mode === 'split') schedulePreviewRefresh(file);
  });

  // Перерисовка превью на каждый символ была бы расточительной, поэтому в режиме
  // «Вместе» она идёт с небольшой задержкой — заметно быстрее автосохранения.
  let previewRefreshTimer = null;
  function schedulePreviewRefresh(file) {
    window.clearTimeout(previewRefreshTimer);
    previewRefreshTimer = window.setTimeout(() => {
      if (fileById(currentId) === file && settings.mode === 'split') renderPreview(file);
    }, PREVIEW_REFRESH_MS);
  }

  // ---------- Правка текста ----------

  // Любая правка идёт через execCommand('insertText'): это единственный способ
  // изменить textarea, не сломав родную историю отмены. Метод объявлен устаревшим,
  // но замены для этой задачи в браузерах нет.
  function replaceSelection(text) {
    editorEl.focus();
    document.execCommand('insertText', false, text);
  }

  function selectionRange() {
    return { start: editorEl.selectionStart, end: editorEl.selectionEnd };
  }

  function lineBoundsAt(index) {
    const value = editorEl.value;
    const start = value.lastIndexOf('\n', index - 1) + 1;
    let end = value.indexOf('\n', index);
    if (end === -1) end = value.length;
    return { start, end };
  }

  // Обёртка парными метками: снимается и когда метки внутри выделения,
  // и когда выделено только то, что между ними.
  function toggleWrap(marker, placeholder) {
    const value = editorEl.value;
    const { start, end } = selectionRange();
    const selected = value.slice(start, end);

    const outerBefore = value.slice(Math.max(0, start - marker.length), start);
    const outerAfter = value.slice(end, end + marker.length);
    if (outerBefore === marker && outerAfter === marker) {
      editorEl.setSelectionRange(start - marker.length, end + marker.length);
      replaceSelection(selected);
      editorEl.setSelectionRange(start - marker.length, start - marker.length + selected.length);
      return;
    }

    if (selected.length >= marker.length * 2
        && selected.startsWith(marker) && selected.endsWith(marker)) {
      const inner = selected.slice(marker.length, selected.length - marker.length);
      replaceSelection(inner);
      editorEl.setSelectionRange(start, start + inner.length);
      return;
    }

    const body = selected || placeholder;
    replaceSelection(marker + body + marker);
    editorEl.setSelectionRange(start + marker.length, start + marker.length + body.length);
  }

  function insertLink() {
    const value = editorEl.value;
    const { start, end } = selectionRange();
    const selected = value.slice(start, end).trim();
    // выделили адрес — подставляем его, курсор уводим в подпись
    if (selected && /^(https?:\/\/|mailto:|tel:|#|\.{0,2}\/)\S*$/i.test(selected)) {
      const label = 'текст ссылки';
      replaceSelection(`[${label}](${selected})`);
      editorEl.setSelectionRange(start + 1, start + 1 + label.length);
      return;
    }
    const label = value.slice(start, end) || 'текст ссылки';
    const target = 'https://';
    replaceSelection(`[${label}](${target})`);
    const caret = start + label.length + 3 + target.length;
    editorEl.setSelectionRange(caret, caret);
  }

  const LINE_PREFIXES = {
    heading: { pattern: /^#{1,6}\s+/, make: () => '## ' },
    quote: { pattern: /^>\s?/, make: () => '> ' },
    bullet: { pattern: /^[-*+]\s+(\[[ xX]\]\s+)?/, make: () => '- ' },
    ordered: { pattern: /^\d+[.)]\s+/, make: (n) => n + '. ' },
  };

  function toggleLinePrefix(kind) {
    const spec = LINE_PREFIXES[kind];
    const value = editorEl.value;
    const { start, end } = selectionRange();
    const first = lineBoundsAt(start).start;
    const last = lineBoundsAt(end).end;
    const block = value.slice(first, last);
    const lines = block.split('\n');

    // между собой списки взаимозаменяемы, поэтому чужой маркер снимаем
    const foreign = kind === 'bullet' ? LINE_PREFIXES.ordered.pattern
      : kind === 'ordered' ? LINE_PREFIXES.bullet.pattern : null;

    const meaningful = lines.filter((line) => line.trim() !== '');
    const allHave = meaningful.length > 0
      && meaningful.every((line) => spec.pattern.test(line.replace(/^\s*/, '')));

    let counter = 0;
    const next = lines.map((line) => {
      const indent = (line.match(/^\s*/) || [''])[0];
      let body = line.slice(indent.length).replace(spec.pattern, '');
      if (foreign) body = body.replace(foreign, '');
      if (allHave || (body.trim() === '' && lines.length > 1)) return indent + body;
      counter += 1;
      return indent + spec.make(counter) + body;
    }).join('\n');

    if (next === block) return;
    editorEl.setSelectionRange(first, last);
    replaceSelection(next);
    editorEl.setSelectionRange(first, first + next.length);
  }

  // ---------- Списки и отступы ----------

  const ORDERED_LINE = /^(\s*)(\d+)([.)])(\s+)(.*)$/;
  const BULLET_LINE = /^(\s*)([-*+])(\s+)(\[[ xX]\]\s+)?(.*)$/;
  const QUOTE_LINE = /^(\s*)>(\s?)(.*)$/;

  // Что продолжить на следующей строке и что считать «пустым пунктом».
  function parseListLine(line) {
    let match = line.match(ORDERED_LINE);
    if (match) {
      const [, indent, number, delimiter, gap, content] = match;
      return { content, next: indent + (Number(number) + 1) + delimiter + gap };
    }
    match = line.match(BULLET_LINE);
    if (match) {
      const [, indent, bullet, gap, task, content] = match;
      return { content, next: indent + bullet + gap + (task ? '[ ] ' : '') };
    }
    match = line.match(QUOTE_LINE);
    if (match) {
      const [, indent, gap, content] = match;
      return { content, next: indent + '>' + (gap || ' ') };
    }
    return null;
  }

  function continueList() {
    const { start, end } = selectionRange();
    if (start !== end) return false; // с выделением Enter ведёт себя как обычно
    const bounds = lineBoundsAt(start);
    const line = editorEl.value.slice(bounds.start, bounds.end);
    const info = parseListLine(line);
    if (!info) return false;

    if (info.content.trim() === '') {
      // пустой пункт — выходим из списка, а не плодим маркеры
      editorEl.setSelectionRange(bounds.start, bounds.end);
      replaceSelection('');
      return true;
    }
    replaceSelection('\n' + info.next);
    return true;
  }

  function shiftLines(outdent) {
    const value = editorEl.value;
    const { start, end } = selectionRange();
    const first = lineBoundsAt(start).start;
    const last = lineBoundsAt(end).end;
    const block = value.slice(first, last);
    const lines = block.split('\n');

    let firstCut = 0;
    let delta = 0;
    const next = lines.map((line, index) => {
      if (outdent) {
        const match = line.match(/^( {1,2}|\t)/);
        const cut = match ? match[0].length : 0;
        if (index === 0) firstCut = cut;
        delta -= cut;
        return line.slice(cut);
      }
      delta += EDITOR_INDENT.length;
      return line === '' && lines.length > 1 ? line : EDITOR_INDENT + line;
    }).join('\n');

    if (next === block) return;
    editorEl.setSelectionRange(first, last);
    replaceSelection(next);
    const newStart = outdent
      ? Math.max(first, start - firstCut)
      : start + EDITOR_INDENT.length;
    editorEl.setSelectionRange(Math.min(newStart, first + next.length), first + next.length);
  }

  editorEl.addEventListener('keydown', (event) => {
    if (event.altKey) return;
    const mod = event.ctrlKey || event.metaKey;

    if (event.key === 'Tab' && !mod) {
      event.preventDefault();
      const { start, end } = selectionRange();
      const multiline = editorEl.value.slice(start, end).includes('\n');
      if (event.shiftKey || multiline) shiftLines(event.shiftKey);
      else replaceSelection(EDITOR_INDENT);
      return;
    }

    if (event.key === 'Enter' && !mod && !event.shiftKey) {
      if (continueList()) event.preventDefault();
      return;
    }

    if (!mod || event.shiftKey) return;
    const key = event.key.toLowerCase();
    if (key === 'b') { event.preventDefault(); toggleWrap('**', 'жирный'); }
    else if (key === 'i') { event.preventDefault(); toggleWrap('*', 'курсив'); }
    else if (key === '`') { event.preventDefault(); toggleWrap('`', 'код'); }
    else if (key === 'k') { event.preventDefault(); insertLink(); }
  });

  // ---------- Подсветка разметки в редакторе ----------

  // Textarea покрасить нельзя, поэтому под ней лежит слой с той же разметкой,
  // а у самого поля текст прозрачный и виден только каретка. Всё держится на одном
  // условии: слой и поле обязаны совпадать по метрике до пикселя. Поэтому
  //   * все типографские свойства заданы в CSS один раз сразу для обоих;
  //   * ширина слоя выставляется по clientWidth поля, то есть уже без полосы прокрутки, —
  //     иначе строки переносились бы в разных местах;
  //   * текст слоя посимвольно равен тексту поля (см. проверку в тестах).

  const MD_INLINE_RULES = [
    rule('md-code', '`+[^`\\n]*`+'),
    rule('md-image', '!\\[[^\\]\\n]*\\]\\([^)\\n]*\\)'),
    rule('md-link', '\\[[^\\]\\n]*\\]\\((?:[^)\\n]*)\\)|\\[[^\\]\\n]*\\]\\[[^\\]\\n]*\\]'),
    rule('md-autolink', '<(?:https?://|mailto:)[^>\\s]*>'),
    rule('md-strong', '\\*\\*(?:[^*\\n]|\\*(?!\\*))+\\*\\*|__(?:[^_\\n]|_(?!_))+__'),
    rule('md-em', '\\*(?!\\*)[^*\\n]+\\*|_(?!_)[^_\\n]+_'),
    rule('md-del', '~~[^~\\n]+~~'),
    rule('md-html', '</?[A-Za-z][\\w-]*(?:\\s[^>\\n]*)?/?>'),
  ];

  function appendSpan(target, className, text) {
    if (!text) return;
    const span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    target.appendChild(span);
  }

  function appendInline(target, text, wrapperClass) {
    if (!text) return;
    const host = wrapperClass ? document.createElement('span') : target;
    if (wrapperClass) host.className = wrapperClass;
    for (const token of tokenizeCode(text, MD_INLINE_RULES)) {
      if (!token.type) host.appendChild(document.createTextNode(token.text));
      else appendSpan(host, token.type, token.text);
    }
    if (wrapperClass) target.appendChild(host);
  }

  // Ограждения кода тянутся через строки, поэтому вид каждой строки определяем
  // отдельным проходом, а печатаем уже по готовой разметке — так проще держать
  // текст слоя дословно равным исходнику.
  function classifyMarkdownLines(lines) {
    const kinds = new Array(lines.length);
    let fenceChar = null;
    let fenceLength = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const match = lines[i].match(/^\s*(`{3,}|~{3,})(.*)$/);
      if (fenceChar) {
        const closes = match && match[1][0] === fenceChar
          && match[1].length >= fenceLength && match[2].trim() === '';
        kinds[i] = closes ? 'fence' : 'code';
        if (closes) fenceChar = null;
      } else if (match) {
        kinds[i] = 'fence';
        fenceChar = match[1][0];
        fenceLength = match[1].length;
      } else {
        kinds[i] = 'text';
      }
    }
    return kinds;
  }

  function appendMarkdownLine(target, line) {
    const heading = line.match(/^(\s*#{1,6}\s+)(.*)$/);
    if (heading) {
      appendSpan(target, 'md-marker', heading[1]);
      appendInline(target, heading[2], 'md-heading');
      return;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      appendSpan(target, 'md-rule', line);
      return;
    }
    const quote = line.match(/^(\s*>+\s?)(.*)$/);
    if (quote) {
      appendSpan(target, 'md-marker', quote[1]);
      appendInline(target, quote[2], 'md-quote');
      return;
    }
    const definition = line.match(/^(\s*\[[^\]\n]+\]:)(.*)$/);
    if (definition) {
      appendSpan(target, 'md-marker', definition[1]);
      appendSpan(target, 'md-url', definition[2]);
      return;
    }
    const list = line.match(/^(\s*(?:[-*+]|\d+[.)])\s+)(\[[ xX]\]\s+)?(.*)$/);
    if (list) {
      appendSpan(target, 'md-marker', list[1]);
      if (list[2]) appendSpan(target, 'md-task', list[2]);
      appendInline(target, list[3]);
      return;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      appendSpan(target, 'md-table', line);
      return;
    }
    appendInline(target, line);
  }

  function buildMarkdownLayer(source) {
    const fragment = document.createDocumentFragment();
    const lines = source.split('\n');
    const kinds = classifyMarkdownLines(lines);
    for (let i = 0; i < lines.length; i += 1) {
      if (kinds[i] === 'fence') appendSpan(fragment, 'md-fence', lines[i]);
      else if (kinds[i] === 'code') appendSpan(fragment, 'md-code-line', lines[i]);
      else appendMarkdownLine(fragment, lines[i]);
      if (i < lines.length - 1) fragment.appendChild(document.createTextNode('\n'));
    }
    return fragment;
  }

  function highlightEnabled() {
    return settings.editorHighlight && settings.mode !== 'preview';
  }

  // Ширина слоя — это clientWidth поля: он уже не включает полосу прокрутки,
  // а значит строки перенесутся ровно там же, где в самом поле.
  function syncHighlightMetrics() {
    if (!highlightEnabled()) return;
    editorHighlightLayer.style.width = editorEl.clientWidth + 'px';
  }

  function updateHighlightLayer() {
    editorPane.classList.toggle('highlight-on', highlightEnabled());
    if (!highlightEnabled()) {
      editorHighlightLayer.replaceChildren();
      return;
    }
    syncHighlightMetrics();
    const source = editorEl.value;
    if (source.length > EDITOR_HIGHLIGHT_MAX) {
      // очень большой документ красить дороже, чем он того стоит
      editorHighlightLayer.textContent = source + '\n';
    } else {
      const fragment = buildMarkdownLayer(source);
      // хвостовой перевод строки: без него <pre> схлопнет последнюю пустую строку
      fragment.appendChild(document.createTextNode('\n'));
      editorHighlightLayer.replaceChildren(fragment);
    }
    if (findQuery && settings.mode !== 'preview') {
      findMarks = markMatches(editorHighlightLayer, findQuery);
    }
    editorHighlightLayer.scrollTop = editorEl.scrollTop;
  }

  let highlightFrame = 0;
  function scheduleHighlight() {
    if (highlightFrame) return;
    highlightFrame = window.requestAnimationFrame(() => {
      highlightFrame = 0;
      updateHighlightLayer();
    });
  }

  // ---------- Панель форматирования ----------

  const TOOLBAR_ITEMS = [
    { label: 'Ж', title: 'Жирный (Ctrl+B)', className: 'bold', run: () => toggleWrap('**', 'жирный') },
    { label: 'К', title: 'Курсив (Ctrl+I)', className: 'italic', run: () => toggleWrap('*', 'курсив') },
    { label: '</>', title: 'Код (Ctrl+`)', className: 'mono', run: () => toggleWrap('`', 'код') },
    { icon: 'link', title: 'Ссылка (Ctrl+K)', run: insertLink },
    { separator: true },
    { label: 'H', title: 'Заголовок', className: 'bold', run: () => toggleLinePrefix('heading') },
    { label: '>', title: 'Цитата', className: 'mono', run: () => toggleLinePrefix('quote') },
    { label: '•', title: 'Маркированный список', run: () => toggleLinePrefix('bullet') },
    { label: '1.', title: 'Нумерованный список', className: 'mono', run: () => toggleLinePrefix('ordered') },
  ];

  function renderToolbar() {
    editorToolbar.replaceChildren();
    editorToolbar.classList.toggle('collapsed', !settings.toolbar);

    if (settings.toolbar) {
      for (const item of TOOLBAR_ITEMS) {
        if (item.separator) {
          const line = document.createElement('span');
          line.className = 'toolbar-separator';
          editorToolbar.appendChild(line);
          continue;
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'toolbar-button' + (item.className ? ' ' + item.className : '');
        button.title = item.title;
        button.setAttribute('aria-label', item.title);
        if (item.icon) button.appendChild(createIcon(item.icon, 14));
        else button.textContent = item.label;
        // Нажатие не должно уводить фокус из текста: иначе выделение пропадёт
        // и форматировать будет нечего.
        button.addEventListener('mousedown', (event) => event.preventDefault());
        button.addEventListener('click', item.run);
        editorToolbar.appendChild(button);
      }
    }

    if (settings.toolbar) {
      const paint = document.createElement('button');
      paint.type = 'button';
      paint.className = 'toolbar-button';
      paint.title = 'Подсветка разметки в редакторе';
      paint.setAttribute('aria-label', paint.title);
      paint.setAttribute('aria-pressed', String(settings.editorHighlight));
      paint.classList.toggle('active', settings.editorHighlight);
      paint.appendChild(createIcon('palette', 14));
      paint.addEventListener('mousedown', (event) => event.preventDefault());
      paint.addEventListener('click', () => {
        settings.editorHighlight = !settings.editorHighlight;
        saveSettings();
        renderToolbar();
        updateHighlightLayer();
      });
      editorToolbar.appendChild(paint);
    }

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'toolbar-toggle';
    toggle.title = settings.toolbar ? 'Скрыть панель форматирования' : 'Показать панель форматирования';
    toggle.setAttribute('aria-label', toggle.title);
    toggle.setAttribute('aria-pressed', String(settings.toolbar));
    toggle.appendChild(createIcon('chevron', 12));
    toggle.addEventListener('mousedown', (event) => event.preventDefault());
    toggle.addEventListener('click', () => {
      settings.toolbar = !settings.toolbar;
      saveSettings();
      renderToolbar();
    });
    editorToolbar.appendChild(toggle);
  }

  // ---------- Шапка ----------

  function setMode(mode) {
    if (settings.mode === mode || !MODES.includes(mode)) return;
    if (settings.mode !== 'preview') flushEditor();
    settings.mode = mode;
    saveSettings();
    applySettings();
  }

  modePreviewButton.addEventListener('click', () => setMode('preview'));
  modeSplitButton.addEventListener('click', () => setMode('split'));
  modeEditorButton.addEventListener('click', () => setMode('editor'));

  // ---------- Делитель панелей ----------

  splitResizer.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    splitResizer.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing');
    const onMove = (moveEvent) => {
      const rect = contentEl.getBoundingClientRect();
      if (rect.width <= 0) return;
      const percent = ((moveEvent.clientX - rect.left) / rect.width) * 100;
      settings.splitPercent = clamp(percent, SPLIT_MIN, SPLIT_MAX);
      document.documentElement.style.setProperty('--split-percent', String(settings.splitPercent));
    };
    const onUp = () => {
      splitResizer.removeEventListener('pointermove', onMove);
      splitResizer.removeEventListener('pointerup', onUp);
      splitResizer.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('resizing');
      saveSettings();
      // ширина панелей изменилась — перенос строк в редакторе тоже, значит устарели
      // и карта прокрутки, и слой подсветки
      updateHighlightLayer();
      const file = fileById(currentId);
      if (file) rebuildScrollMap(file.content || '');
    };
    splitResizer.addEventListener('pointermove', onMove);
    splitResizer.addEventListener('pointerup', onUp);
    splitResizer.addEventListener('pointercancel', onUp);
  });

  splitResizer.addEventListener('dblclick', () => {
    settings.splitPercent = DEFAULT_SETTINGS.splitPercent;
    saveSettings();
    applySettings();
  });

  // от ширины окна зависит и перенос строк, и высота блоков превью
  window.addEventListener('resize', () => {
    updateHighlightLayer();
    const file = fileById(currentId);
    if (file && settings.mode === 'split') rebuildScrollMap(file.content || '');
  });

  previewFontSelect.addEventListener('change', () => {
    // неизвестное значение записало бы в стиль undefined; при загрузке это
    // потом чинится, но проще не пускать сюда мусор вовсе
    if (!FONT_STACKS[previewFontSelect.value]) {
      previewFontSelect.value = settings.previewFont;
      return;
    }
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
  let searchTimer = null;
  fileSearchInput.addEventListener('input', () => {
    // поиск идёт и по содержимому всех файлов, поэтому не на каждый символ
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      searchQuery = fileSearchInput.value;
      renderFiles();
    }, 120);
  });

  fileSearchInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    fileSearchInput.value = '';
    searchQuery = '';
    renderFiles();
  });

  newFileButton.addEventListener('click', () => createFile());
  newFolderButton.addEventListener('click', () => createFolder());
  deleteAllButton.addEventListener('click', () => { void confirmDeleteAll(); });
  uploadButton.addEventListener('click', () => uploadInput.click());
  uploadInput.addEventListener('change', () => {
    // loadExternalFiles ждёт [{file, segments}], а поле выбора отдаёт голый FileList:
    // раньше сюда уходил он как есть, внутри падало исключение и молча терялось в void.
    const picked = Array.from(uploadInput.files || [])
      .map((file) => ({ file, segments: pathSegments(file.webkitRelativePath || '', file.name) }));
    uploadInput.value = '';
    loadExternalFiles(picked).catch((error) => {
      console.error(error);
      setStatus('Не удалось загрузить файлы', true);
    });
  });

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
      if (!fileById(currentId)) return;
      event.preventDefault();
      printDocument();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      if (!fileById(currentId)) return;
      event.preventDefault();
      openFind();
      return;
    }
    if (event.key === 'Escape' && !findBar.hidden) {
      closeFind();
      return;
    }
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
