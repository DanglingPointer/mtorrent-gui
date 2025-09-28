const { invoke } = window.__TAURI__.core;
const { Channel } = window.__TAURI__.core;
const { open } = window.__TAURI__.dialog;

let tabIdSeq = 0;

function ensureToastContainer() {
  let c = document.querySelector('.toast-container');
  if (!c) {
    c = document.createElement('div');
    c.className = 'toast-container';
    document.body.appendChild(c);
  }
  return c;
}

function showToast(message, kind = 'error', timeout = 3500) {
  const container = ensureToastContainer();
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  container.appendChild(el);
  // trigger animation
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    el.classList.add('hide');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  }, timeout);
}

function createTabElements(id) {
  const panel = document.createElement('div');
  panel.className = 'tab-panel';
  panel.dataset.tabId = id;
  panel.innerHTML = `
    <h2 class="title">Welcome to mtorrent!</h2>
    <form class="dl-form" autocomplete="off">
      <div class="uri-row">
        <input name="uri" placeholder="Enter magnet link or file path" />
        <button type="button" data-action="pick" title="Select metainfo file">Select...</button>
      </div>
      <div class="actions-row">
        <button class="start-btn" type="submit">Start download</button>
      </div>
    </form>
    <div class="progress" aria-label="Download progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
      <div class="progress-bar" style="width:0%"></div>
      <div class="progress-label">0%</div>
    </div>
    <div class="peers-wrapper">
      <div class="peers-summary" data-summary>Downloaded 0 / 0 bytes (0.00%)</div>
      <div class="peers-table-container">
        <table class="peers-table" aria-label="Connected peers">
          <thead>
            <tr>
              <th>Address</th>
              <th>Client</th>
              <th>Origin</th>
              <th>Downloaded</th>
              <th>Uploaded</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
  `;
  return panel;
}

function createTabButton(id) {
  const btn = document.createElement('button');
  btn.className = 'tab-btn';
  btn.dataset.tabId = id;
  btn.innerHTML = `<span class="label">Tab ${id}</span><span class="close" title="Close">×</span>`;
  return btn;
}

function setActiveTab(id) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tabId === id));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('hidden', p.dataset.tabId !== id));
}

