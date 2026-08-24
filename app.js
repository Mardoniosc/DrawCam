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
const S = { locked: false, flip: false, grid: false, hidden: false };

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
  img.style.opacity = opacity.value / 100;
  $('#opacity-val').textContent = `${opacity.value}%`;
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
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
