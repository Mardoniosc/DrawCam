# Traçar

Sobreponha uma imagem ao preview da câmera e copie os traços no papel — a funcionalidade central de apps como Artie Lab, SketchAR e Da Vinci Eye.

PWA estático, sem framework e sem build: `index.html` + `styles.css` + `app.js`.

## Como funciona

Não há AR de verdade — nem ARCore, nem ARKit, nem tracking de superfície. São duas camadas:

| Camada | Elemento | Papel |
|---|---|---|
| fundo | `<video>` com `getUserMedia({facingMode:'environment'})` | preview da câmera em tela cheia |
| frente | `<div id="obj">` com `transform` CSS | imagem semitransparente + grade |

O usuário aponta a câmera para a folha, alinha a imagem por cima com os dedos, **trava** e desenha olhando a tela.

### Decisões que importam

**Composição na GPU.** A imagem nunca é redesenhada. O `<img>` fica no tamanho natural e todo o zoom/rotação sai de um único `transform` CSS no elemento pai — o compositor resolve, e o preview da câmera continua a 30/60fps mesmo com uma foto de 12MP por cima. Redesenhar num `<canvas>` a cada frame derruba o framerate.

**Gesto incremental, não absoluto.** Cada `pointermove` compara o estado atual com o do evento anterior (ponto médio, distância e ângulo entre os dedos) e aplica o delta. Em `pointerdown`/`pointerup` a referência é rebaseada, então encostar ou soltar um dedo no meio do gesto nunca provoca salto — o defeito clássico de quem guarda o estado do início do gesto.

**Pivô no ponto médio.** Escala e rotação acontecem em torno dos dedos, não do centro da tela:

```
T' = p + k·R(dθ)·(T − p) + Δmid
```

onde `p` é o ponto médio anterior, `k` a razão das distâncias e `dθ` a variação de ângulo. Sem isso a imagem "foge" ao dar zoom.

**Grade contra-escalada.** As linhas usam `--gw: 1/scale px`, então continuam com ~1px na tela em qualquer nível de zoom em vez de virarem tarjas grossas.

**Wake Lock.** A tela apagando no meio do desenho é o bug de usabilidade número um destes apps. `navigator.wakeLock` é pedido no boot e re-pedido a cada `visibilitychange`.

**Câmera solta antes da foto nativa.** No Android o hardware é exclusivo: o `stream` é parado antes de abrir o `<input capture>` e reiniciado depois — inclusive se o usuário cancelar (via `window.focus`).

## Controles

| Controle | O que faz |
|---|---|
| Imagem | galeria / arquivos (no desktop também aceita arrastar e colar) |
| Foto | abre a câmera nativa para fotografar a referência |
| **Contorno** | converte a foto em line art (ver abaixo) |
| **Travar** | congela a transformação — ative antes de desenhar |
| Limiar | sensibilidade das bordas; só aparece com o contorno ligado |
| Opacidade | 5% a 100%, vale para a foto e para o contorno |
| Ajustar | recentraliza e enquadra a imagem |
| Espelhar | inverte na horizontal |
| Grade | 3×3 sobre a imagem (método da grade) |
| Trocar câmera | traseira ↔ frontal |
| Olho | esconde a interface; o ponto no canto traz de volta |

Um dedo move · dois dedos dão zoom e giram · roda do mouse dá zoom no desktop.

## Rodando

```bash
npm install
```

```bash
npm run dev
```

Abre em `https://localhost:5173` e também no IP da sua rede local. **O HTTPS não é opcional:** `getUserMedia()` exige contexto seguro, e `http://192.168.x.x` não conta — só `https://` ou `localhost`. Por isso o `vite.config.js` carrega o `basic-ssl`, que gera um certificado autoassinado; o celular vai mostrar um aviso de segurança na primeira vez, é só prosseguir.

Sem Node instalado, qualquer host estático serve — é só subir a pasta inteira. Netlify Drop, GitHub Pages, Cloudflare Pages: todos já entregam HTTPS, o que resolve o problema de vez e ainda permite instalar como app.

## Deploy

Automático: todo push em `master` dispara `.github/workflows/deploy.yml`, que publica em https://mardoniosc.github.io/DrawCam/. Em *Settings → Pages*, a origem precisa estar em **GitHub Actions** (não em "Deploy from a branch").

