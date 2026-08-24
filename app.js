'use strict';

const $ = (s) => document.querySelector(s);

const video = $('#cam');
const stage = $('#stage');
const obj = $('#obj');
const img = $('#overlay');
const toastEl = $('#toast');
const pickInput = $('#file-pick');
const shotInput = $('#file-shot');

/* ---------- estado ---------- */
// T = transformação da imagem em coordenadas de tela (x,y = centro da imagem)
const T = { x: 0, y: 0, scale: 1, rot: 0 };
const S = { locked: false, flip: false, grid: false, hidden: false, lineart: false };

let stream = null;
let facing = 'environment';
let wakeLock = null;
let objectUrl = null;
let awaitingShot = false;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ---------- render ---------- */
function render() {
  const sx = S.flip ? -T.scale : T.scale;
  obj.style.transform =
    `translate(${T.x}px, ${T.y}px) rotate(${T.rot}rad) scale(${sx}, ${T.scale}) translate(-50%, -50%)`;
  // contra-escala das linhas da grade para manterem ~1px na tela
  obj.style.setProperty('--gw', `${clamp(1 / T.scale, 0.02, 200)}px`);
}

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
}

/* ---------- câmera ---------- */
function stopCamera() {
  if (!stream) return;
  stream.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
}

async function startCamera() {
  stopCamera();

  if (!window.isSecureContext) {
    return camError('A câmera só funciona em HTTPS (ou em localhost). Publique o app em um endereço https:// e abra por lá.');
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return camError('Este navegador não expõe a API de câmera. No iPhone, abra pelo Safari.');
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: facing },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    $('#cam-error').hidden = true;
  } catch (err) {
    const map = {
      NotAllowedError: 'Permissão negada. Libere o acesso à câmera nas configurações do site e tente de novo.',
      NotFoundError: 'Nenhuma câmera encontrada neste dispositivo.',
      NotReadableError: 'A câmera está sendo usada por outro aplicativo. Feche-o e tente de novo.',
    };
    camError(map[err.name] || `Não foi possível iniciar a câmera (${err.name}).`);
  }
}

function camError(msg) {
  $('#cam-error-msg').textContent = msg;
  $('#cam-error').hidden = false;
}

async function switchCamera() {
  facing = facing === 'environment' ? 'user' : 'environment';
  await startCamera();
  toast(facing === 'environment' ? 'Câmera traseira' : 'Câmera frontal');
}

/* ---------- imagem ---------- */
function loadFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) return toast('Arquivo não é uma imagem');
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  img.src = objectUrl;
}

img.addEventListener('load', () => {
  obj.hidden = false;
  document.body.classList.remove('no-image');
  // o elemento assume o tamanho natural; o zoom vem só do transform (composto na GPU)
  obj.style.width = `${img.naturalWidth}px`;
  obj.style.height = `${img.naturalHeight}px`;
  fit();
  if (S.lineart) buildArt();
});

img.addEventListener('error', () => toast('Não foi possível abrir esta imagem'));

function fit() {
  if (!img.naturalWidth) return;
  const vw = innerWidth, vh = innerHeight;
  T.scale = Math.min(vw / img.naturalWidth, vh / img.naturalHeight) * 0.85;
  T.x = vw / 2;
  T.y = vh / 2;
  T.rot = 0;
  render();
}

/* ---------- line art: grayscale -> Sobel -> threshold (WebGL) ----------
   Roda uma única vez por mudança de parâmetro, num canvas do tamanho da imagem.
   Depois disso é bitmap estático: o transform do #obj continua sendo a única
   coisa que acontece por frame. */

const artCanvas = $('#art');
const thresholdInput = $('#threshold');

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `
precision mediump float;
uniform sampler2D u_img;
uniform vec2  u_texel;
uniform float u_threshold;
uniform float u_softness;
varying vec2 v_uv;

float lum(vec2 uv) {
  vec3 c = texture2D(u_img, uv).rgb;
  return dot(c, vec3(0.299, 0.587, 0.114));
}

void main() {
  vec2 t = u_texel;
  float tl = lum(v_uv + vec2(-t.x,  t.y));
  float ml = lum(v_uv + vec2(-t.x,  0.0));
  float bl = lum(v_uv + vec2(-t.x, -t.y));
  float tc = lum(v_uv + vec2( 0.0,  t.y));
  float bc = lum(v_uv + vec2( 0.0, -t.y));
  float tr = lum(v_uv + vec2( t.x,  t.y));
  float mr = lum(v_uv + vec2( t.x,  0.0));
  float br = lum(v_uv + vec2( t.x, -t.y));

  // Sobel: derivada já com suavização [1 2 1] embutida, o que segura o ruído da foto
  float gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
  float gy =  tl + 2.0 * tc + tr - bl - 2.0 * bc - br;
  float g  = length(vec2(gx, gy));

  // borda suave em vez de corte duro: sem isso o traço fica serrilhado
  float a = smoothstep(u_threshold, u_threshold + u_softness, g);

  // preto com alfa = fundo transparente, então a câmera aparece entre os traços.
  // RGB zerado já é o premultiplied correto para preto.
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}`;

