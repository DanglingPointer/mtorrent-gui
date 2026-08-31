import { describe, test, expect, vi, beforeEach } from 'vitest';

// Helper: set up the DOM structure matching index.html
function setupDOM() {
  document.body.innerHTML = `
    <main class="container">
      <header class="app-header">
        <div class="brand-row">
          <a href="https://crates.io/crates/mtorrent" target="_blank">
            <img src="/assets/mtorrent.svg" class="logo mtorrent" alt="mtorrent logo" title="mtorrent" />
          </a>
        </div>
      </header>
      <nav class="tabs" id="tabs-bar">
        <div class="tabs-scroll" id="tabs-scroll"></div>
        <button id="add-tab" title="New download tab">+</button>
      </nav>
      <section id="tabs-container" class="tabs-container"></section>
    </main>
  `;
}

// Helper: load main.js and trigger DOMContentLoaded
async function loadApp() {
  setupDOM();
  // Reset module registry so main.js re-executes
  vi.resetModules();
  await import('../ui/main.js');
  // Trigger DOMContentLoaded on window (where the listener is registered)
  window.dispatchEvent(new Event('DOMContentLoaded'));
  // Let microtasks (promise in DOMContentLoaded handler) settle
  await new Promise(r => setTimeout(r, 0));
}

describe('Tab Management', () => {
  beforeEach(async () => {
    window.__mocks__.invoke.mockResolvedValue(null);
    await loadApp();
  });

  test('initial tab is created on load', () => {
    const tabs = document.querySelectorAll('.tab-btn');
    const panels = document.querySelectorAll('.tab-panel');
    expect(tabs.length).toBe(1);
    expect(panels.length).toBe(1);
    expect(tabs[0].classList.contains('active')).toBe(true);
  });

  test('clicking + creates a new tab', () => {
    const addBtn = document.getElementById('add-tab');
    addBtn.click();

    const tabs = document.querySelectorAll('.tab-btn');
    const panels = document.querySelectorAll('.tab-panel');
    expect(tabs.length).toBe(2);
    expect(panels.length).toBe(2);
    // New tab should be active
    expect(tabs[1].classList.contains('active')).toBe(true);
    expect(tabs[0].classList.contains('active')).toBe(false);
  });

  test('clicking a tab button activates it', () => {
    document.getElementById('add-tab').click(); // second tab
    const tabs = document.querySelectorAll('.tab-btn');

    // Click first tab
    tabs[0].click();
    expect(tabs[0].classList.contains('active')).toBe(true);
    expect(tabs[1].classList.contains('active')).toBe(false);
  });

  test('closing a tab removes it and activates the last remaining', () => {
    document.getElementById('add-tab').click();
    const tabs = document.querySelectorAll('.tab-btn');

    // Close second tab by clicking the close button
    const closeBtn = tabs[1].querySelector('.close');
    closeBtn.click();

    const remaining = document.querySelectorAll('.tab-btn');
    expect(remaining.length).toBe(1);
    expect(remaining[0].classList.contains('active')).toBe(true);
  });

  test('closing a non-finished tab calls stop_download', () => {
    const panel = document.querySelector('.tab-panel');
    panel.querySelector('[data-summary]').textContent = 'Loading...';

    const closeBtn = document.querySelector('.tab-btn .close');
    closeBtn.click();

    expect(window.__mocks__.invoke).toHaveBeenCalledWith('stop_download', expect.anything());
  });

  test('closing a finished tab does not call stop_download', () => {
    const panel = document.querySelector('.tab-panel');
    panel.dataset.downloadFinished = 'true';
    panel.querySelector('input[name="uri"]').value = 'magnet:?xt=urn:btih:active';

    const closeBtn = document.querySelector('.tab-btn .close');
    closeBtn.click();

    expect(window.__mocks__.invoke).not.toHaveBeenCalledWith('stop_download', {
      metainfoUri: 'magnet:?xt=urn:btih:active',
    });
  });

  test('closing a tab with no downloadFinished flag still calls stop_download when a URI is present', () => {
    const panel = document.querySelector('.tab-panel');
    delete panel.dataset.downloadFinished;
    panel.querySelector('input[name="uri"]').value = 'magnet:?xt=urn:btih:legacy';

    const closeBtn = document.querySelector('.tab-btn .close');
    closeBtn.click();

    expect(window.__mocks__.invoke).toHaveBeenCalledWith('stop_download', {
      metainfoUri: 'magnet:?xt=urn:btih:legacy',
    });
  });

  test('each tab panel contains expected elements', () => {
    const panel = document.querySelector('.tab-panel');
    expect(panel.querySelector('.title')).not.toBeNull();
    expect(panel.querySelector('.dl-form')).not.toBeNull();
    expect(panel.querySelector('input[name="uri"]')).not.toBeNull();
    expect(panel.querySelector('.progress')).not.toBeNull();
    expect(panel.querySelector('.peers-table')).not.toBeNull();
    expect(panel.querySelector('[data-summary]')).not.toBeNull();
  });
});

