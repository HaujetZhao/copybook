<script setup>
import { ref, watch, watchEffect } from 'vue';

const themes = [
  { name: '暗夜', vars: { '--bg': '#1e1f24', '--canvas': '#26272c', '--text': '#e6e4e0', '--muted': '#8b8d94', '--accent': '#aeb9ff', '--border': '#33353c' } },
  { name: '宣纸', vars: { '--bg': '#e9e2d5', '--canvas': '#f5f0e6', '--text': '#3a332a', '--muted': '#9a8f7d', '--accent': '#b08347', '--border': '#d8cfbc' } },
  { name: '黛蓝', vars: { '--bg': '#171a21', '--canvas': '#1e222c', '--text': '#dfe3ec', '--muted': '#828a9b', '--accent': '#9db4f0', '--border': '#282c37' } },
];

// 持久化:主题/字号/可编辑状态存 localStorage,刷新后恢复
const saved = JSON.parse(localStorage.getItem('jxp') || '{}');
const editable = ref(saved.editable ?? true);
const size = ref(saved.size ?? 64);
const laserMode = ref(saved.laserMode ?? 'dot'); // 'dot' 点跟随 | 'trail' 荧光笔迹
const theme = ref(themes.find(t => t.name === saved.theme) ?? themes[0]);

// 限制最大宽度后,页面外的 body 露出区域也要跟主题同色
watchEffect(() => {
  document.body.style.background = theme.value.vars['--bg'];
});

// 预览态全页禁选中/禁长按呼出菜单,防止临摹时误选画布外文字
watchEffect(() => {
  document.body.style.userSelect = editable.value ? '' : 'none';
  document.body.style.webkitUserSelect = editable.value ? '' : 'none';
  document.body.style.webkitTouchCallout = editable.value ? '' : 'none';
});

watch([editable, size, theme], () => {
  localStorage.setItem('jxp', JSON.stringify({
    editable: editable.value, size: size.value, laserMode: laserMode.value, theme: theme.value.name,
  }));
}, { deep: true });

// 激光笔:预览态下,触控笔/鼠标在画布上只留一个跟随光点(不滚动不选中);
// 手指则手动转发滚动(画布 touch-action:none 是为了拦下笔的滚动,手指的滚动在这里补回)
const laser = ref(null); // { x, y } 视口坐标
let lastTouch = null;
function laserMove(e) {
  if (editable.value) return;
  if (e.pointerType === 'touch') {
    laser.value = null;
    if (lastTouch) {
      e.currentTarget.scrollBy(lastTouch.x - e.clientX, lastTouch.y - e.clientY);
    }
    lastTouch = { x: e.clientX, y: e.clientY };
  } else {
    laser.value = { x: e.clientX, y: e.clientY };
  }
}
function laserEnd(e) {
  if (e.pointerType === 'touch') lastTouch = null;
  else laser.value = null;
}

// 荧光笔迹模式:性能方案 —— 抬笔后的旧笔迹「烘焙」进离屏画布,
// 每帧只需 drawImage(烘焙层) + 重绘当前这一笔,成本恒定不随笔迹总量增长。
// 纯红色笔迹,线宽随笔压力变化。
const trailFading = ref(false);
let fadeTimer = null;
let drawing = false;
const canvasEl = ref(null);
const trailEl = ref(null); // 显示用 canvas
let ctx = null;
let baked = null; // 离屏画布,存已抬笔的笔迹
let cur = []; // 当前正在画的笔画 [{x,y,p}] 内容坐标
let rafId = null;

