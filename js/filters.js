/* =====================================================
   filters.js — カラー / グレースケール / 白黒
   ・明るさ / コントラスト調整
   ===================================================== */

const Filters = (() => {
  // sourceCanvas: 補正済み(台形補正後)の元画像
  // settings: { mode: 'color'|'gray'|'bw', brightness: -60~60, contrast: -60~60 }
  // targetCanvas: 結果を描画する先のcanvas（サイズは自動設定される）
  function apply(sourceCanvas, settings, targetCanvas) {
    const w = sourceCanvas.width, h = sourceCanvas.height;
    targetCanvas.width = w;
    targetCanvas.height = h;

    const sctx = sourceCanvas.getContext('2d');
    const tctx = targetCanvas.getContext('2d');
    const imageData = sctx.getImageData(0, 0, w, h);
    const data = imageData.data;

    const brightness = settings.brightness || 0;
    const contrastInput = settings.contrast || 0;
    // -60~60 の入力を穏やかなコントラスト係数に変換
    const factor = (259 * (contrastInput + 255)) / (255 * (259 - contrastInput));

    for (let i = 0; i < data.length; i += 4) {
      let r = data[i], g = data[i + 1], b = data[i + 2];

      if (settings.mode !== 'color') {
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        r = g = b = lum;
      }

      r = factor * (r - 128) + 128 + brightness;
      g = factor * (g - 128) + 128 + brightness;
      b = factor * (b - 128) + 128 + brightness;

      if (settings.mode === 'bw') {
        const v = (r + g + b) / 3 > 150 ? 255 : 0;
        r = g = b = v;
      }

      data[i] = clamp(r);
      data[i + 1] = clamp(g);
      data[i + 2] = clamp(b);
    }

    tctx.putImageData(imageData, 0, 0);
    return targetCanvas;
  }

  function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

  function makeThumbnail(sourceCanvas, maxSize = 220) {
    const scale = Math.min(1, maxSize / Math.max(sourceCanvas.width, sourceCanvas.height));
    const tw = Math.round(sourceCanvas.width * scale);
    const th = Math.round(sourceCanvas.height * scale);
    const c = document.createElement('canvas');
    c.width = tw; c.height = th;
    c.getContext('2d').drawImage(sourceCanvas, 0, 0, tw, th);
    return c.toDataURL('image/jpeg', 0.72);
  }

  return { apply, makeThumbnail };
})();