describe('Download Flow', () => {
  beforeEach(async () => {
    window.__mocks__.invoke.mockResolvedValue(null);
    await loadApp();
  });

  test('submitting empty URI shows a toast', async () => {
    const form = document.querySelector('.dl-form');
    form.dispatchEvent(new Event('submit', { cancelable: true }));

    // Toast should appear
    await vi.waitFor(() => {
      const toast = document.querySelector('.toast');
      expect(toast).not.toBeNull();
      expect(toast.textContent).toContain('required');
    });
  });

  test('successful download invokes get_name and do_download', async () => {
    window.__mocks__.invoke.mockImplementation((cmd, args) => {
      if (cmd === 'get_name') return Promise.resolve('Test Torrent');
      if (cmd === 'do_download') return Promise.resolve();
      if (cmd === 'get_cli_arg') return Promise.resolve(null);
      return Promise.resolve(null);
    });
    window.__mocks__.open.mockResolvedValue('/tmp/downloads');

    const input = document.querySelector('input[name="uri"]');
    input.value = 'magnet:?xt=urn:btih:abc123';

    const form = document.querySelector('.dl-form');
    form.dispatchEvent(new Event('submit', { cancelable: true }));

    // Wait for the async flow
    await vi.waitFor(() => {
      expect(window.__mocks__.invoke).toHaveBeenCalledWith('get_name', {
        metainfoUri: 'magnet:?xt=urn:btih:abc123',
      });
    });

    await vi.waitFor(() => {
      expect(window.__mocks__.invoke).toHaveBeenCalledWith(
        'do_download',
        expect.objectContaining({
          metainfoUri: 'magnet:?xt=urn:btih:abc123',
          outputDir: '/tmp/downloads',
        })
      );
    });
  });

  test('title and tab label update after get_name resolves', async () => {
    window.__mocks__.invoke.mockImplementation((cmd) => {
      if (cmd === 'get_name') return Promise.resolve('My.Torrent.File');
      if (cmd === 'do_download') return Promise.resolve();
      if (cmd === 'get_cli_arg') return Promise.resolve(null);
      return Promise.resolve(null);
    });
    window.__mocks__.open.mockResolvedValue('/tmp/out');

    const input = document.querySelector('input[name="uri"]');
    input.value = 'magnet:?xt=urn:btih:xyz';

    const form = document.querySelector('.dl-form');
    form.dispatchEvent(new Event('submit', { cancelable: true }));

    await vi.waitFor(() => {
      const title = document.querySelector('.title');
      expect(title.textContent).toBe('My.Torrent.File');
    });

    await vi.waitFor(() => {
      const label = document.querySelector('.tab-btn .label');
      expect(label.textContent).toBe('My.Torrent.F');
    });
  });

  test('form is disabled during download', async () => {
    let resolveDownload;
    window.__mocks__.invoke.mockImplementation((cmd) => {
      if (cmd === 'get_name') return Promise.resolve('Name');
      if (cmd === 'do_download') return new Promise(r => { resolveDownload = r; });
      if (cmd === 'get_cli_arg') return Promise.resolve(null);
      return Promise.resolve(null);
    });
    window.__mocks__.open.mockResolvedValue('/tmp');

    const input = document.querySelector('input[name="uri"]');
    input.value = 'magnet:?xt=urn:btih:test';

    const form = document.querySelector('.dl-form');
    form.dispatchEvent(new Event('submit', { cancelable: true }));

    await vi.waitFor(() => {
      expect(form.classList.contains('disabled')).toBe(true);
      expect(input.disabled).toBe(true);
    });

    resolveDownload();
  });

  test('cancelled folder dialog does not start download', async () => {
    window.__mocks__.open.mockResolvedValue(null); // user cancelled

    const input = document.querySelector('input[name="uri"]');
    input.value = 'magnet:?xt=urn:btih:abc';

    const form = document.querySelector('.dl-form');
    form.dispatchEvent(new Event('submit', { cancelable: true }));

    // Wait a tick
    await new Promise(r => setTimeout(r, 10));

    expect(window.__mocks__.invoke).not.toHaveBeenCalledWith(
      'do_download',
      expect.anything()
    );
  });

  test('download failure displays error in summary', async () => {
    window.__mocks__.invoke.mockImplementation((cmd) => {
      if (cmd === 'get_name') return Promise.resolve('Test');
      if (cmd === 'do_download') return Promise.reject('connection timeout');
      if (cmd === 'get_cli_arg') return Promise.resolve(null);
      return Promise.resolve(null);
    });
    window.__mocks__.open.mockResolvedValue('/tmp');

    const input = document.querySelector('input[name="uri"]');
    input.value = 'magnet:?xt=urn:btih:fail';

    const form = document.querySelector('.dl-form');
    form.dispatchEvent(new Event('submit', { cancelable: true }));

    await vi.waitFor(() => {
      const summary = document.querySelector('[data-summary]');
      expect(summary.textContent).toContain('Download failed');
      expect(summary.textContent).toContain('connection timeout');
    });
  });
});