function contentPoint(e) {
  const r = canvasEl.value.getBoundingClientRect();
  return { x: e.clientX - r.left + canvasEl.value.scrollLeft, y: e.clientY - r.top + canvasEl.value.scrollTop, p: e.pressure || 0.5 };
}
// canvas 尺寸跟随滚动区域(含 devicePixelRatio,保证光晕不糊)
function fitTrail() {
  const c = trailEl.value, host = canvasEl.value;
  if (!c || !host) return;
  const dpr = window.devicePixelRatio || 1;
  const w = host.scrollWidth * dpr, h = host.scrollHeight * dpr;
  if (c.width === w && c.height === h) return;
  // 扩容时把烘焙层内容搬到新尺寸
  const old = baked;
  c.width = w; c.height = h;
  c.style.width = host.scrollWidth + 'px';
  c.style.height = host.scrollHeight + 'px';
  ctx = c.getContext('2d');
  baked = document.createElement('canvas');
  baked.width = w; baked.height = h;
  if (old) baked.getContext('2d').drawImage(old, 0, 0);
  renderTrail();
}
// 每点带压力 p(笔 0~1,鼠标恒 0.5),线宽随压力变化
function widthOf(pt) {
  const dpr = window.devicePixelRatio || 1;
  return (2 + 3 * (pt.p ?? 0.5)) * dpr;
}
// 画一段纯红笔迹,线宽随压力
function strokeSegment(c2d, a, b, dpr) {
  const w = Math.max(widthOf(a), widthOf(b));
  c2d.beginPath();
  c2d.moveTo(a.x * dpr, a.y * dpr);
  if (b) c2d.lineTo(b.x * dpr, b.y * dpr);
  else c2d.lineTo(a.x * dpr + 0.01, a.y * dpr);
  c2d.lineCap = 'round';
  c2d.strokeStyle = '#ff3b30';
  c2d.lineWidth = w;
  c2d.stroke();
}
// 每帧:烘焙层贴回来 + 当前笔画整条重画(清了再画,无叠加色差)
function renderTrail() {
  const c = trailEl.value;
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, c.width, c.height);
  if (baked) ctx.drawImage(baked, 0, 0);
  for (let i = 0; i + 1 < cur.length; i++) strokeSegment(ctx, cur[i], cur[i + 1], dpr);
  if (cur.length === 1) strokeSegment(ctx, cur[0], null, dpr);
  // (纯红笔迹无 shadow)
}
function requestRender() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = null;
    renderTrail();
  });
}
function trailDown(e) {
  clearTimeout(fadeTimer);
  drawing = true;
  if (trailFading.value) {
    trailFading.value = false;
    const b = baked && baked.getContext('2d');
    b && b.clearRect(0, 0, baked.width, baked.height);
    cur = [];
  }
  fitTrail();
  cur = [contentPoint(e)];
  requestRender();
}
function trailMove(e) {
  const p = contentPoint(e), last = cur.at(-1);
  // 太密的点跳过,减绘计量也减轻慢画时的光晕叠色
  if (Math.hypot(p.x - last.x, p.y - last.y) < 1.5) return;
  cur.push(p);
  requestRender();
}
function trailUp() {
  // pointerup 后还会紧跟一个 pointerleave(释放隐式捕获),
  // drawing 标记保证一次抬笔只起一个淡出定时器
  if (!drawing) return;
  drawing = false;
  clearTimeout(fadeTimer);
  // 当前笔画烘焙进离屏层,后续帧不再重画它
  if (baked && cur.length) {
    const b = baked.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    b.lineCap = 'round';
    for (let i = 0; i + 1 < cur.length; i++) strokeSegment(b, cur[i], cur[i + 1], dpr);
    if (cur.length === 1) strokeSegment(b, cur[0], null, dpr);
  }
  cur = [];
  requestRender();
  fadeTimer = setTimeout(() => {
    trailFading.value = true; // CSS 0.8s 淡出,结束后清空
    setTimeout(() => {
      trailFading.value = false;
      const b = baked && baked.getContext('2d');
      b && b.clearRect(0, 0, baked.width, baked.height);
      ctx && renderTrail();
    }, 800);
  }, 1000);
}

// 统一分发:预览态下笔/鼠标 → 按模式处理;手指 → 转发滚动
function onPointerDown(e) {
  if (editable.value || e.pointerType === 'touch') { laserMove(e); return; }
  if (laserMode.value === 'trail') trailDown(e);
  else laserMove(e);
}
function onPointerMove(e) {
  if (editable.value || e.pointerType === 'touch') { laserMove(e); return; }
  if (laserMode.value === 'trail') { if (e.buttons) trailMove(e); }
  else laserMove(e);
}
function onPointerUp(e) {
  laserEnd(e);
  if (!editable.value && e.pointerType !== 'touch' && laserMode.value === 'trail') trailUp();
}
</script>