let gl = null, uni = null, tex = null, scratch = null, artReady = false;

function compile(type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(sh) || 'falha ao compilar shader');
  }
  return sh;
}

function initGL() {
  if (gl) return true;
  gl = artCanvas.getContext('webgl', { alpha: true, antialias: false, depth: false, stencil: false })
    || artCanvas.getContext('experimental-webgl');
  if (!gl) return false;

  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(prog) || 'falha ao linkar programa');
  }
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  uni = {
    texel: gl.getUniformLocation(prog, 'u_texel'),
    threshold: gl.getUniformLocation(prog, 'u_threshold'),
    softness: gl.getUniformLocation(prog, 'u_softness'),
  };

  tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  return true;
}

// Sobe a imagem como textura, reduzindo se passar do limite da GPU.
function uploadSource() {
  const max = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), 4096);
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  const k = longest > max ? max / longest : 1;
  const w = Math.max(1, Math.round(img.naturalWidth * k));
  const h = Math.max(1, Math.round(img.naturalHeight * k));

  let source = img;
  if (k < 1) {
    // texImage2D falharia acima de MAX_TEXTURE_SIZE — reduz antes de subir
    scratch = scratch || document.createElement('canvas');
    scratch.width = w;
    scratch.height = h;
    scratch.getContext('2d').drawImage(img, 0, 0, w, h);
    source = scratch;
  }

  artCanvas.width = w;
  artCanvas.height = h;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.viewport(0, 0, w, h);
  gl.uniform2f(uni.texel, 1 / w, 1 / h);   // o Sobel anda 1 texel, não 1 pixel da tela
  artReady = true;
}

function drawArt() {
  if (!artReady) return;
  gl.uniform1f(uni.threshold, 0.05 + (thresholdInput.value / 100) * 1.2);
  gl.uniform1f(uni.softness, 0.12);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function buildArt() {
  try {
    if (!initGL()) { toast('WebGL indisponível neste navegador'); return false; }
    uploadSource();
    drawArt();
    return true;
  } catch (err) {
    artReady = false;
    toast(`Falha no filtro de contorno: ${err.message}`);
    return false;
  }
}

// O navegador pode descartar o contexto WebGL a qualquer momento no celular
// (troca de app, pressão de memória). Sem isso o contorno some e não volta.
artCanvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); gl = null; uni = null; tex = null; artReady = false; });
artCanvas.addEventListener('webglcontextrestored', () => { if (S.lineart) buildArt(); });

/* ---------- gestos ---------- */
const pts = new Map();     // pointerId -> {x,y}
let prev = null;           // descritor do gesto no frame anterior

function descriptor() {
  const a = [...pts.values()];
  if (a.length === 0) return null;
  if (a.length === 1) return { n: 1, mx: a[0].x, my: a[0].y, dist: 0, ang: 0 };
  const [p, q] = a;
  return {
    n: a.length,
    mx: (p.x + q.x) / 2,
    my: (p.y + q.y) / 2,
    dist: Math.hypot(q.x - p.x, q.y - p.y),
    ang: Math.atan2(q.y - p.y, q.x - p.x),
  };
}

const angDiff = (a, b) => {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
};

stage.addEventListener('pointerdown', (e) => {
  if (S.locked || obj.hidden) return;
  try { stage.setPointerCapture(e.pointerId); } catch { /* ponteiro já liberado */ }
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  prev = descriptor();   // rebaseia: adicionar um dedo nunca provoca salto
});

stage.addEventListener('pointermove', (e) => {
  if (!pts.has(e.pointerId)) return;
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

  const cur = descriptor();
  if (prev && cur && prev.n === cur.n) applyGesture(prev, cur);
  prev = cur;
});

function endPointer(e) {
  if (!pts.delete(e.pointerId)) return;
  prev = descriptor();   // rebaseia ao soltar um dedo
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);

