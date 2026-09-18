import {
  app,
  BrowserWindow,
  WebContentsView,
  utilityProcess,
  ipcMain,
  dialog,
  safeStorage,
  shell,
  type UtilityProcess,
} from 'electron';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { z } from 'zod';

app.setName('Dogfood');
let window: BrowserWindow,
  worker: UtilityProcess,
  preview: WebContentsView | undefined,
  previewTask = '',
  root: string,
  closing = false;
let previewGeneration = 0;
let serial = 0;
const pending = new Map<
  number,
  { resolve: (value: any) => void; reject: (error: Error) => void }
>();
const secrets: Record<string, string> = {};
const request = (method: string, params: Record<string, unknown> = {}): Promise<any> =>
  new Promise((resolve, reject) => {
    const id = ++serial;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, method, params });
  });
const hidePreview = (invalidate = true) => {
  if (invalidate) previewGeneration++;
  if (preview) {
    window.contentView.removeChildView(preview);
    preview.webContents.close();
    preview = undefined;
    previewTask = '';
  }
};

async function start() {
  root =
    !app.isPackaged && process.env.DOGFOOD_DESKTOP_DATA
      ? process.env.DOGFOOD_DESKTOP_DATA
      : app.getPath('userData');
  await mkdir(root, { recursive: true, mode: 0o700 });
  process.env.PATH = [
    process.env.PATH,
    join(homedir(), '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ]
    .filter(Boolean)
    .join(':');
  try {
    const encrypted = await readFile(join(root, 'credentials'));
    Object.assign(secrets, JSON.parse(safeStorage.decryptString(encrypted)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.error('Stored credentials could not be unlocked. Reconnect from Connections.');
  }
  worker = utilityProcess.fork(join(__dirname, 'worker.cjs'), [], {
    env: process.env,
    serviceName: 'Dogfood workspace',
  });
  await new Promise<void>((resolve, reject) => {
    worker.on('message', (message) => {
      if (message.ready) {
        resolve();
        return;
      }
      if (message.fatal) {
        reject(new Error(message.fatal));
        return;
      }
      if (message.event) {
        if (window && !window.isDestroyed())
          window.webContents.send('dogfood:event', message.event);
        return;
      }
      const p = pending.get(message.id);
      if (p) {
        pending.delete(message.id);
        message.error ? p.reject(new Error(message.error)) : p.resolve(message.result);
      }
    });
    worker.on('exit', (code) => {
      for (const p of pending.values())
        p.reject(new Error(`Workspace service stopped (${code}). Restart Dogfood to recover.`));
      pending.clear();
      reject(new Error(`Workspace startup failed (${code})`));
    });
    worker.postMessage({ init: { root, secrets, runtime: process.execPath } });
  });
  window = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 1000,
    minHeight: 680,
    title: 'Dogfood',
    backgroundColor: '#f3f6fc',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.on('closed', () => app.quit());
  ipcMain.handle('dogfood:call', async (event, raw) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
      throw new Error('Unauthorized desktop caller');
    const { method, params } = z
      .object({ method: z.string(), params: z.record(z.string(), z.unknown()).default({}) })
      .parse(raw);
    if (method === 'dialog.directory') {
      const result = await dialog.showOpenDialog(window, {
        properties: ['openDirectory', 'createDirectory'],
        title: typeof params.title === 'string' ? params.title : 'Choose project directory',
      });
      return result.canceled ? null : result.filePaths[0];
    }
    if (method === 'external.open') {
      const url = new URL(z.string().parse(params.url));
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Unsupported link');
      await shell.openExternal(url.href);
      return true;
    }
    if (method === 'settings.save') {
      const incoming = z
        .object({
          claudeKey: z.string().max(10000).optional(),
          platformToken: z.string().max(10000).optional(),
        })
        .parse(params.secrets ?? {});
      if (Object.keys(incoming).length) {
        if (!safeStorage.isEncryptionAvailable())
          throw new Error('Credential encryption is not available.');
        Object.assign(secrets, incoming);
        await writeFile(
          join(root, 'credentials.tmp'),
          safeStorage.encryptString(JSON.stringify(secrets)),
          { mode: 0o600 },
        );
        await rename(join(root, 'credentials.tmp'), join(root, 'credentials'));
      }
      return request(method, { ...params, secrets });
    }
    if (method === 'preview.show') {
      const generation = ++previewGeneration;
      const taskId = z.string().uuid().parse(params.id),
        url = await request('run.start', { id: taskId });
      if (generation !== previewGeneration) return url;
      if (!preview || previewTask !== taskId) {
        hidePreview(false);
        previewTask = taskId;
        preview = new WebContentsView({
          webPreferences: {
            partition: `dogfood-task-${taskId}`,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        });
        preview.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        preview.webContents.session.setPermissionRequestHandler(
          (_contents, _permission, callback) => callback(false),
        );
        preview.webContents.on('will-navigate', (event, next) => {
          if (new URL(next).origin !== new URL(url).origin) event.preventDefault();
        });
        window.contentView.addChildView(preview);
        const view = preview;
        try {
          await view.webContents.loadURL(url);
        } catch (error) {
          if (generation === previewGeneration) throw error;
        }
        if (generation !== previewGeneration || preview !== view) return url;
      }
      const rect = z
        .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
        .parse(params.rect);
      preview.setBounds({
        x: Math.max(0, Math.round(rect.x)),
        y: Math.max(0, Math.round(rect.y)),
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      });
      return url;
    }
    if (method === 'preview.bounds') {
      if (preview) {
        const r = z
          .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
          .parse(params.rect);
        preview.setBounds({
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.max(0, Math.round(r.width)),
          height: Math.max(0, Math.round(r.height)),
        });
      }
      return true;
    }
    if (method === 'preview.hide') {
      hidePreview();
      return true;
    }
    if (method === 'preview.capture') {
      if (!preview) throw new Error('Open the local preview first.');
      const image = await preview.webContents.capturePage();
      return request('screenshot.add', { id: previewTask, image: image.toDataURL() });
    }
    if (method === 'backup.choose') {
      const result = await dialog.showOpenDialog(window, {
        properties: ['openDirectory', 'createDirectory'],
        title: 'Save Dogfood history backup',
      });
      if (result.canceled) return null;
      return request('backup.create', {
        path: join(
          result.filePaths[0],
          `dogfood-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`,
        ),
      });
    }
    if (method === 'backup.restore.choose') {
      const result = await dialog.showOpenDialog(window, {
        properties: ['openDirectory'],
        title: 'Restore a Dogfood history backup',
      });
      if (result.canceled) return null;
      const confirm = await dialog.showMessageBox(window, {
        type: 'warning',
        message: 'Replace local task history with this backup?',
        detail:
          'A copy of the current database will be retained. Repository files and credentials stay in place.',
        buttons: ['Cancel', 'Restore'],
        defaultId: 0,
        cancelId: 0,
      });
      if (confirm.response !== 1) return null;
      return request('backup.restore', { path: result.filePaths[0] });
    }
    if (method === 'export.choose') {
      const result = await dialog.showSaveDialog(window, { defaultPath: 'dogfood-task.json' });
      if (result.canceled) return null;
      return request('export.task', { id: params.id, path: result.filePath });
    }
    if (['backup.create', 'backup.restore', 'export.task', 'screenshot.add'].includes(method))
      throw new Error('Use the native file dialog for this operation.');
    return request(method, params);
  });
  await window.loadFile(join(__dirname, 'ui/index.html'));
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    window?.show();
    window?.focus();
  });
  app
    .whenReady()
    .then(start)
    .catch((error) => {
      console.error(error);
      dialog.showErrorBox('Dogfood could not start', String(error));
      app.exit(1);
    });
  app.on('before-quit', (event) => {
    if (closing || !worker) return;
    event.preventDefault();
    closing = true;
    hidePreview();
    worker.postMessage({ shutdown: true });
    setTimeout(() => {
      worker.kill();
      app.exit(0);
    }, 2200);
  });
}