<template>
  <div class="page" :style="theme.vars">
    <div class="toolbar">
      <label class="size">
        <input type="range" v-model.number="size" min="16" max="200" />
        <span>{{ size }}px</span>
      </label>
      <div class="seg">
        <button
          v-for="t in themes" :key="t.name"
          :class="{ active: t === theme }"
          @click="theme = t"
        >{{ t.name }}</button>
      </div>
      <div v-if="!editable" class="seg">
        <button :class="{ active: laserMode === 'dot' }" @click="laserMode = 'dot'">光点</button>
        <button :class="{ active: laserMode === 'trail' }" @click="laserMode = 'trail'">笔迹</button>
      </div>
      <button
        class="toggle"
        :class="{ on: editable }"
        @click="editable = !editable"
      >{{ editable ? '可编辑' : '仅预览' }}</button>
    </div>
    <div
      ref="canvasEl"
      class="canvas"
      :class="{ laser: !editable }"
      :contenteditable="editable"
      :style="{ fontSize: size + 'px' }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @pointerleave="onPointerUp"
    >
      荆霄鹏行楷
      <canvas v-if="laserMode === 'trail' && !editable" ref="trailEl" class="trail" :class="{ fading: trailFading }"></canvas>
    </div>
    <!-- 激光点放 body 层级,fixed 定位避免被画布滚动影响 -->
    <Teleport to="body">
      <div v-if="laser" class="laser-dot" :style="{ left: laser.x + 'px', top: laser.y + 'px' }"></div>
    </Teleport>
  </div>
</template>

<style scoped>
.page {
  height: 100%;
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  padding: 12px 16px 16px;
  gap: 12px;
  box-sizing: border-box;
  background: var(--bg);
  color: var(--text);
  transition: background 0.2s, color 0.2s;
}
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.size {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 160px;
  max-width: 320px;
  color: var(--muted);
  font-size: 13px;
}
.size input[type='range'] { flex: 1; accent-color: var(--accent); }
.size span { min-width: 44px; text-align: right; font-variant-numeric: tabular-nums; }

.seg {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 999px;
  overflow: hidden;
}
.seg button {
  border: none;
  padding: 6px 14px;
  font-size: 13px;
  color: var(--muted);
  background: transparent;
  cursor: pointer;
  transition: all 0.15s;
}
.seg button + button { border-left: 1px solid var(--border); }
.seg button.active {
  color: var(--bg);
  background: var(--accent);
}

.toggle {
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 6px 16px;
  font-size: 13px;
  color: var(--muted);
  background: var(--canvas);
  cursor: pointer;
  transition: all 0.15s;
}
.toggle.on {
  color: var(--bg);
  background: var(--accent);
  border-color: var(--accent);
}

.canvas {
  flex: 1;
  overflow: auto;
  padding: 24px;
  font-family: '荆霄鹏行楷', KaiTi, serif;
  background: var(--canvas);
  border: 1px solid transparent;
  border-radius: 12px;
  line-height: 1.5;
  word-break: break-all;
  outline: none;
  caret-color: var(--accent);
  transition: background 0.2s;
}
.canvas[contenteditable='true'] { border-color: var(--border); }
.canvas[contenteditable='true']:focus { border-color: var(--accent); }

/* 激光笔模式:画布吃掉所有触控,不滚动不选中 */
.canvas.laser {
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  cursor: none;
}
/* 荧光笔迹层:绝对定位于滚动内容原点,随内容一起滚动 */
.canvas { position: relative; }
.trail {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  transition: opacity 0.8s;
}
.trail.fading { opacity: 0; }
.laser-dot {
  position: fixed;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 8px 3px #ff3b30cc, 0 0 18px 6px #ff3b3066;
  transform: translate(-50%, -50%);
  pointer-events: none;
  z-index: 9999;
}
</style>