async function startDownload(panel, tabBtn) {
  const input = panel.querySelector('input[name="uri"]');
  const peersSummaryEl = panel.querySelector('[data-summary]');
  const peersTbody = panel.querySelector('.peers-table tbody');
  if (!peersSummaryEl || !peersTbody) {
    throw new Error('Required peers UI elements missing');
  }
  const titleEl = panel.querySelector('.title');
  const form = panel.querySelector('.dl-form');

  const uri = input.value.trim();
  if (!uri) {
    showToast('Magnet link or .torrent file path is required');
    input.focus();
    return;
  }

  const outputDir = await open({ multiple: false, directory: true, title: 'Select output folder' });
  if (!outputDir) return; // user cancelled

  const channel = new Channel();
  channel.onmessage = msg => {
    // Expect a JSON snapshot matching StateSnapshot serialization.
    if (msg && typeof msg === 'object') {
      try {
        const bytes = msg.bytes;
        const total = bytes.total || 0;
        const downloaded = bytes.downloaded || 0;
        const pct = total > 0 ? Math.min(100, Math.max(0, (downloaded / total) * 100)) : 0;

        const progressEl = panel.querySelector('.progress');
        progressEl.setAttribute('aria-valuenow', pct.toFixed(2));

        const bar = progressEl.querySelector('.progress-bar');
        const label = progressEl.querySelector('.progress-label');
        if (bar) bar.style.width = pct + '%';
        if (label) label.textContent = `${pct.toFixed(1)}%`;
        // Build peer list: one peer per line -> IP (client | origin)
        peersSummaryEl.textContent = `Downloaded ${downloaded} / ${total} bytes (${pct.toFixed(2)}%)`;
        const peers = msg.peers || {};
        // Clear existing rows efficiently
        while (peersTbody.firstChild) peersTbody.removeChild(peersTbody.firstChild);
        const frag = document.createDocumentFragment();
        const sortedAddrs = Object.keys(peers).sort();
        for (const addr of sortedAddrs) {
          const p = peers[addr] || {};
          const origin = p.origin;
          const client = p.client || 'n/a';
          const downloadedBytes = typeof p.download.bytes_received === 'number' ? p.download.bytes_received : null;
          const uploadedBytes = typeof p.upload.bytes_sent === 'number' ? p.upload.bytes_sent : null;
          const downloadedVal = downloadedBytes == null ? 'n/a' : formatBytes(downloadedBytes);
          const uploadedVal = uploadedBytes == null ? 'n/a' : formatBytes(uploadedBytes);
          const tr = document.createElement('tr');
          const tdAddr = document.createElement('td');
          tdAddr.textContent = addr;
          const tdClient = document.createElement('td');
          tdClient.textContent = client;
          const tdOrigin = document.createElement('td');
          tdOrigin.textContent = origin;
          const tdDown = document.createElement('td');
          tdDown.textContent = downloadedVal;
          tdDown.className = 'num';
          const tdUp = document.createElement('td');
          tdUp.textContent = uploadedVal;
          tdUp.className = 'num';
          tr.appendChild(tdAddr);
          tr.appendChild(tdClient);
          tr.appendChild(tdOrigin);
          tr.appendChild(tdDown);
          tr.appendChild(tdUp);
          frag.appendChild(tr);
        }
        peersTbody.appendChild(frag);
      } catch (_) {
        peersSummaryEl.textContent = JSON.stringify(msg);
      }
    } else {
      peersSummaryEl.textContent = String(msg);
    }
  };

  let torrentName;
  try {
    torrentName = await invoke('get_name', { metainfoUri: uri });
    titleEl.textContent = torrentName;
  } catch {
    torrentName = `Tab ${panel.dataset.tabId}`;
  }
  tabBtn.querySelector('.label').textContent = torrentName.slice(0, 12);
  form.classList.add('disabled');
  form.querySelectorAll('input, button').forEach(el => el.disabled = true);

  try {
    peersSummaryEl.textContent = 'Loading...';
    await invoke('do_download', { metainfoUri: uri, outputDir, callback: channel });
    peersSummaryEl.textContent = 'Download finished successfully!';
  } catch (e) {
    peersSummaryEl.textContent = `Download failed: ${e}`;
  }
  // Clear peers table
  while (peersTbody.firstChild) peersTbody.removeChild(peersTbody.firstChild);
}

// Human-readable byte formatting
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

function addNewTab(autoActivate = true) {
  const id = (++tabIdSeq).toString();
  const tabsScroll = document.getElementById('tabs-scroll');
  const container = document.getElementById('tabs-container');

  const btn = createTabButton(id);
  const panel = createTabElements(id);
  container.appendChild(panel);
  tabsScroll.appendChild(btn);

  btn.addEventListener('click', (e) => {
    if ((e.target).classList.contains('close')) {
      // Stop download
      const uri = panel.querySelector('input[name="uri"]').value.trim();
      if (uri) {
        invoke('stop_download', { metainfoUri: uri }).catch(() => { /* ignore */ });
      }
      // Close tab
      panel.remove();
      btn.remove();
      // Activate last tab if current closed
      const last = [...document.querySelectorAll('.tab-btn')].pop();
      if (last) setActiveTab(last.dataset.tabId);
      return;
    }
    setActiveTab(id);
  });

  const form = panel.querySelector('form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    startDownload(panel, btn);
  });

  form.querySelector('button[data-action="pick"]').addEventListener('click', (e) => {
    e.preventDefault();

    open({ multiple: false, title: 'Select metainfo file', filters: [{ name: 'Torrent Files', extensions: ['torrent'] }] })
      .then(path => {
        if (path) form.querySelector('input[name="uri"]').value = path;
      });
  });

  if (autoActivate) setActiveTab(id);
  return { id, panel, btn };
}

window.addEventListener('DOMContentLoaded', () => {
  // document.documentElement.dataset.theme = 'dark';
  document.getElementById('add-tab').addEventListener('click', () => addNewTab(true));
  addNewTab(true); // initial tab
});
