/* =====================================================
   app.js — 画面遷移・カメラ制御・スキャンフロー全体の制御
   ===================================================== */

(() => {
  'use strict';

  // ---------- 状態 ----------
  let stream = null;
  let detectTimer = null;
  let lastDetectedQuad = null;      // detectSampleCanvas座標系
  let detectSampleCanvas = document.createElement('canvas');
  let boxRatio = 3 / 4;

  let currentSessionId = null;
  let sessionCreatedAt = null;
  let pages = [];                   // [{id, dataUrl, width, height, thumbnail, createdAt}]
  let activeDraft = null;           // { rawCanvas, quad } または { warpedCanvas }
  let reviewSettings = { mode: 'color', brightness: 0, contrast: 0 };
  let reviewRenderPending = false;

  let cornersState = null;          // { points, displayScale, dragIndex }
  let pagesDragState = null;

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const video = $('camera-video');
  const overlay = $('detect-overlay');
  const cameraStage = document.querySelector('.camera-stage');

  // =====================================================
  // 画面遷移
  // =====================================================
  function navigateTo(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    $(`screen-${name}`).classList.add('active');
    if (name !== 'camera') stopCameraStream();
    if (name === 'home') renderHistory();
  }

  function showToast(msg, duration = 2200) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => t.classList.remove('show'), duration);
  }

  function genId() {
    return 'scan_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  // =====================================================
  // セッション管理
  // =====================================================
  function startNewSession() {
    currentSessionId = genId();
    sessionCreatedAt = Date.now();
    pages = [];
  }

  async function persistSession() {
    if (!currentSessionId) return;
    if (pages.length === 0) {
      await ScanStorage.deleteScan(currentSessionId);
      return;
    }
    const ok = await ScanStorage.saveScan({
      id: currentSessionId,
      createdAt: sessionCreatedAt,
      updatedAt: Date.now(),
      pages: pages.map(p => ({ dataUrl: p.dataUrl, width: p.width, height: p.height, thumbnail: p.thumbnail })),
    });
    if (!ok) showToast('保存に失敗しました（容量が不足している可能性があります）');
  }

  // =====================================================
  // カメラ
  // =====================================================
  async function startCamera() {
    $('camera-permission').classList.add('hidden');
    $('camera-loading').classList.remove('hidden');
    setTimeout(() => $('camera-loading').classList.add('hidden'), 1600);

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      $('camera-loading').classList.add('hidden');
      $('camera-message-text').textContent = 'このブラウザはカメラに対応していません。下のボタンから写真を選択してください。';
      $('camera-permission').classList.remove('hidden');
      return;
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      await new Promise(resolve => {
        if (video.readyState >= 2) return resolve();
        video.onloadedmetadata = resolve;
      });
      setupCameraCanvases();
      startDetectionLoop();
    } catch (err) {
      console.warn('カメラの起動に失敗しました', err);
      $('camera-loading').classList.add('hidden');
      const msgEl = $('camera-message-text');
      if (err && err.name === 'NotAllowedError') {
        msgEl.textContent = 'カメラへのアクセスが許可されていません。設定を確認するか、下のボタンから写真を選択してください。';
      } else if (err && err.name === 'NotFoundError') {
        msgEl.textContent = 'カメラが見つかりませんでした。下のボタンから写真を選択してください。';
      } else {
        msgEl.textContent = 'カメラを利用できませんでした。下のボタンから写真を選択してください。';
      }
      $('camera-permission').classList.remove('hidden');
    }
  }

  function stopCameraStream() {
    clearInterval(detectTimer);
    detectTimer = null;
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
  }

  function getCoverCrop(vw, vh, targetRatio) {
    const vRatio = vw / vh;
    let sx, sy, sw, sh;
    if (vRatio > targetRatio) {
      sh = vh;
      sw = vh * targetRatio;
      sx = (vw - sw) / 2;
      sy = 0;
    } else {
      sw = vw;
      sh = vw / targetRatio;
      sx = 0;
      sy = (vh - sh) / 2;
    }
    return { sx, sy, sw, sh };
  }

  function setupCameraCanvases() {
    const rect = cameraStage.getBoundingClientRect();
    boxRatio = rect.width / rect.height;
    const DETECT_W = 480;
    detectSampleCanvas.width = DETECT_W;
    detectSampleCanvas.height = Math.round(DETECT_W / boxRatio);
    overlay.width = detectSampleCanvas.width;
    overlay.height = detectSampleCanvas.height;
  }

  function drawFrameToCanvas(targetCanvas) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return false;
    const targetRatio = targetCanvas.width / targetCanvas.height;
    const { sx, sy, sw, sh } = getCoverCrop(vw, vh, targetRatio);
    const ctx = targetCanvas.getContext('2d');
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, targetCanvas.width, targetCanvas.height);
    return true;
  }

  function startDetectionLoop() {
    clearInterval(detectTimer);
    detectTimer = setInterval(runDetectionTick, 350);
    runDetectionTick();
  }

  function runDetectionTick() {
    if (video.readyState < 2) return;
    if (!drawFrameToCanvas(detectSampleCanvas)) return;

    const statusEl = $('detect-status');

    if (!Detector.isReady()) {
      clearOverlay();
      statusEl.classList.remove('found');
      statusEl.textContent = Detector.hasGivenUp()
        ? '手動で四隅を調整してください'
        : '検出エンジンを準備中…';
      return;
    }

    const quad = Detector.detectQuad(detectSampleCanvas, detectSampleCanvas.width, detectSampleCanvas.height);
    if (quad) {
      lastDetectedQuad = quad;
      drawOverlayQuad(quad);
      statusEl.classList.add('found');
      statusEl.textContent = '書類を検出しました';
    } else {
      lastDetectedQuad = null;
      clearOverlay();
      statusEl.classList.remove('found');
      statusEl.textContent = '書類を探しています…';
    }
  }

  function clearOverlay() {
    overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
  }

  function drawOverlayQuad(pts, color) {
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    ctx.save();
    ctx.strokeStyle = color || 'rgba(56,224,209,0.95)';
    ctx.fillStyle = 'rgba(56,224,209,0.16)';
    ctx.lineWidth = 3;
    ctx.shadowColor = 'rgba(56,224,209,0.8)';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;
    pts.forEach(p => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = color || '#00A6A6';
      ctx.stroke();
    });
    ctx.restore();
  }

  // =====================================================
  // 撮影
  // =====================================================
  function scalePoints(pts, scale) {
    return pts.map(p => ({ x: p.x * scale, y: p.y * scale }));
  }

  function capturePhoto() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;

    const CAPTURE_MAX_W = 1600;
    const { sw } = getCoverCrop(vw, vh, boxRatio);
    const targetW = Math.min(CAPTURE_MAX_W, Math.round(sw));
    const captureCanvas = document.createElement('canvas');
    captureCanvas.width = targetW;
    captureCanvas.height = Math.round(targetW / boxRatio);
    drawFrameToCanvas(captureCanvas);

    const scale = captureCanvas.width / detectSampleCanvas.width;
    const quad = lastDetectedQuad
      ? scalePoints(lastDetectedQuad, scale)
      : Detector.defaultQuad(captureCanvas.width, captureCanvas.height);

    activeDraft = { rawCanvas: captureCanvas, quad };
    stopCameraStream();
    navigateTo('corners');
    openCornersScreen();
  }

  function loadImageFileToCanvas(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const MAX_W = 1800;
        const scale = Math.min(1, MAX_W / img.naturalWidth);
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c);
      };
      img.onerror = reject;
      img.src = url;
    });
  }

  async function handleFallbackFile(file) {
    if (!file) return;
    if (!currentSessionId) startNewSession();
    try {
      const canvas = await loadImageFileToCanvas(file);
      let quad = null;
      if (Detector.isReady()) {
        quad = Detector.detectQuad(canvas, canvas.width, canvas.height);
      }
      activeDraft = { rawCanvas: canvas, quad: quad || Detector.defaultQuad(canvas.width, canvas.height) };
      stopCameraStream();
      navigateTo('corners');
      openCornersScreen();
    } catch (err) {
      console.warn(err);
      showToast('画像を読み込めませんでした');
    }
  }

  // =====================================================
  // 四隅調整画面
  // =====================================================
  function openCornersScreen() {
    const canvas = $('corners-canvas');
    const stageEl = document.querySelector('.corners-stage');
    const rect = stageEl.getBoundingClientRect();
    const raw = activeDraft.rawCanvas;

    const availW = rect.width - 8;
    const availH = rect.height - 8;
    const displayScale = Math.min(availW / raw.width, availH / raw.height, 1);

    canvas.width = Math.round(raw.width * displayScale);
    canvas.height = Math.round(raw.height * displayScale);
    canvas.getContext('2d').drawImage(raw, 0, 0, canvas.width, canvas.height);

    cornersState = {
      points: scalePoints(activeDraft.quad, displayScale),
      displayScale,
      dragIndex: -1,
    };

    redrawCornersCanvas();
    wireCornersPointerEvents(canvas);
  }

  function redrawCornersCanvas() {
    const canvas = $('corners-canvas');
    const ctx = canvas.getContext('2d');
    ctx.drawImage(activeDraft.rawCanvas, 0, 0, canvas.width, canvas.height);

    const pts = cornersState.points;
    ctx.save();
    ctx.strokeStyle = '#00A6A6';
    ctx.fillStyle = 'rgba(0,166,166,0.18)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    pts.forEach(p => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 13, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,166,166,0.28)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#00A6A6';
      ctx.stroke();
    });
    ctx.restore();
  }

  function wireCornersPointerEvents(canvas) {
    function toCanvasXY(e) {
      const r = canvas.getBoundingClientRect();
      const scaleX = canvas.width / r.width;
      const scaleY = canvas.height / r.height;
      return { x: (e.clientX - r.left) * scaleX, y: (e.clientY - r.top) * scaleY };
    }
    function onDown(e) {
      const { x, y } = toCanvasXY(e);
      let closest = -1, closestDist = Infinity;
      cornersState.points.forEach((p, i) => {
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < closestDist) { closestDist = d; closest = i; }
      });
      if (closestDist < 45) {
        cornersState.dragIndex = closest;
        canvas.setPointerCapture(e.pointerId);
      }
    }
    function onMove(e) {
      if (cornersState.dragIndex < 0) return;
      const { x, y } = toCanvasXY(e);
      const c = $('corners-canvas');
      cornersState.points[cornersState.dragIndex] = {
        x: Math.max(0, Math.min(c.width, x)),
        y: Math.max(0, Math.min(c.height, y)),
      };
      redrawCornersCanvas();
    }
    function onUp() { cornersState.dragIndex = -1; }

    canvas.onpointerdown = onDown;
    canvas.onpointermove = onMove;
    canvas.onpointerup = onUp;
    canvas.onpointercancel = onUp;
  }

  function confirmCorners() {
    const nativePts = scalePoints(cornersState.points, 1 / cornersState.displayScale);
    const ordered = Detector.orderPoints(nativePts);
    const warped = Detector.warpPerspective(activeDraft.rawCanvas, ordered);
    activeDraft.warpedCanvas = warped;
    reviewSettings = { mode: 'color', brightness: 0, contrast: 0 };
    resetReviewUI();
    navigateTo('review');
    renderReviewCanvas();
  }

  // =====================================================
  // 撮影後確認（フィルター）画面
  // =====================================================
  function resetReviewUI() {
    document.querySelectorAll('.filter-chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.filter === 'color');
    });
    $('slider-brightness').value = 0;
    $('slider-contrast').value = 0;
  }

  function renderReviewCanvas() {
    if (reviewRenderPending) return;
    reviewRenderPending = true;
    requestAnimationFrame(() => {
      reviewRenderPending = false;
      if (!activeDraft || !activeDraft.warpedCanvas) return;
      Filters.apply(activeDraft.warpedCanvas, reviewSettings, $('review-canvas'));
    });
  }

  function finalizeCurrentPage() {
    const canvas = $('review-canvas');
    const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    const thumbnail = Filters.makeThumbnail(canvas);
    pages.push({
      id: genId(),
      dataUrl,
      width: canvas.width,
      height: canvas.height,
      thumbnail,
      createdAt: Date.now(),
    });
    activeDraft = null;
  }

  // =====================================================
  // 複数ページ確認画面
  // =====================================================
  function renderPagesScreen() {
    $('pages-count-tag').textContent = `${pages.length}ページ`;
    const list = $('pages-list');
    list.innerHTML = '';
    pages.forEach((page, idx) => {
      const card = document.createElement('div');
      card.className = 'page-card';
      card.dataset.id = page.id;
      card.innerHTML = `
        <span class="drag-handle" aria-label="並べ替え">
          <svg viewBox="0 0 24 24" width="18" height="18"><path d="M8 6h.01M16 6h.01M8 12h.01M16 12h.01M8 18h.01M16 18h.01" stroke-width="3"/></svg>
        </span>
        <span class="page-index mono-tag">${idx + 1}</span>
        <img class="page-thumb" src="${page.thumbnail}" alt="ページ${idx + 1}">
        <div class="page-info">
          <b>ページ ${idx + 1}</b>
          <span>${page.width}×${page.height}px</span>
        </div>
        <div class="page-actions">
          <button class="page-del" aria-label="削除">
            <svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>
          </button>
        </div>`;
      card.querySelector('.page-del').onclick = () => deletePage(page.id);
      wirePageDrag(card);
      list.appendChild(card);
    });
  }

  function deletePage(id) {
    pages = pages.filter(p => p.id !== id);
    renderPagesScreen();
    persistSession();
    if (pages.length === 0) showToast('すべてのページを削除しました');
  }

  function wirePageDrag(card) {
    const handle = card.querySelector('.drag-handle');
    handle.onpointerdown = (e) => {
      const list = $('pages-list');
      pagesDragState = { id: card.dataset.id, startY: e.clientY };
      card.classList.add('dragging');
      handle.setPointerCapture(e.pointerId);

      const onMove = (ev) => {
        const cards = Array.from(list.children);
        const dragCard = cards.find(c => c.dataset.id === pagesDragState.id);
        const others = cards.filter(c => c !== dragCard);
        for (const other of others) {
          const r = other.getBoundingClientRect();
          const mid = r.top + r.height / 2;
          if (ev.clientY < mid && other.compareDocumentPosition(dragCard) & Node.DOCUMENT_POSITION_FOLLOWING) {
            list.insertBefore(dragCard, other);
            break;
          }
          if (ev.clientY > mid && other.compareDocumentPosition(dragCard) & Node.DOCUMENT_POSITION_PRECEDING) {
            list.insertBefore(dragCard, other.nextSibling);
            break;
          }
        }
      };
      const onUp = () => {
        card.classList.remove('dragging');
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        const newOrderIds = Array.from(list.children).map(c => c.dataset.id);
        pages = newOrderIds.map(pid => pages.find(p => p.id === pid));
        renderPagesScreen();
        persistSession();
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    };
  }

  // =====================================================
  // 保存
  // =====================================================
  function downloadDataUrl(dataUrl, filename) {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function dataUrlToPngDataUrl(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        resolve(c.toDataURL('image/png'));
      };
      img.src = dataUrl;
    });
  }

  function dateStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  }

  async function saveAsPdf() {
    if (!pages.length) return;
    try {
      PdfExport.buildAndDownload(pages, `scan_${dateStamp()}.pdf`);
      $('save-note').textContent = 'PDFを保存しました。';
    } catch (err) {
      console.warn(err);
      showToast('PDFの作成に失敗しました。通信環境をご確認ください。');
    }
  }

  async function saveAsImages(format) {
    if (!pages.length) return;
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const ext = format === 'png' ? 'png' : 'jpg';
      const dataUrl = format === 'png' ? await dataUrlToPngDataUrl(page.dataUrl) : page.dataUrl;
      downloadDataUrl(dataUrl, `scan_${dateStamp()}_p${i + 1}.${ext}`);
      await new Promise(r => setTimeout(r, 350));
    }
    $('save-note').textContent = pages.length > 1
      ? `${pages.length}枚の画像をページごとに保存しました。`
      : '画像を保存しました。';
  }

  // =====================================================
  // ホーム / 履歴
  // =====================================================
  function formatDate(ts) {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  async function renderHistory() {
    const scans = await ScanStorage.getAllScans();
    $('history-count').textContent = `${scans.length}件`;
    $('history-empty').style.display = scans.length ? 'none' : 'block';
    const grid = $('history-grid');
    grid.innerHTML = '';
    scans.forEach(scan => {
      const item = document.createElement('div');
      item.className = 'history-item';
      const thumb = (scan.pages[0] && scan.pages[0].thumbnail) || '';
      item.innerHTML = `
        <img src="${thumb}" alt="スキャン">
        <button class="history-item-del" aria-label="削除">
          <svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>
        </button>
        <div class="history-item-meta">${scan.pages.length}p ・ ${formatDate(scan.updatedAt || scan.createdAt)}</div>`;
      item.querySelector('img').onclick = () => openHistorySession(scan);
      item.querySelector('.history-item-del').onclick = async (e) => {
        e.stopPropagation();
        await ScanStorage.deleteScan(scan.id);
        renderHistory();
      };
      grid.appendChild(item);
    });
  }

  function openHistorySession(scan) {
    currentSessionId = scan.id;
    sessionCreatedAt = scan.createdAt;
    pages = scan.pages.map(p => ({ ...p, id: genId() }));
    navigateTo('pages');
    renderPagesScreen();
  }

  // =====================================================
  // イベント配線
  // =====================================================
  function wireEvents() {
    $('btn-start-scan').onclick = () => {
      startNewSession();
      navigateTo('camera');
      startCamera();
    };

    $('file-fallback-home').onchange = (e) => handleFallbackFile(e.target.files[0]);
    $('file-fallback-camera').onchange = (e) => handleFallbackFile(e.target.files[0]);
    $('file-fallback-camera2').onchange = (e) => handleFallbackFile(e.target.files[0]);

    $('btn-camera-close').onclick = async () => {
      stopCameraStream();
      await persistSession();
      navigateTo('home');
    };

    $('btn-capture').onclick = capturePhoto;

    $('btn-corners-retake').onclick = () => {
      activeDraft = null;
      navigateTo('camera');
      startCamera();
    };
    $('btn-corners-confirm').onclick = () => {
      const btn = $('btn-corners-confirm');
      btn.disabled = true;
      showToast('補正しています…', 4000);
      setTimeout(() => {
        confirmCorners();
        btn.disabled = false;
      }, 30);
    };

    document.querySelectorAll('.filter-chip').forEach(chip => {
      chip.onclick = () => {
        document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        reviewSettings.mode = chip.dataset.filter;
        renderReviewCanvas();
      };
    });
    $('slider-brightness').oninput = (e) => {
      reviewSettings.brightness = Number(e.target.value);
      renderReviewCanvas();
    };
    $('slider-contrast').oninput = (e) => {
      reviewSettings.contrast = Number(e.target.value);
      renderReviewCanvas();
    };

    $('btn-review-retake').onclick = () => {
      activeDraft = null;
      navigateTo('camera');
      startCamera();
    };
    $('btn-review-addpage').onclick = () => {
      finalizeCurrentPage();
      persistSession();
      navigateTo('camera');
      $('page-count-pill').hidden = false;
      $('page-count-text').textContent = `${pages.length + 1}ページ目`;
      startCamera();
    };
    $('btn-review-done').onclick = async () => {
      finalizeCurrentPage();
      await persistSession();
      $('page-count-pill').hidden = true;
      navigateTo('pages');
      renderPagesScreen();
    };

    $('btn-pages-back').onclick = () => navigateTo('home');
    $('btn-pages-addmore').onclick = () => {
      navigateTo('camera');
      $('page-count-pill').hidden = false;
      $('page-count-text').textContent = `${pages.length + 1}ページ目`;
      startCamera();
    };

    $('btn-save-pdf').onclick = saveAsPdf;
    $('btn-save-jpeg').onclick = () => saveAsImages('jpeg');
    $('btn-save-png').onclick = () => saveAsImages('png');

    document.addEventListener('cv-ready', () => {
      $('camera-loading').classList.add('hidden');
    });
    document.addEventListener('cv-unavailable', () => {
      $('camera-loading').classList.add('hidden');
    });

    window.addEventListener('resize', () => {
      if (document.querySelector('#screen-camera.active') && stream) {
        setupCameraCanvases();
      }
    });
  }

  // ---------- 初期化 ----------
  document.addEventListener('DOMContentLoaded', () => {
    wireEvents();
    renderHistory();
  });
})();