describe('Progress Channel Updates', () => {
  test('progress bar and peers update from channel messages', async () => {
    let capturedChannel;
    window.__mocks__.invoke.mockImplementation((cmd, args) => {
      if (cmd === 'get_name') return Promise.resolve('Torrent');
      if (cmd === 'do_download') {
        capturedChannel = args.callback;
        return new Promise(() => { }); // never resolves
      }
      if (cmd === 'get_cli_arg') return Promise.resolve(null);
      return Promise.resolve(null);
    });
    window.__mocks__.open.mockResolvedValue('/tmp');

    await loadApp();

    const input = document.querySelector('input[name="uri"]');
    input.value = 'magnet:?xt=urn:btih:progress';

    const form = document.querySelector('.dl-form');
    form.dispatchEvent(new Event('submit', { cancelable: true }));

    await vi.waitFor(() => {
      expect(capturedChannel).toBeDefined();
    });

    // Simulate a progress message
    capturedChannel.onmessage({
      bytes: { total: 1000, downloaded: 500 },
      peers: {
        '192.168.1.1:6881': {
          origin: 'DHT',
          client: 'qBittorrent',
          proto: 'TCP',
          encrypted: true,
          download: {
            bytesReceived: 250,
            amInterested: false,
            peerChoking: true,
            lastBitrateBps: 0
          },
          upload: {
            bytesSent: 100,
            peerInterested: false,
            amChoking: true,
            lastBitrateBps: 0
          },
          reqq: null,
        },
      },
    });

    const bar = document.querySelector('.progress-bar');
    expect(bar.style.width).toBe('50%');

    const label = document.querySelector('.progress-label');
    expect(label.textContent).toBe('50.0%');

    const summary = document.querySelector('[data-summary]');
    expect(summary.textContent).toContain('50.00%');

    const rows = document.querySelectorAll('.peers-table tbody tr');
    expect(rows.length).toBe(1);
    const cells = rows[0].cells;
    expect(cells[0].textContent).toBe('192.168.1.1:6881'); // Address
    expect(cells[1].textContent).toBe('qBittorrent');       // Client
    expect(cells[2].textContent).toBe('TCP');               // Protocol
    expect(cells[3].textContent).toBe('yes');               // Encrypted
    expect(cells[4].textContent).toBe('DHT');               // Origin
    expect(cells[5].textContent).toBe('250 B');             // Downloaded
    expect(cells[6].textContent).toBe('100 B');             // Uploaded
  });
});

describe('File Picker', () => {
  beforeEach(async () => {
    window.__mocks__.invoke.mockResolvedValue(null);
    await loadApp();
  });

  test('select button opens file dialog and sets input value', async () => {
    window.__mocks__.open.mockResolvedValue('/home/user/file.torrent');

    const pickBtn = document.querySelector('button[data-action="pick"]');
    pickBtn.click();

    await vi.waitFor(() => {
      const input = document.querySelector('input[name="uri"]');
      expect(input.value).toBe('/home/user/file.torrent');
    });

    expect(window.__mocks__.open).toHaveBeenCalledWith(
      expect.objectContaining({
        multiple: false,
        filters: expect.arrayContaining([
          expect.objectContaining({ extensions: ['torrent'] }),
        ]),
      })
    );
  });
});

describe('CLI Argument', () => {
  test('auto-starts download when CLI arg is provided', async () => {
    window.__mocks__.invoke.mockImplementation((cmd) => {
      if (cmd === 'get_cli_arg') return Promise.resolve('/path/to/file.torrent');
      if (cmd === 'get_name') return Promise.resolve('CLI Torrent');
      if (cmd === 'do_download') return Promise.resolve();
      return Promise.resolve(null);
    });
    window.__mocks__.open.mockResolvedValue('/tmp/output');

    await loadApp();

    await vi.waitFor(() => {
      expect(window.__mocks__.invoke).toHaveBeenCalledWith('get_name', {
        metainfoUri: '/path/to/file.torrent',
      });
    });
  });
});

describe('Toast Notifications', () => {
  beforeEach(async () => {
    window.__mocks__.invoke.mockResolvedValue(null);
    await loadApp();
  });

  test('toast appears and has correct class', () => {
    const form = document.querySelector('.dl-form');
    form.dispatchEvent(new Event('submit', { cancelable: true }));

    const toast = document.querySelector('.toast');
    expect(toast).not.toBeNull();
    expect(toast.classList.contains('toast-error')).toBe(true);
  });
});