// Transformação de similaridade em torno do pivô (ponto médio dos dedos):
// o pixel sob os dedos permanece sob os dedos enquanto escala e gira.
function applyGesture(a, b) {
  const k = (a.dist > 0 && b.dist > 0) ? b.dist / a.dist : 1;
  const dth = (a.n > 1) ? angDiff(b.ang, a.ang) : 0;

  const px = a.mx, py = a.my;
  const dx = T.x - px, dy = T.y - py;
  const c = Math.cos(dth), s = Math.sin(dth);

  T.x = px + k * (dx * c - dy * s) + (b.mx - a.mx);
  T.y = py + k * (dx * s + dy * c) + (b.my - a.my);
  T.scale = clamp(T.scale * k, 0.02, 40);
  T.rot += dth;
  render();
}

// zoom por roda / trackpad (desktop), com pivô no cursor
stage.addEventListener('wheel', (e) => {
  if (S.locked || obj.hidden) return;
  e.preventDefault();
  const next = clamp(T.scale * Math.exp(-e.deltaY * 0.0015), 0.02, 40);
  const eff = next / T.scale;
  T.x = e.clientX + (T.x - e.clientX) * eff;
  T.y = e.clientY + (T.y - e.clientY) * eff;
  T.scale = next;
  render();
}, { passive: false });

/* ---------- ações ---------- */
const actions = {
  pick() { pickInput.value = ''; pickInput.click(); },

  // Solta a câmera antes de abrir o app nativo — no Android o hardware é exclusivo.
  shot() {
    awaitingShot = true;
    stopCamera();
    shotInput.value = '';
    shotInput.click();
  },

  fit,
  retry: startCamera,
  cam: switchCamera,

  lock() {
    S.locked = !S.locked;
    document.body.classList.toggle('locked', S.locked);
    $('.lock-label').textContent = S.locked ? 'Travado' : 'Travar';
    toast(S.locked ? 'Imagem travada — pode desenhar' : 'Imagem liberada');
  },

  flip() {
    S.flip = !S.flip;
    document.body.classList.toggle('flip', S.flip);
    render();
  },

  grid() {
    S.grid = !S.grid;
    document.body.classList.toggle('grid', S.grid);
  },

  art() {
    if (S.lineart) {
      S.lineart = false;
      document.body.classList.remove('lineart');
      return;
    }
    if (!img.naturalWidth) return toast('Carregue uma imagem primeiro');
    if (!buildArt()) return;                 // erro já reportado, não entra no modo
    S.lineart = true;
    document.body.classList.add('lineart');
  },

  hide() {
    S.hidden = !S.hidden;
    document.body.classList.toggle('hidden-ui', S.hidden);
  },

  full() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => toast('Tela cheia indisponível'));
    } else {
      toast('Tela cheia indisponível neste navegador');
    }
  },
};

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (btn && actions[btn.dataset.act]) actions[btn.dataset.act]();
});

pickInput.addEventListener('change', (e) => loadFile(e.target.files[0]));
shotInput.addEventListener('change', (e) => {
  awaitingShot = false;
  loadFile(e.target.files[0]);
  startCamera();
});
// se o usuário cancelar a câmera nativa, o change nunca dispara
window.addEventListener('focus', () => {
  if (awaitingShot) { awaitingShot = false; startCamera(); }
});

const opacity = $('#opacity');
opacity.addEventListener('input', () => {
  // via variável CSS porque vale para a foto e para o contorno, mas não para a grade
  obj.style.setProperty('--op', opacity.value / 100);
  $('#opacity-val').textContent = `${opacity.value}%`;
});

thresholdInput.addEventListener('input', () => {
  $('#threshold-val').textContent = thresholdInput.value;
  drawArt();
});

/* desktop: arrastar e colar */
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => { e.preventDefault(); loadFile(e.dataTransfer.files[0]); });
document.addEventListener('paste', (e) => {
  const items = e.clipboardData ? [...e.clipboardData.items] : [];
  const item = items.find((i) => i.type.startsWith('image/'));
  if (item) loadFile(item.getAsFile());
});

/* ---------- tela sempre acesa ---------- */
async function keepAwake() {
  try {
    if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* sem suporte ou negado */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  keepAwake();
  if (!stream && !awaitingShot) startCamera();
});

addEventListener('resize', () => { if (!obj.hidden) render(); });

/* ---------- boot ---------- */
render();
startCamera();
keepAwake();

if ('serviceWorker' in navigator) {
  addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      // procura versão nova sempre que o app volta ao primeiro plano;
      // o sw novo assume sozinho (skipWaiting + clients.claim), sem recarregar a página
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update();
      });
    } catch { /* sem service worker disponível */ }
  });
}
