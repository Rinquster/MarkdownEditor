(() => {
  'use strict';

  // ---------- Константы ----------

  const DB_NAME = 'mdeditor';
  const DB_STORE = 'workspace';
  const STATE_KEY = 'state';
  const SETTINGS_KEY = 'mdeditor-settings';
  const EMERGENCY_KEY = 'mdeditor-emergency';
  const AUTOSAVE_DELAY_MS = 450;

  const WELCOME_ID = '__welcome__';
  const WELCOME_NAME = 'добро-пожаловать.md';

  const PREVIEW_SIZE_MIN = 12;
  const PREVIEW_SIZE_MAX = 28;
  const EDITOR_SIZE_MIN = 10;
  const EDITOR_SIZE_MAX = 24;
  const SIDEBAR_MIN = 180;
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
  const downloadZipButton = el('download-zip-button');
  const newFileButton = el('new-file-button');
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

  let files = []; // [{id, name, content, updatedAt}]
  let welcomeFile = null; // призрачный файл-справка; null — удалён и больше не появится
  let currentId = null;
  let settings = { ...DEFAULT_SETTINGS };
  let renameState = null; // {id, initial} — файл, чьё имя сейчас редактируется inline
  let autosaveTimer = null;
  let statusTimer = null;
  let writeQueue = Promise.resolve();

  // ---------- Утилиты ----------

  function uid() {
    return (crypto.randomUUID && crypto.randomUUID()) ||
      'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function fileById(id) {
    if (welcomeFile && id === WELCOME_ID) return welcomeFile;
    return files.find((f) => f.id === id) || null;
  }

  function fileByName(name) {
    return files.find((f) => f.name === name) || null;
  }

  function sortedFiles() {
    return [...files].sort((a, b) =>
      a.name.localeCompare(b.name, 'ru', { numeric: true, sensitivity: 'base' }));
  }

  function uniqueName(base) {
    if (!fileByName(base)) return base;
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    let n = 2;
    while (fileByName(`${stem}-${n}${ext}`)) n += 1;
    return `${stem}-${n}${ext}`;
  }

  function setStatus(text, sticky = false) {
    statusLine.textContent = text;
    window.clearTimeout(statusTimer);
    if (!sticky) {
      statusTimer = window.setTimeout(() => {
        statusLine.textContent = 'Файлы хранятся в вашем браузере';
      }, 4000);
    }
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
      const request = window.indexedDB.open(DB_NAME, 1);
      request.addEventListener('upgradeneeded', () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
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

  // Соединение держим открытым всё время жизни страницы: так запись на
  // pagehide успевает создать транзакцию до выгрузки (браузер дописывает
  // уже начатые транзакции, но не ждёт незавершённого open()).
  let dbPromise = null;
  let dbConn = null; // то же соединение, но доступное синхронно (для pagehide)

  function getDb() {
    if (!dbPromise) {
      dbPromise = openDb().then((db) => {
        dbConn = db;
        return db;
      }).catch((error) => {
        dbPromise = null;
        throw error;
      });
    }
    return dbPromise;
  }

  async function readState() {
    const db = await getDb();
    return idbRequest(db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(STATE_KEY));
  }

  async function writeState(state) {
    const db = await getDb();
    const transaction = db.transaction(DB_STORE, 'readwrite');
    const done = new Promise((resolve, reject) => {
      transaction.addEventListener('complete', () => resolve());
      transaction.addEventListener('abort', () => reject(transaction.error || new Error('IndexedDB tx aborted')));
      transaction.addEventListener('error', () => reject(transaction.error || new Error('IndexedDB tx failed')));
    });
    transaction.objectStore(DB_STORE).put(state, STATE_KEY);
    await done;
  }

  function enqueueWrite(task) {
    const result = writeQueue.then(task, task);
    writeQueue = result.catch(() => {});
    return result;
  }

  function serializeState() {
    return {
      version: 2,
      currentId,
      savedAt: new Date().toISOString(),
      welcome: welcomeFile ? { content: welcomeFile.content, updatedAt: welcomeFile.updatedAt } : null,
      files: files.map((f) => ({ id: f.id, name: f.name, content: f.content, updatedAt: f.updatedAt })),
    };
  }

  function scheduleAutosave() {
    window.clearTimeout(autosaveTimer);
    autosaveTimer = window.setTimeout(() => { void persistNow(); }, AUTOSAVE_DELAY_MS);
  }

  function persistNow() {
    window.clearTimeout(autosaveTimer);
    const state = serializeState();
    return enqueueWrite(() => writeState(state)).catch((error) => {
      console.error(error);
      setStatus('Не удалось сохранить в браузере', true);
    });
  }

  // ---------- Рендер списка файлов ----------

  function createIcon(name) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '15');
    svg.setAttribute('height', '15');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('fill', 'currentColor');
    const paths = {
      file: 'M4 1.75C4 1.34 4.34 1 4.75 1h5.09c.2 0 .39.08.53.22l2.41 2.41c.14.14.22.33.22.53v10.09c0 .41-.34.75-.75.75h-7.5A.75.75 0 0 1 4 14.25V1.75Zm1.5.75v11h6v-8.5H9.75A.75.75 0 0 1 9 4.25V2.5H5.5Z',
      menu: 'M8 4.6a1.1 1.1 0 1 1 0-2.2 1.1 1.1 0 0 1 0 2.2Zm0 4.5a1.1 1.1 0 1 1 0-2.2 1.1 1.1 0 0 1 0 2.2Zm0 4.5a1.1 1.1 0 1 1 0-2.2 1.1 1.1 0 0 1 0 2.2Z',
      info: 'M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13Zm0 1.5a5 5 0 1 0 0 10A5 5 0 0 0 8 3Zm0 3.7c.41 0 .75.34.75.75v3.05a.75.75 0 0 1-1.5 0V7.95c0-.41.34-.75.75-.75Zm0-2.3a.95.95 0 1 1 0 1.9.95.95 0 0 1 0-1.9Z',
    };
    path.setAttribute('d', paths[name] || paths.file);
    svg.appendChild(path);
    return svg;
  }

  function createFileRow(file, ghost) {
    const row = document.createElement('div');
    row.className = 'file-row' + (ghost ? ' ghost' : '') + (file.id === currentId ? ' active' : '');

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'file-main-button';
    main.title = file.name;
    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.appendChild(createIcon(ghost ? 'info' : 'file'));
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.name;
    main.append(icon, name);
    main.addEventListener('click', () => openFile(file.id));

    const menu = document.createElement('button');
    menu.type = 'button';
    menu.className = 'file-menu-button';
    menu.title = 'Действия с файлом';
    menu.appendChild(createIcon('menu'));
    menu.addEventListener('click', (event) => {
      event.stopPropagation();
      const rect = menu.getBoundingClientRect();
      openFileContextMenu(file, rect.right + 4, rect.top);
    });

    row.append(main, menu);
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      openFileContextMenu(file, event.clientX, event.clientY);
    });
    return row;
  }

  function renderFiles() {
    closeContextMenu();
    fileListEl.replaceChildren();

    // раздел справки: единственный призрачный файл над основным списком
    if (welcomeFile) {
      fileListEl.appendChild(createFileRow(welcomeFile, true));
      const separator = document.createElement('hr');
      separator.className = 'file-section-sep';
      fileListEl.appendChild(separator);
    }

    if (files.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'drop-hint';
      hint.innerHTML = 'Перетащите сюда<br><strong>.md-файлы или папки</strong><br>или нажмите, чтобы выбрать';
      hint.addEventListener('click', () => uploadInput.click());
      fileListEl.appendChild(hint);
      return;
    }

    for (const file of sortedFiles()) {
      if (renameState && renameState.id === file.id) {
        const row = document.createElement('div');
        row.className = 'file-row' + (file.id === currentId ? ' active' : '');
        row.appendChild(createInlineNameEditor(file));
        fileListEl.appendChild(row);
        continue;
      }
      fileListEl.appendChild(createFileRow(file, false));
    }
  }

  function createInlineNameEditor(file) {
    const input = document.createElement('input');
    input.className = 'file-name-input';
    input.value = renameState.initial;
    input.spellcheck = false;

    const isValid = (value) => {
      const trimmed = value.trim();
      if (!trimmed) return false;
      const existing = fileByName(trimmed);
      return !existing || existing.id === file.id;
    };

    let finished = false;
    const commit = () => {
      if (finished) return;
      const trimmed = input.value.trim();
      if (!isValid(trimmed)) { cancel(); return; }
      finished = true;
      renameState = null;
      if (trimmed !== file.name) {
        file.name = trimmed;
        file.updatedAt = new Date().toISOString();
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
      const dot = input.value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
    }, 0);

    return input;
  }

  function startRename(id) {
    const file = fileById(id);
    if (!file) return;
    renameState = { id, initial: file.name };
    renderFiles();
  }

  // ---------- Контекстное меню ----------

  function openFileContextMenu(file, left, top) {
    const actions = file.id === WELCOME_ID
      ? [
          ['Скачать', () => downloadFile(file.id), ''],
          ['—', null, ''],
          ['Удалить', () => confirmDelete(file.id), 'danger'],
        ]
      : [
          ['Переименовать', () => startRename(file.id), ''],
          ['Дублировать', () => duplicateFile(file.id), ''],
          ['Скачать', () => downloadFile(file.id), ''],
          ['—', null, ''],
          ['Удалить', () => confirmDelete(file.id), 'danger'],
        ];
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
    previewBody.innerHTML = html;
    for (const link of previewBody.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href') || '';
      if (/^https?:/i.test(href)) {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
    }
    if (lastPreviewFileId !== file.id) {
      previewScrollRatio = 0;
      lastPreviewFileId = file.id;
    }
    previewPane.scrollTop = previewScrollRatio * Math.max(0, scrollMax(previewPane));
  }

  function openFile(id) {
    if (currentId === id) return;
    currentId = id;
    renameState = null;
    renderFiles();
    renderMain();
    scheduleAutosave();
  }

  // ---------- Операции с файлами ----------

  function createFile() {
    const name = uniqueName('новый-файл.md');
    const file = { id: uid(), name, content: '', updatedAt: new Date().toISOString() };
    files.push(file);
    currentId = file.id;
    renameState = { id: file.id, initial: name };
    renderFiles();
    renderMain();
    void persistNow();
  }

  function duplicateFile(id) {
    const source = fileById(id);
    if (!source) return;
    const dot = source.name.lastIndexOf('.');
    const stem = dot > 0 ? source.name.slice(0, dot) : source.name;
    const ext = dot > 0 ? source.name.slice(dot) : '';
    const copy = {
      id: uid(),
      name: uniqueName(`${stem} (копия)${ext}`),
      content: source.content,
      updatedAt: new Date().toISOString(),
    };
    files.push(copy);
    currentId = copy.id;
    renderFiles();
    renderMain();
    void persistNow();
    setStatus(`Создана копия: ${copy.name}`);
  }

  async function confirmDelete(id) {
    const file = fileById(id);
    if (!file) return;
    const isGhost = id === WELCOME_ID;
    const message = isGhost
      ? `Удалить справку «${file.name}»? Её раздел исчезнет и больше не появится.`
      : `Удалить файл «${file.name}»? Это действие нельзя отменить.`;
    const answer = await showDialog(
      message,
      [
        { label: 'Удалить', value: 'delete', kind: 'danger' },
        { label: 'Отмена', value: null, kind: 'secondary' },
      ],
    );
    if (answer !== 'delete') return;
    if (isGhost) welcomeFile = null;
    else files = files.filter((f) => f.id !== id);
    if (currentId === id) {
      const rest = sortedFiles();
      currentId = rest.length > 0 ? rest[0].id : (welcomeFile ? WELCOME_ID : null);
    }
    renderFiles();
    renderMain();
    void persistNow();
    setStatus(`Удалён: ${file.name}`);
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

  async function downloadAllZip() {
    if (files.length === 0) {
      setStatus('Нет файлов для скачивания');
      return;
    }
    flushEditor();
    const zip = new window.JSZip();
    for (const file of sortedFiles()) zip.file(file.name, file.content);
    const stamp = new Date().toISOString().slice(0, 10);
    const blob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(blob, `markdown-${stamp}.zip`);
    setStatus(`В архиве файлов: ${files.length}`);
  }

  // ---------- Загрузка файлов ----------

  function isMarkdownLike(file) {
    const name = file.name.toLowerCase();
    if (/\.(md|markdown|txt|mdown|mkd)$/.test(name)) return true;
    return (file.type || '').startsWith('text/');
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(String(reader.result || '')));
      reader.addEventListener('error', () => reject(reader.error || new Error('file read failed')));
      reader.readAsText(file, 'utf-8');
    });
  }

  async function loadExternalFiles(fileList) {
    const selected = Array.from(fileList || []);
    if (selected.length === 0) return;
    flushEditor();
    let loaded = 0;
    let skipped = 0;
    let lastId = null;

    for (const external of selected) {
      if (!isMarkdownLike(external)) { skipped += 1; continue; }
      let content;
      try {
        content = await readFileAsText(external);
      } catch {
        skipped += 1;
        continue;
      }
      const existing = fileByName(external.name);
      if (existing) {
        const answer = await showDialog(
          `Файл «${external.name}» уже есть. Заменить его содержимое?`,
          [
            { label: 'Заменить', value: 'replace', kind: 'primary' },
            { label: 'Пропустить', value: null, kind: 'secondary' },
          ],
        );
        if (answer !== 'replace') { skipped += 1; continue; }
        existing.content = content;
        existing.updatedAt = new Date().toISOString();
        lastId = existing.id;
      } else {
        const file = { id: uid(), name: external.name, content, updatedAt: new Date().toISOString() };
        files.push(file);
        lastId = file.id;
      }
      loaded += 1;
    }

    if (lastId) {
      currentId = lastId;
      if (settings.mode === 'editor') editorEl.value = fileById(lastId).content;
    }
    renderFiles();
    renderMain();
    void persistNow();
    const skippedText = skipped > 0 ? `, пропущено: ${skipped}` : '';
    setStatus(`Загружено файлов: ${loaded}${skippedText}`);
  }

  // ---------- Drag-n-drop ----------

  // разворачивает брошенные файлы и папки (рекурсивно) в плоский список File
  async function loadDroppedEntries(entries) {
    const collected = [];

    async function walk(entry) {
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        collected.push(file);
        return;
      }
      if (!entry.isDirectory) return;
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
    await loadExternalFiles(collected);
  }

  function isFileTransfer(dataTransfer) {
    if (!dataTransfer) return false;
    const types = Array.from(dataTransfer.types || []);
    return types.length === 0 || types.includes('Files');
  }

  function installDropArea() {
    let dragDepth = 0;
    sidebar.addEventListener('dragenter', (event) => {
      if (!isFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      dragDepth += 1;
      fileListEl.classList.add('drag-over');
    });
    sidebar.addEventListener('dragover', (event) => {
      if (!isFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      fileListEl.classList.add('drag-over');
    });
    sidebar.addEventListener('dragleave', (event) => {
      if (!isFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) fileListEl.classList.remove('drag-over');
    });
    sidebar.addEventListener('drop', (event) => {
      if (!isFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      dragDepth = 0;
      fileListEl.classList.remove('drag-over');
      // webkitGetAsEntry обязан вызываться синхронно внутри drop —
      // после первого await элементы dataTransfer уже мертвы
      const entries = [];
      for (const item of Array.from((event.dataTransfer && event.dataTransfer.items) || [])) {
        const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
        if (entry) entries.push(entry);
      }
      if (entries.length > 0) void loadDroppedEntries(entries);
      else void loadExternalFiles(event.dataTransfer && event.dataTransfer.files);
    });

    // случайный drop мимо панели не должен уводить со страницы
    window.addEventListener('dragover', (event) => event.preventDefault());
    window.addEventListener('drop', (event) => event.preventDefault());
  }

  // ---------- Ширина сайдбара ----------

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
      file.updatedAt = new Date().toISOString();
      scheduleAutosave();
    }
  }

  editorEl.addEventListener('input', () => {
    const file = fileById(currentId);
    if (!file) return;
    file.content = editorEl.value;
    file.updatedAt = new Date().toISOString();
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

  downloadZipButton.addEventListener('click', () => { void downloadAllZip(); });
  newFileButton.addEventListener('click', createFile);
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

  // при перезагрузке/закрытии не даём пропасть несохранённому дебаунсу
  // Писать в IndexedDB из pagehide ненадёжно — Chrome закрывает соединение при
  // выгрузке. Поэтому: синхронный аварийный снимок в localStorage; при следующем
  // запуске он подхватывается, если новее записи в IndexedDB.
  window.addEventListener('pagehide', () => {
    flushEditor();
    window.clearTimeout(autosaveTimer);
    try {
      window.localStorage.setItem(EMERGENCY_KEY, JSON.stringify(serializeState()));
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

  async function init() {
    loadSettings();
    if (window.marked && window.marked.setOptions) {
      window.marked.setOptions({ gfm: true, breaks: false });
    }

    let state = null;
    try {
      state = (await readState()) || null;
    } catch (error) {
      console.error(error);
      setStatus('IndexedDB недоступен — файлы не сохранятся', true);
    }

    // аварийный снимок с pagehide новее записи в IndexedDB? — берём его
    let usedEmergency = false;
    try {
      const raw = window.localStorage.getItem(EMERGENCY_KEY);
      if (raw) {
        const emergency = JSON.parse(raw);
        if (emergency && Array.isArray(emergency.files) &&
            (!state || String(emergency.savedAt || '') >= String(state.savedAt || ''))) {
          state = emergency;
          usedEmergency = true;
        }
      }
      window.localStorage.removeItem(EMERGENCY_KEY);
    } catch { /* повреждённый снимок — игнорируем */ }

    if (state && Array.isArray(state.files)) {
      files = state.files
        .filter((f) => f && typeof f.name === 'string')
        .map((f) => ({
          id: f.id || uid(),
          name: f.name,
          content: typeof f.content === 'string' ? f.content : '',
          updatedAt: f.updatedAt || new Date().toISOString(),
        }));
      let savedCurrentId = state.currentId;

      if ((state.version || 1) >= 2) {
        welcomeFile = state.welcome && typeof state.welcome.content === 'string'
          ? { id: WELCOME_ID, name: WELCOME_NAME, content: state.welcome.content, updatedAt: state.welcome.updatedAt || new Date().toISOString() }
          : null;
      } else {
        // v1: приветственный файл переезжает из общего списка в призрачный раздел
        const index = files.findIndex((f) => f.name === WELCOME_NAME && f.content.startsWith('# Добро пожаловать в MDEditor'));
        if (index !== -1) {
          const moved = files.splice(index, 1)[0];
          welcomeFile = { id: WELCOME_ID, name: WELCOME_NAME, content: moved.content, updatedAt: moved.updatedAt };
          if (savedCurrentId === moved.id) savedCurrentId = WELCOME_ID;
        }
        scheduleAutosave();
      }

      const validId = files.some((f) => f.id === savedCurrentId) || (welcomeFile && savedCurrentId === WELCOME_ID);
      currentId = validId
        ? savedCurrentId
        : (sortedFiles()[0] || {}).id || (welcomeFile ? WELCOME_ID : null);
    } else if (!state) {
      welcomeFile = { id: WELCOME_ID, name: WELCOME_NAME, content: WELCOME_DOC, updatedAt: new Date().toISOString() };
      currentId = WELCOME_ID;
      scheduleAutosave();
    }

    if (usedEmergency) void persistNow();

    installDropArea();
    applySettings();
    renderFiles();
    renderMain();
  }

  void init();
})();