O workflow monta o site com `git archive HEAD` — publica exatamente o que está commitado, sem lista de exclusões para envelhecer.

### Por que o cache é carimbado no deploy

O service worker é cache-first: na segunda visita ele serve tudo do cache e ignora a rede. É o que faz o app abrir offline e instantâneo — e também o que faria você dar push numa correção e não ver mudança nenhuma no celular.

O navegador só busca arquivos novos quando o **nome do cache** muda. Por isso o `sw.js` guarda um placeholder:

```javascript
const CACHE = 'tracar-__BUILD_ID__';
```

e o workflow troca `__BUILD_ID__` pelo hash curto do commit **na cópia publicada**, nunca no arquivo do repositório. Cada commit vira um cache novo; o `activate` apaga os antigos, e `skipWaiting` + `clients.claim` fazem a versão nova assumir sem recarregar a página.

O passo de carimbo falha de propósito se o placeholder não estiver mais lá. Sem essa guarda, alguém editando o `sw.js` poderia congelar o cache de todo mundo em silêncio — o pior tipo de bug, porque só aparece nos dispositivos dos outros.

Localmente o nome fica `tracar-__BUILD_ID__` mesmo, constante. Enquanto estiver iterando, marque *DevTools → Application → Update on reload*.

## Limitações conhecidas

- **iOS:** só Safari expõe a câmera de forma confiável; navegadores dentro de outros apps (Instagram, WhatsApp) costumam bloquear. O `playsinline` no `<video>` é obrigatório — sem ele o iOS abre o player em tela cheia.
- **Wake Lock:** Safari 16.4+. Em versões anteriores a tela apaga normalmente.
- **Ícones:** o manifesto usa SVG, aceito pelo Chrome. Alguns Androids antigos querem PNG 192px e 512px — se precisar, exporte o `icon.svg` e adicione ao manifesto.
- O service worker cacheia só o app; imagens carregadas ficam em memória (`blob:`) e somem ao fechar.

## Line art

Grayscale → Sobel → threshold, num fragment shader WebGL. É o que transforma uma foto fantasma em contorno desenhável.

```glsl
float gx = -tl - 2.0*ml - bl + tr + 2.0*mr + br;
float gy =  tl + 2.0*tc + tr - bl - 2.0*bc - br;
float a  = smoothstep(u_threshold, u_threshold + u_softness, length(vec2(gx, gy)));
gl_FragColor = vec4(0.0, 0.0, 0.0, a);
```

**Saída com alfa, não preto-sobre-branco.** O fundo sai transparente e só os traços são opacos, então a câmera aparece entre as linhas. Fundo branco cobriria o papel e derrotaria o propósito.

**Custo zero por frame.** O shader roda uma vez quando a imagem ou o limiar mudam, escrevendo num `<canvas>` dentro do mesmo `#obj`. Depois disso é bitmap estático sob o mesmo `transform` — pan e zoom continuam sendo só composição na GPU.

**`smoothstep` em vez de corte duro** dá a borda anti-serrilhada do traço.

**O Sobel já traz o [1 2 1] embutido**, que é uma suavização — por isso não precisa de blur antes, e o ruído da foto não vira chuvisco.

**Imagem maior que `MAX_TEXTURE_SIZE`** (limitado a 4096) é reduzida num canvas 2D antes do upload, senão o `texImage2D` falha. O CSS estica o canvas de volta ao tamanho natural, então o alinhamento com a imagem original não muda.

**Contexto WebGL perdido** — comum no celular ao trocar de app — é reconstruído no evento `webglcontextrestored`.

### Verificação

Testado com uma imagem sintética contendo uma borda dura e uma rampa de inclinação conhecida (0,05/px, que pela fórmula do Sobel dá `g = 8s = 0,4`):

| | limiar mínimo (0,05) | limiar máximo (1,25) |
|---|---|---|
| borda dura (`g ≈ 4`) | alfa 255 | alfa 255 |
| rampa suave (`g ≈ 0,4`) | alfa 255 | alfa 0 |
| áreas planas | alfa 0 | alfa 0 |

Áreas de cor chapada não geram traço nenhum, e o limiar de fato separa borda forte de borda fraca. Imagem de 5000×2000 reduz para 4096×1638 mantendo proporção e continuando a detectar a borda.

## Próximo passo natural

Espessura do traço (dilatação num segundo passe) e inversão para papel escuro.
