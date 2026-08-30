/* =====================================================
   detector.js — 書類の四隅自動検出 と 台形補正
   ・四隅検出には OpenCV.js (WASM) を使用する
   ・台形補正（ワープ）は純粋なJavaScriptで実装し、
     OpenCV.jsの読み込みに失敗しても動作を止めない
   ===================================================== */

const Detector = (() => {
  let cvReady = false;
  let cvGaveUp = false;

  // ---------- OpenCV.js の読み込み待機 ----------
  function waitForCv(timeoutMs = 12000) {
    const startedAt = Date.now();
    (function poll() {
      if (typeof window.cv !== 'undefined' && window.cv && window.cv.Mat) {
        cvReady = true;
        document.dispatchEvent(new CustomEvent('cv-ready'));
        return;
      }
      if (typeof window.cv !== 'undefined' && window.cv && !window.cv.Mat) {
        // cv オブジェクトはあるがWASM初期化待ち
        try {
          window.cv['onRuntimeInitialized'] = () => {
            cvReady = true;
            document.dispatchEvent(new CustomEvent('cv-ready'));
          };
          return;
        } catch (e) { /* fallthrough to polling */ }
      }
      if (Date.now() - startedAt > timeoutMs) {
        cvGaveUp = true;
        document.dispatchEvent(new CustomEvent('cv-unavailable'));
        return;
      }
      setTimeout(poll, 150);
    })();
  }
  waitForCv();

  function isReady() { return cvReady; }
  function hasGivenUp() { return cvGaveUp; }

  // ---------- 四隅を tl, tr, br, bl の順に並べ替え ----------
  function orderPoints(pts) {
    const sums = pts.map(p => p.x + p.y);
    const diffs = pts.map(p => p.y - p.x);
    const tl = pts[sums.indexOf(Math.min(...sums))];
    const br = pts[sums.indexOf(Math.max(...sums))];
    const tr = pts[diffs.indexOf(Math.min(...diffs))];
    const bl = pts[diffs.indexOf(Math.max(...diffs))];
    return [tl, tr, br, bl];
  }

  // ---------- 検出できない場合の実用的な初期値 ----------
  function defaultQuad(width, height, marginRatio = 0.08) {
    const mx = width * marginRatio;
    const my = height * marginRatio;
    return [
      { x: mx, y: my },
      { x: width - mx, y: my },
      { x: width - mx, y: height - my },
      { x: mx, y: height - my },
    ];
  }

  // ---------- OpenCV.js による書類輪郭の自動検出 ----------
  // source: HTMLVideoElement または HTMLCanvasElement
  // sourceWidth/sourceHeight: sourceの実寸(検出結果はこの座標系で返す)
  function detectQuad(source, sourceWidth, sourceHeight) {
    if (!cvReady) return null;

    const DETECT_WIDTH = 320;
    const scale = DETECT_WIDTH / sourceWidth;
    const detectHeight = Math.round(sourceHeight * scale);

    let small, gray, blurred, edges, dilated, contours, hierarchy;
    try {
      // 縮小フレームを作るための一時canvas
      const tmp = document.createElement('canvas');
      tmp.width = DETECT_WIDTH;
      tmp.height = detectHeight;
      const tctx = tmp.getContext('2d');
      tctx.drawImage(source, 0, 0, DETECT_WIDTH, detectHeight);

      small = cv.imread(tmp);
      gray = new cv.Mat();
      cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);

      blurred = new cv.Mat();
      cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

      edges = new cv.Mat();
      cv.Canny(blurred, edges, 50, 150);

      dilated = new cv.Mat();
      const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
      cv.dilate(edges, dilated, kernel);
      kernel.delete();

      contours = new cv.MatVector();
      hierarchy = new cv.Mat();
      cv.findContours(dilated, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

      const frameArea = DETECT_WIDTH * detectHeight;
      let bestPoints = null;
      let bestArea = frameArea * 0.15; // これより小さい輪郭は書類とみなさない

      for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const area = cv.contourArea(cnt);
        if (area > bestArea) {
          const peri = cv.arcLength(cnt, true);
          const approx = new cv.Mat();
          cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
          if (approx.rows === 4 && cv.isContourConvex(approx)) {
            const pts = [];
            for (let r = 0; r < 4; r++) {
              pts.push({ x: approx.data32S[r * 2], y: approx.data32S[r * 2 + 1] });
            }
            bestArea = area;
            bestPoints = pts;
          }
          approx.delete();
        }
        cnt.delete();
      }

      if (!bestPoints) return null;

      // 縮小前の座標系へスケールし直す
      const scaled = bestPoints.map(p => ({ x: p.x / scale, y: p.y / scale }));
      return orderPoints(scaled);
    } catch (err) {
      console.warn('検出処理でエラーが発生しました', err);
      return null;
    } finally {
      [small, gray, blurred, edges, dilated, hierarchy].forEach(m => m && m.delete());
      if (contours) contours.delete();
    }
  }

  // ---------- 4点の座標から出力サイズを計算 ----------
  function computeOutputSize(pts) {
    const [tl, tr, br, bl] = pts;
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const widthTop = dist(tl, tr);
    const widthBottom = dist(bl, br);
    const heightLeft = dist(tl, bl);
    const heightRight = dist(tr, br);
    let w = Math.round(Math.max(widthTop, widthBottom));
    let h = Math.round(Math.max(heightLeft, heightRight));

    const MAX_DIM = 1800;
    if (w > MAX_DIM || h > MAX_DIM) {
      const s = MAX_DIM / Math.max(w, h);
      w = Math.round(w * s);
      h = Math.round(h * s);
    }
    w = Math.max(w, 40);
    h = Math.max(h, 40);
    return { width: w, height: h };
  }

  // ---------- 3x3行列の逆行列 ----------
  function invert3x3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
    const G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-12) return null;
    const invDet = 1 / det;
    return [A * invDet, D * invDet, G * invDet,
            B * invDet, E * invDet, H * invDet,
            C * invDet, F * invDet, I * invDet];
  }

  // ---------- 8元連立方程式を解く（部分ピボット付きガウス消去法） ----------
  function solve8(A, B) {
    const n = 8;
    const M = A.map((row, i) => [...row, B[i]]);
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let r = col + 1; r < n; r++) {
        if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
      }
      [M[col], M[pivot]] = [M[pivot], M[col]];
      const pv = M[col][col] || 1e-12;
      for (let c = col; c <= n; c++) M[col][c] /= pv;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const factor = M[r][col];
        if (factor === 0) continue;
        for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
      }
    }
    return M.map(row => row[n]);
  }

  // srcPts (書類の四隅) -> dstPts(出力の長方形) への射影変換行列(3x3, dst = H * src)
  function getHomography(srcPts, dstPts) {
    const A = [];
    const B = [];
    for (let i = 0; i < 4; i++) {
      const { x: sx, y: sy } = srcPts[i];
      const { x: dx, y: dy } = dstPts[i];
      A.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy]);
      B.push(dx);
      A.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy]);
      B.push(dy);
    }
    const h = solve8(A, B);
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }

  // ---------- 台形補正の実行（純粋JS・双一次補間） ----------
  // sourceCanvas: 元画像の描かれたcanvas
  // srcPts: 元画像上の四隅(tl,tr,br,bl)
  // 戻り値: 補正後の新しいcanvas
  function warpPerspective(sourceCanvas, srcPts) {
    const { width: outW, height: outH } = computeOutputSize(srcPts);
    const dstPts = [
      { x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH },
    ];

    const H = getHomography(srcPts, dstPts);
    const Hinv = invert3x3(H);

    const sctx = sourceCanvas.getContext('2d');
    const srcData = sctx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
    const sw = sourceCanvas.width, sh = sourceCanvas.height;
    const sPix = srcData.data;

    const outCanvas = document.createElement('canvas');
    outCanvas.width = outW;
    outCanvas.height = outH;
    const octx = outCanvas.getContext('2d');
    const outData = octx.createImageData(outW, outH);
    const oPix = outData.data;

    if (!Hinv) {
      // 特異行列の場合は等倍コピーで安全側に倒す
      octx.drawImage(sourceCanvas, 0, 0, outW, outH);
      return outCanvas;
    }

    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        const w = Hinv[6] * x + Hinv[7] * y + Hinv[8];
        const sx = (Hinv[0] * x + Hinv[1] * y + Hinv[2]) / w;
        const sy = (Hinv[3] * x + Hinv[4] * y + Hinv[5]) / w;

        const outIdx = (y * outW + x) * 4;
        if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1) {
          oPix[outIdx] = 255; oPix[outIdx + 1] = 255; oPix[outIdx + 2] = 255; oPix[outIdx + 3] = 255;
          continue;
        }

        // 双一次補間
        const x0 = Math.floor(sx), y0 = Math.floor(sy);
        const x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1);
        const fx = sx - x0, fy = sy - y0;

        const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
        const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;

        for (let c = 0; c < 4; c++) {
          const top = sPix[i00 + c] * (1 - fx) + sPix[i10 + c] * fx;
          const bottom = sPix[i01 + c] * (1 - fx) + sPix[i11 + c] * fx;
          oPix[outIdx + c] = top * (1 - fy) + bottom * fy;
        }
      }
    }

    octx.putImageData(outData, 0, 0);
    return outCanvas;
  }

  return {
    isReady, hasGivenUp, detectQuad, orderPoints, defaultQuad,
    warpPerspective, computeOutputSize,
  };
})();
